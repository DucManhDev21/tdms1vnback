'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const crypto = require('crypto');
const admin = require('firebase-admin');

const PORT = Number(process.env.PORT || 8080);
const PROVIDER_URL = String(process.env.PROVIDER_URL || 'https://api.provider-smm.com/v2').replace(/\/$/, '');
const PROVIDER_API_KEY = process.env.PROVIDER_API_KEY || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || '';
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';
const FRONTEND_ORIGINS = String(process.env.FRONTEND_ORIGINS || '*')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);
const PAYMENT_INSTRUCTIONS = process.env.PAYMENT_INSTRUCTIONS || 'Thông tin nạp tiền chưa được cấu hình. Vui lòng liên hệ quản trị viên.';
const PAYMENT_QR_URL = process.env.PAYMENT_QR_URL || '';
const MIN_DEPOSIT = Number(process.env.MIN_DEPOSIT || 10000);
const MAX_DEPOSIT = Number(process.env.MAX_DEPOSIT || 500000000);
const ORPHAN_AFTER_MS = 5 * 60 * 1000;
const DEFAULT_STATUS_BATCH_SIZE = 30;
const serviceCache = {
  data: null,
  expiresAt: 0
};

function requireEnv(name, value) {
  if (!value) {
    throw new Error(`Thiếu biến môi trường bắt buộc: ${name}`);
  }
}

requireEnv('PROVIDER_API_KEY', PROVIDER_API_KEY);

function initFirebase() {
  if (admin.apps.length) return admin.app();

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const serviceAccount = JSON.parse(raw);
    return admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  }

  if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    const privateKey = String(process.env.FIREBASE_PRIVATE_KEY).replace(/\\n/g, '\n');
    return admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey
      })
    });
  }

  return admin.initializeApp();
}

initFirebase();

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

function nowTimestamp() {
  return FieldValue.serverTimestamp();
}

function normalizeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeInteger(value, fallback = 0) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') return value;
  const text = String(value ?? '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'bh', 'refill', 'bảo hành', 'bao hanh'].includes(text);
}

function inferPlatform(text) {
  const value = String(text || '').toLowerCase();
  if (/facebook|fb\b|profile facebook|fanpage/.test(value)) return 'Facebook';
  if (/tiktok|tik tok/.test(value)) return 'Tiktok';
  if (/instagram|insta\b/.test(value)) return 'Instagram';
  if (/youtube|yt\b/.test(value)) return 'Youtube';
  if (/telegram|tele\b/.test(value)) return 'Telegram';
  if (/twitter|twitter\/x|\bx\b|x\.com/.test(value)) return 'Twitter/X';
  if (/shopee/.test(value)) return 'Shopee';
  return 'Other';
}

function inferType(item) {
  const value = `${item.type || ''} ${item.name || ''}`.toLowerCase();
  if (/custom\s*comments|comment tùy chỉnh|comment tuỳ chỉnh|comments custom/.test(value)) return 'Custom Comments';
  if (/package|gói|combo/.test(value)) return 'Package';
  if (/subscription|sub/.test(value)) return 'Subscription';
  return 'Default';
}

function inferCategory(item) {
  const explicit = String(item.category || item.cate || item.category_name || '').trim();
  if (explicit) return explicit;
  const text = String(item.name || '').trim();
  const platform = inferPlatform(text);
  const lower = text.toLowerCase();
  if (/like|tim|thích/.test(lower)) return `${platform} · Likes`;
  if (/follow|follower|sub|subscriber|người theo dõi/.test(lower)) return `${platform} · Followers`;
  if (/view|lượt xem|watch/.test(lower)) return `${platform} · Views`;
  if (/comment|bình luận/.test(lower)) return `${platform} · Comments`;
  if (/share|chia sẻ/.test(lower)) return `${platform} · Shares`;
  return `${platform} · Khác`;
}

function hasKeyword(value, keywords) {
  const text = String(value || '').toLowerCase();
  return keywords.some((keyword) => text.includes(keyword.toLowerCase()));
}

function normalizeService(item) {
  const text = `${item.name || ''} ${item.description || ''}`;
  return {
    service: String(item.service ?? item.id ?? ''),
    name: String(item.name ?? ''),
    type: inferType(item),
    platform: inferPlatform(`${item.platform || ''} ${item.name || ''} ${item.category || ''}`),
    category: inferCategory(item),
    rate: Number(normalizeNumber(item.rate, 0).toFixed(8)),
    min: normalizeInteger(item.min, 0),
    max: normalizeInteger(item.max, 0),
    refill: hasKeyword(text, ['BH', 'Refill', 'Bảo hành', 'Bao hanh']),
    cancel: hasKeyword(text, ['Hủy', 'Huy', 'Cancel'])
  };
}

function validateNormalizedService(service) {
  return Boolean(
    service.service &&
    service.name &&
    service.rate >= 0 &&
    service.min >= 0 &&
    service.max >= service.min
  );
}

async function providerRequest(action, payload = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const body = new URLSearchParams();
    body.set('key', PROVIDER_API_KEY);
    body.set('action', action);
    Object.entries(payload).forEach(([key, value]) => {
      if (value !== undefined && value !== null) body.set(key, String(value));
    });

    const response = await fetch(PROVIDER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'Accept': 'application/json'
      },
      body,
      signal: controller.signal
    });

    const raw = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Provider trả về dữ liệu không phải JSON: HTTP ${response.status}`);
    }

    if (!response.ok) {
      throw new Error(`Provider HTTP ${response.status}: ${JSON.stringify(parsed)}`);
    }

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (parsed.error) throw new Error(`Provider error: ${parsed.error}`);
      if (parsed.message && parsed.success === false) throw new Error(`Provider error: ${parsed.message}`);
    }

    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

function extractServiceArray(providerPayload) {
  if (Array.isArray(providerPayload)) return providerPayload;
  if (Array.isArray(providerPayload?.data)) return providerPayload.data;
  if (Array.isArray(providerPayload?.services)) return providerPayload.services;
  if (Array.isArray(providerPayload?.results)) return providerPayload.results;
  return [];
}

function normalizeProviderStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (status === 'completed' || status === 'complete' || status === 'done') return 'Completed';
  if (status === 'in progress' || status === 'inprogress' || status === 'processing' || status === 'running') return 'In progress';
  if (status === 'canceled' || status === 'cancelled' || status === 'canceled.') return 'Canceled';
  if (status === 'partial') return 'Partial';
  return 'Pending';
}

function extractProviderOrderId(result) {
  if (typeof result === 'string' || typeof result === 'number') return String(result);
  const id = result?.order ?? result?.order_id ?? result?.id ?? result?.data?.order ?? result?.data?.order_id;
  if (id === undefined || id === null || id === '') return null;
  return String(id);
}

function extractProviderStatus(result) {
  if (!result || typeof result !== 'object') return null;
  return result.status ?? result.data?.status ?? null;
}

function extractProviderRemains(result) {
  if (!result || typeof result !== 'object') return null;
  const raw = result.remains ?? result.remain ?? result.data?.remains ?? result.data?.remain;
  if (raw === undefined || raw === null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null;
}

function parseOriginAllowed(origin) {
  if (!origin) return true;
  if (FRONTEND_ORIGINS.includes('*')) return true;
  return FRONTEND_ORIGINS.includes(origin);
}

async function verifyToken(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return res.status(401).json({ error: 'Thiếu Bearer Token.' });
    }
    const decoded = await admin.auth().verifyIdToken(match[1], true);
    req.user = decoded;
    return next();
  } catch (error) {
    console.error('verifyToken error:', error.message);
    return res.status(401).json({ error: 'Token không hợp lệ hoặc đã hết hạn.' });
  }
}

async function ensureUserProfile(uid, email, profile = {}) {
  const ref = db.collection('users').doc(uid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      tx.set(ref, {
        uid,
        email: email || '',
        balance: 0,
        role: 'user',
        displayName: String(profile.displayName || '').slice(0, 160),
        photoURL: String(profile.photoURL || '').slice(0, 1000),
        createdAt: nowTimestamp()
      });
    }
  });
}

async function refundOrder(orderId, reason) {
  const orderRef = db.collection('orders').doc(orderId);
  await db.runTransaction(async (tx) => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) return;
    const order = orderSnap.data();
    if (!order.uid || !['Canceled', 'Partial'].includes(order.status)) return;

    const quantity = Math.max(0, Number(order.quantity || 0));
    const remains = Math.max(0, Number(order.remains ?? 0));
    const unitPrice = quantity > 0 ? Number(order.totalPrice || 0) / quantity : 0;
    const desiredRefund = Math.max(0, unitPrice * remains);
    const alreadyRefunded = Math.max(0, Number(order.refundedAmount || 0));
    const refundAmount = Math.max(0, desiredRefund - alreadyRefunded);
    if (refundAmount <= 0) return;

    const userRef = db.collection('users').doc(order.uid);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error(`Không tìm thấy user ${order.uid}`);
    const user = userSnap.data();
    const oldBalance = Number(user.balance || 0);
    const newBalance = oldBalance + refundAmount;

    tx.update(userRef, { balance: newBalance });
    tx.update(orderRef, {
      refundedAmount: alreadyRefunded + refundAmount,
      updatedAt: nowTimestamp()
    });
    const logRef = db.collection('balance_logs').doc();
    tx.set(logRef, {
      uid: order.uid,
      amount: refundAmount,
      type: 'refund',
      reason,
      oldBalance,
      newBalance,
      createdAt: nowTimestamp(),
      orderId
    });
  });
}

async function refundOrphanOrder(orderId) {
  const orderRef = db.collection('orders').doc(orderId);
  await db.runTransaction(async (tx) => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) return;
    const order = orderSnap.data();
    if (order.providerOrderId || order.status === 'Canceled') return;

    const createdAt = order.createdAt?.toDate?.() || new Date(0);
    if (Date.now() - createdAt.getTime() < ORPHAN_AFTER_MS) return;

    const userRef = db.collection('users').doc(order.uid);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error(`Không tìm thấy user ${order.uid}`);
    const user = userSnap.data();
    const oldBalance = Number(user.balance || 0);
    const refundAmount = Number(order.totalPrice || 0);
    const newBalance = oldBalance + refundAmount;

    tx.update(userRef, { balance: newBalance });
    tx.update(orderRef, {
      status: 'Canceled',
      remains: Number(order.remains ?? order.quantity ?? 0),
      refundedAmount: refundAmount,
      updatedAt: nowTimestamp(),
      cancelReason: 'Orphan refund: providerOrderId chưa được gắn sau 5 phút.'
    });
    const logRef = db.collection('balance_logs').doc();
    tx.set(logRef, {
      uid: order.uid,
      amount: refundAmount,
      type: 'refund',
      reason: 'Orphan refund sau 5 phút không có providerOrderId',
      oldBalance,
      newBalance,
      createdAt: nowTimestamp(),
      orderId
    });
  });
}

async function notifyTelegram(text, buttons = null) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_ADMIN_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const payload = {
    chat_id: TELEGRAM_ADMIN_CHAT_ID,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (buttons) {
    payload.reply_markup = {
      inline_keyboard: buttons
    };
  }
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) console.error('Telegram notify HTTP error:', response.status, await response.text());
  } catch (error) {
    console.error('Telegram notify error:', error.message);
  }
}

async function answerTelegramCallback(callbackQueryId, text, showAlert = false) {
  if (!TELEGRAM_BOT_TOKEN || !callbackQueryId) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: showAlert })
    });
  } catch (error) {
    console.error('Telegram callback answer error:', error.message);
  }
}

async function editTelegramMessage(chatId, messageId, text) {
  if (!TELEGRAM_BOT_TOKEN) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' })
    });
  } catch (error) {
    console.error('Telegram edit error:', error.message);
  }
}

async function processDepositDecision(depositId, decision, callbackQuery) {
  const ref = db.collection('deposits').doc(depositId);
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('Không tìm thấy yêu cầu nạp tiền.');
    const deposit = snap.data();
    if (deposit.status !== 'Pending') {
      return { status: deposit.status, amount: Number(deposit.amount || 0), uid: deposit.uid, alreadyProcessed: true };
    }

    if (decision === 'reject') {
      tx.update(ref, { status: 'Rejected', reviewedAt: nowTimestamp(), reviewedBy: 'telegram-admin' });
      return { status: 'Rejected', amount: Number(deposit.amount || 0), uid: deposit.uid };
    }

    const amount = Number(deposit.amount || 0);
    const userRef = db.collection('users').doc(deposit.uid);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error('Không tìm thấy tài khoản người dùng.');
    const user = userSnap.data();
    const oldBalance = Number(user.balance || 0);
    const newBalance = oldBalance + amount;
    tx.update(userRef, { balance: newBalance });
    tx.update(ref, { status: 'Completed', reviewedAt: nowTimestamp(), reviewedBy: 'telegram-admin' });
    const logRef = db.collection('balance_logs').doc();
    tx.set(logRef, {
      uid: deposit.uid,
      amount,
      type: 'deposit',
      reason: `Duyệt nạp tiền ${depositId}`,
      oldBalance,
      newBalance,
      createdAt: nowTimestamp(),
      depositId
    });
    return { status: 'Completed', amount, uid: deposit.uid, oldBalance, newBalance };
  });

  if (callbackQuery) {
    const actorChatId = String(callbackQuery.message?.chat?.id || '');
    const messageId = callbackQuery.message?.message_id;
    const label = result.alreadyProcessed ? `Yêu cầu đã xử lý: ${result.status}` : result.status === 'Completed' ? `Đã duyệt ${result.amount.toLocaleString('vi-VN')} đ` : 'Đã từ chối yêu cầu nạp tiền';
    await answerTelegramCallback(callbackQuery.id, label, false);
    if (messageId) {
      const originalText = callbackQuery.message?.text || '';
      await editTelegramMessage(actorChatId, messageId, `${originalText}\n\n<b>KẾT QUẢ:</b> ${label}`);
    }
  }
  return result;
}

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({
  origin(origin, callback) {
    if (parseOriginAllowed(origin)) return callback(null, true);
    return callback(new Error('Origin không được phép.'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Telegram-Bot-Api-Secret-Token']
}));
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', async (req, res) => {
  res.json({ ok: true, service: 'TDMS1VN Backend', time: new Date().toISOString() });
});

app.get('/api/config/public', verifyToken, async (req, res) => {
  res.json({
    minDeposit: MIN_DEPOSIT,
    maxDeposit: MAX_DEPOSIT,
    paymentInstructions: PAYMENT_INSTRUCTIONS,
    paymentQrUrl: PAYMENT_QR_URL
  });
});

app.post('/api/auth/profile', verifyToken, async (req, res) => {
  try {
    await ensureUserProfile(req.user.uid, req.user.email || '', {
      displayName: req.body?.displayName || req.user.name || '',
      photoURL: req.body?.photoURL || req.user.picture || ''
    });
    const snap = await db.collection('users').doc(req.user.uid).get();
    res.json({ ok: true, user: snap.data() });
  } catch (error) {
    console.error('/api/auth/profile:', error);
    res.status(500).json({ error: 'Không thể khởi tạo hồ sơ.' });
  }
});

app.get('/api/services', verifyToken, async (req, res) => {
  try {
    const now = Date.now();
    if (serviceCache.data && serviceCache.expiresAt > now) {
      return res.json({ services: serviceCache.data, cached: true });
    }
    const providerPayload = await providerRequest('services');
    const raw = extractServiceArray(providerPayload);
    const normalized = raw.map(normalizeService).filter(validateNormalizedService);
    const unique = [];
    const ids = new Set();
    for (const item of normalized) {
      if (ids.has(item.service)) continue;
      ids.add(item.service);
      unique.push(item);
    }
    serviceCache.data = unique;
    serviceCache.expiresAt = now + 30 * 1000;
    return res.json({ services: unique, cached: false });
  } catch (error) {
    console.error('/api/services:', error);
    return res.status(502).json({ error: `Không thể lấy dịch vụ từ Provider: ${error.message}` });
  }
});

app.post('/api/orders', verifyToken, async (req, res) => {
  try {
    const serviceId = String(req.body?.serviceId || '').trim();
    const serviceName = String(req.body?.serviceName || '').trim();
    const link = String(req.body?.link || '').trim();
    const links = Array.isArray(req.body?.links) ? req.body.links.map((v) => String(v).trim()).filter(Boolean) : [];
    const quantity = normalizeInteger(req.body?.quantity, 0);
    const rate = normalizeNumber(req.body?.rate, 0);
    const min = normalizeInteger(req.body?.min, 0);
    const max = normalizeInteger(req.body?.max, 0);

    const finalLinks = links.length > 0 ? links : (link ? [link] : []);
    if (!serviceId || !serviceName || finalLinks.length === 0) {
      return res.status(400).json({ error: 'Thiếu serviceId, serviceName hoặc link.' });
    }
    if (!Number.isFinite(rate) || rate < 0) {
      return res.status(400).json({ error: 'Đơn giá không hợp lệ.' });
    }
    if (!Number.isInteger(quantity) || quantity < min || quantity > max) {
      return res.status(400).json({ error: `Số lượng phải nằm trong khoảng ${min.toLocaleString()} - ${max.toLocaleString()}.` });
    }
    if (finalLinks.length > 100) return res.status(400).json({ error: 'Tối đa 100 link cho một lần gửi.' });
    if (finalLinks.some((item) => item.length > 2000)) return res.status(400).json({ error: 'Link vượt quá 2000 ký tự.' });

    const perOrderPrice = Number(((rate * quantity) / 1000).toFixed(8));
    const totalPrice = Number((perOrderPrice * finalLinks.length).toFixed(8));
    if (!Number.isFinite(perOrderPrice) || !Number.isFinite(totalPrice) || totalPrice < 0) {
      return res.status(400).json({ error: 'Không thể tính tổng tiền.' });
    }

    const batchOrders = finalLinks.map((itemLink) => ({
      link: itemLink,
      totalPrice: perOrderPrice,
      quantity
    }));

    const createdOrders = await db.runTransaction(async (tx) => {
      const userRef = db.collection('users').doc(req.user.uid);
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) throw new Error('PROFILE_NOT_FOUND');
      const user = userSnap.data();
      const oldBalance = Number(user.balance || 0);
      if (oldBalance < totalPrice) throw new Error('INSUFFICIENT_BALANCE');
      const newBalance = oldBalance - totalPrice;

      tx.update(userRef, { balance: newBalance });
      const orderDocs = batchOrders.map(() => db.collection('orders').doc());
      orderDocs.forEach((orderRef, index) => {
        const item = batchOrders[index];
        tx.set(orderRef, {
          uid: req.user.uid,
          serviceId,
          serviceName,
          link: item.link,
          quantity: item.quantity,
          totalPrice: item.totalPrice,
          providerOrderId: null,
          status: 'Pending',
          remains: item.quantity,
          refundedAmount: 0,
          createdAt: nowTimestamp(),
          updatedAt: nowTimestamp()
        });
      });
      const logRef = db.collection('balance_logs').doc();
      tx.set(logRef, {
        uid: req.user.uid,
        amount: totalPrice,
        type: 'deduct',
        reason: `Đặt ${orderDocs.length} đơn dịch vụ ${serviceId}`,
        oldBalance,
        newBalance,
        createdAt: nowTimestamp(),
        orderIds: orderDocs.map((ref) => ref.id)
      });
      return orderDocs.map((ref, index) => ({ id: ref.id, ...batchOrders[index] }));
    });

    const providerResults = [];
    for (const order of createdOrders) {
      try {
        const providerResult = await providerRequest('add', {
          service: serviceId,
          link: order.link,
          quantity: order.quantity
        });
        const providerOrderId = extractProviderOrderId(providerResult);
        if (!providerOrderId) throw new Error('Provider không trả về order ID.');

        await db.collection('orders').doc(order.id).update({
          providerOrderId,
          updatedAt: nowTimestamp()
        });
        providerResults.push({ id: order.id, providerOrderId, ok: true });

        await notifyTelegram(
          `🟢 <b>ĐƠN MỚI</b>\n` +
          `User: <code>${req.user.uid}</code>\n` +
          `Order: <code>${order.id}</code>\n` +
          `Provider: <code>${providerOrderId}</code>\n` +
          `Service: <b>${serviceId} - ${serviceName}</b>\n` +
          `Quantity: <b>${order.quantity.toLocaleString()}</b>\n` +
          `Link: ${order.link}`
        );
      } catch (providerError) {
        console.error(`Provider add failed for ${order.id}:`, providerError.message);
        await db.collection('orders').doc(order.id).update({
          status: 'Canceled',
          remains: order.quantity,
          updatedAt: nowTimestamp(),
          cancelReason: providerError.message
        });
        await refundOrder(order.id, `Fallback refund do Provider add thất bại: ${providerError.message}`);
        providerResults.push({ id: order.id, providerOrderId: null, ok: false, error: providerError.message });
      }
    }

    const succeeded = providerResults.filter((item) => item.ok).length;
    const failed = providerResults.length - succeeded;
    return res.status(201).json({
      ok: true,
      message: failed === 0 ? 'Đặt đơn thành công.' : 'Đã xử lý đơn; một số đơn lỗi đã được hoàn tiền tự động.',
      totalPrice,
      orders: providerResults
    });
  } catch (error) {
    if (error.message === 'PROFILE_NOT_FOUND') return res.status(400).json({ error: 'Hồ sơ chưa tồn tại. Vui lòng đăng nhập lại.' });
    if (error.message === 'INSUFFICIENT_BALANCE') return res.status(400).json({ error: 'Số dư không đủ để đặt đơn.' });
    console.error('/api/orders:', error);
    return res.status(500).json({ error: `Không thể tạo đơn: ${error.message}` });
  }
});

app.get('/api/deposits', verifyToken, async (req, res) => {
  try {
    const snap = await db.collection('deposits')
      .where('uid', '==', req.user.uid)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();
    const deposits = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json({ deposits });
  } catch (error) {
    console.error('/api/deposits:', error);
    res.status(500).json({ error: 'Không thể tải lịch sử nạp tiền.' });
  }
});

app.post('/api/deposits', verifyToken, async (req, res) => {
  try {
    const amount = Number(req.body?.amount);
    const paymentReference = String(req.body?.paymentReference || '').trim().slice(0, 120);
    const note = String(req.body?.note || '').trim().slice(0, 500);
    if (!Number.isFinite(amount) || amount < MIN_DEPOSIT || amount > MAX_DEPOSIT) {
      return res.status(400).json({ error: `Số tiền phải từ ${MIN_DEPOSIT.toLocaleString('vi-VN')} đến ${MAX_DEPOSIT.toLocaleString('vi-VN')} đ.` });
    }

    const ref = db.collection('deposits').doc();
    await ref.set({
      uid: req.user.uid,
      amount: Number(amount.toFixed(2)),
      status: 'Pending',
      paymentReference,
      note,
      createdAt: nowTimestamp()
    });

    await notifyTelegram(
      `💰 <b>YÊU CẦU NẠP TIỀN</b>\n` +
      `Deposit: <code>${ref.id}</code>\n` +
      `User: <code>${req.user.uid}</code>\n` +
      `Email: ${req.user.email || 'N/A'}\n` +
      `Số tiền: <b>${amount.toLocaleString('vi-VN')} đ</b>\n` +
      `Mã giao dịch: <code>${paymentReference || 'N/A'}</code>\n` +
      `Ghi chú: ${note || 'N/A'}`,
      [[
        { text: '✅ Duyệt', callback_data: `deposit:approve:${ref.id}` },
        { text: '❌ Từ chối', callback_data: `deposit:reject:${ref.id}` }
      ]]
    );

    res.status(201).json({
      ok: true,
      deposit: {
        id: ref.id,
        uid: req.user.uid,
        amount,
        status: 'Pending'
      }
    });
  } catch (error) {
    console.error('/api/deposits POST:', error);
    res.status(500).json({ error: 'Không thể tạo yêu cầu nạp tiền.' });
  }
});

app.get('/api/orders', verifyToken, async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 100);
    const snap = await db.collection('orders')
      .where('uid', '==', req.user.uid)
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();
    const orders = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json({ orders });
  } catch (error) {
    console.error('/api/orders GET:', error);
    res.status(500).json({ error: 'Không thể tải lịch sử đơn hàng.' });
  }
});

async function syncOrders() {
  const candidates = await db.collection('orders')
    .where('status', 'in', ['Pending', 'In progress'])
    .limit(500)
    .get();

  const summary = { scanned: candidates.size, orphanRefunded: 0, updated: 0, refunded: 0, providerErrors: 0 };
  const statusGroups = new Map();

  for (const doc of candidates.docs) {
    const order = doc.data();
    if (!order.providerOrderId) {
      try {
        const before = order.status;
        await refundOrphanOrder(doc.id);
        const fresh = await doc.ref.get();
        if (fresh.exists && fresh.data().status === 'Canceled' && before !== 'Canceled') summary.orphanRefunded += 1;
      } catch (error) {
        console.error('orphan refund:', doc.id, error.message);
      }
      continue;
    }
    const key = String(order.providerOrderId);
    if (!statusGroups.has(key)) statusGroups.set(key, []);
    statusGroups.get(key).push({ ref: doc.ref, id: doc.id, order });
  }

  const providerIds = Array.from(statusGroups.keys());
  for (let i = 0; i < providerIds.length; i += DEFAULT_STATUS_BATCH_SIZE) {
    const chunk = providerIds.slice(i, i + DEFAULT_STATUS_BATCH_SIZE);
    try {
      const result = await providerRequest('status', { orders: chunk.join(',') });
      for (const providerId of chunk) {
        const entries = statusGroups.get(providerId) || [];
        let providerRecord = null;
        if (result && typeof result === 'object' && !Array.isArray(result)) {
          providerRecord = result[providerId] || result.data?.[providerId] || null;
        }
        if (!providerRecord && chunk.length === 1) providerRecord = result;
        if (!providerRecord) continue;

        const newStatus = normalizeProviderStatus(extractProviderStatus(providerRecord));
        const remains = extractProviderRemains(providerRecord);
        for (const item of entries) {
          const update = { status: newStatus, updatedAt: nowTimestamp() };
          if (remains !== null) update.remains = remains;
          await item.ref.update(update);
          summary.updated += 1;
          if (['Canceled', 'Partial'].includes(newStatus)) {
            try {
              await refundOrder(item.id, `Hoàn tiền tự động theo trạng thái Provider: ${newStatus}`);
              summary.refunded += 1;
            } catch (error) {
              console.error('refund after status:', item.id, error.message);
            }
          }
        }
      }
    } catch (error) {
      summary.providerErrors += 1;
      console.error('provider status batch error:', error.message);
    }
  }

  return summary;
}

app.get('/api/cron/sync-orders', async (req, res) => {
  try {
    const provided = String(req.headers['x-cron-secret'] || req.query.secret || '');
    const configured = String(process.env.CRON_SECRET || '');
    if (!configured || !provided || Buffer.byteLength(provided) !== Buffer.byteLength(configured) || !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(configured))) {
      return res.status(401).json({ error: 'Cron secret không hợp lệ.' });
    }
    const summary = await syncOrders();
    res.json({ ok: true, summary });
  } catch (error) {
    console.error('/api/cron/sync-orders:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/telegram/webhook', async (req, res) => {
  try {
    const secret = String(req.headers['x-telegram-bot-api-secret-token'] || '');
    if (TELEGRAM_WEBHOOK_SECRET) {
      if (!secret || secret !== TELEGRAM_WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    }

    const update = req.body || {};
    const callbackQuery = update.callback_query;
    if (!callbackQuery) return res.json({ ok: true });

    const chatId = String(callbackQuery.message?.chat?.id || '');
    if (!TELEGRAM_ADMIN_CHAT_ID || chatId !== String(TELEGRAM_ADMIN_CHAT_ID)) {
      await answerTelegramCallback(callbackQuery.id, 'Bạn không có quyền thao tác.', true);
      return res.json({ ok: true });
    }

    const data = String(callbackQuery.data || '');
    const match = data.match(/^deposit:(approve|reject):([A-Za-z0-9_-]+)$/);
    if (!match) {
      await answerTelegramCallback(callbackQuery.id, 'Callback không hợp lệ.', true);
      return res.json({ ok: true });
    }

    const decision = match[1] === 'approve' ? 'approve' : 'reject';
    await processDepositDecision(match[2], decision, callbackQuery);
    return res.json({ ok: true });
  } catch (error) {
    console.error('/api/telegram/webhook:', error);
    if (req.body?.callback_query?.id) {
      await answerTelegramCallback(req.body.callback_query.id, 'Có lỗi khi xử lý.', true);
    }
    return res.status(200).json({ ok: false });
  }
});

app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(`TDMS1VN backend listening on port ${PORT}`);
});
