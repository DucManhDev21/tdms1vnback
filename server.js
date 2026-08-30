'use strict';

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const admin = require('firebase-admin');

const app = express();
app.set('trust proxy', 1);
app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Cron-Secret']
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

const firebaseConfig = {
  apiKey: 'AIzaSyAIkcg_JzSCWORJt4EKm0gG4XOCcz8a7UI',
  authDomain: 'mstchat-f967d.firebaseapp.com',
  databaseURL: 'https://mstchat-f967d-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'mstchat-f967d',
  storageBucket: 'mstchat-f967d.firebasestorage.app',
  messagingSenderId: '13505298709',
  appId: '1:13505298709:web:da999c2d5f25d9bb4fa91c',
  measurementId: 'G-5S081E93W6'
};

const PROVIDER_URL = process.env.PROVIDER_URL || 'https://api.provider-smm.com/v2';
const PROVIDER_API_KEY = process.env.PROVIDER_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;
const CRON_SECRET = process.env.CRON_SECRET;
const PORT = Number(process.env.PORT || 8080);
const PROVIDER_TIMEOUT_MS = Number(process.env.PROVIDER_TIMEOUT_MS || 20000);

if (!PROVIDER_API_KEY) {
  console.warn('PROVIDER_API_KEY is not configured. Provider-backed routes will return configuration errors until it is set.');
}

function loadFirebaseCredential() {
  const jsonValue = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();

  if (jsonValue) {
    try {
      const serviceAccount = JSON.parse(jsonValue);
      if (!serviceAccount.project_id || !serviceAccount.client_email || !serviceAccount.private_key) {
        throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is missing project_id, client_email, or private_key.');
      }
      serviceAccount.private_key = String(serviceAccount.private_key).replace(/\\n/g, '\n');
      return admin.credential.cert(serviceAccount);
    } catch (error) {
      throw new Error(`Invalid FIREBASE_SERVICE_ACCOUNT_JSON: ${error.message}`);
    }
  }

  const projectId = String(
    process.env.FIREBASE_PROJECT_ID || process.env.GCP_PROJECT_ID || ''
  ).trim();
  const clientEmail = String(
    process.env.FIREBASE_CLIENT_EMAIL || process.env.GCP_CLIENT_EMAIL || ''
  ).trim();
  const privateKey = String(
    process.env.FIREBASE_PRIVATE_KEY || process.env.GCP_PRIVATE_KEY || ''
  ).replace(/\\n/g, '\n').trim();

  if (projectId && clientEmail && privateKey) {
    return admin.credential.cert({
      projectId,
      clientEmail,
      privateKey
    });
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return admin.credential.applicationDefault();
  }

  throw new Error(
    'Firebase Admin credentials are missing. Set FIREBASE_SERVICE_ACCOUNT_JSON on Railway, ' +
    'or set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY.'
  );
}

if (!admin.apps.length) {
  const credential = loadFirebaseCredential();

  admin.initializeApp({
    credential,
    databaseURL: firebaseConfig.databaseURL,
    projectId: firebaseConfig.projectId,
    storageBucket: firebaseConfig.storageBucket
  });
}

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

function nowIso() {
  return new Date().toISOString();
}

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function asFiniteNumber(value, fieldName) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    const err = new Error(`${fieldName} must be a valid number.`);
    err.statusCode = 400;
    throw err;
  }
  return n;
}

function sanitizeText(value, maxLength = 1000) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function normalizeProviderService(item) {
  return {
    id: String(item.service ?? item.id ?? ''),
    name: sanitizeText(item.name ?? item.service_name ?? '', 200),
    type: sanitizeText(item.type ?? 'Default', 60),
    category: sanitizeText(item.category ?? 'Other', 120),
    rate: money(item.rate ?? item.price ?? 0),
    min: Math.floor(Number(item.min ?? item.minimum ?? 0)),
    max: Math.floor(Number(item.max ?? item.maximum ?? 0)),
    refill: Boolean(item.refill),
    cancel: Boolean(item.cancel),
    raw: item
  };
}

function normalizeProviderStatus(item) {
  const statusText = String(item.status ?? '').trim();
  const normalized = statusText.toLowerCase().replace(/[_-]+/g, ' ');
  let status = 'Pending';
  if (normalized === 'completed' || normalized === 'complete') status = 'Completed';
  else if (normalized === 'in progress' || normalized === 'processing' || normalized === 'partial' || normalized === 'canceled' || normalized === 'cancelled' || normalized === 'pending') {
    if (normalized === 'processing' || normalized === 'in progress') status = 'In progress';
    else if (normalized === 'partial') status = 'Partial';
    else if (normalized === 'canceled' || normalized === 'cancelled') status = 'Canceled';
    else if (normalized === 'pending') status = 'Pending';
  }
  return {
    status,
    charge: Number.isFinite(Number(item.charge)) ? money(item.charge) : null,
    remains: Number.isFinite(Number(item.remains)) ? Math.max(0, Number(item.remains)) : null,
    startCount: Number.isFinite(Number(item.start_count ?? item.startCount)) ? Number(item.start_count ?? item.startCount) : null,
    raw: item
  };
}

async function providerRequest(payload, method = 'POST') {
  if (!PROVIDER_API_KEY) {
    const err = new Error('Provider API key is not configured on the backend.');
    err.statusCode = 503;
    throw err;
  }

  const url = PROVIDER_URL.replace(/\/$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);

  try {
    let response;
    if (method === 'GET') {
      const params = new URLSearchParams({ key: PROVIDER_API_KEY });
      for (const [key, value] of Object.entries(payload)) {
        if (Array.isArray(value)) params.set(key, value.join(','));
        else if (value !== undefined && value !== null) params.set(key, String(value));
      }
      response = await fetch(`${url}?${params.toString()}`, { signal: controller.signal });
    } else {
      const body = new URLSearchParams();
      body.set('key', PROVIDER_API_KEY);
      for (const [key, value] of Object.entries(payload)) {
        if (Array.isArray(value)) body.set(key, value.join(','));
        else if (value !== undefined && value !== null) body.set(key, String(value));
      }
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body,
        signal: controller.signal
      });
    }

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }

    if (!response.ok) {
      const err = new Error(`Provider HTTP ${response.status}`);
      err.statusCode = 502;
      err.providerResponse = data;
      throw err;
    }

    if (data && typeof data === 'object' && data.error) {
      const err = new Error(String(data.error));
      err.statusCode = 502;
      err.providerResponse = data;
      throw err;
    }

    return data;
  } catch (error) {
    if (error.name === 'AbortError') {
      const err = new Error('Provider request timed out.');
      err.statusCode = 504;
      throw err;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function verifyFirebaseToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing Firebase Bearer token.' });
    }
    const token = authHeader.slice(7).trim();
    if (!token) return res.status(401).json({ error: 'Invalid Authorization header.' });
    req.user = await admin.auth().verifyIdToken(token);
    next();
  } catch (error) {
    console.error('AUTH ERROR', error.message);
    return res.status(401).json({ error: 'Unauthorized.' });
  }
}

function isAdminChat(chatId) {
  const allowed = String(TELEGRAM_ADMIN_CHAT_ID || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
  return allowed.includes(String(chatId));
}

function requireCronSecret(req, res, next) {
  if (!CRON_SECRET) return res.status(503).json({ error: 'CRON_SECRET is not configured.' });
  const provided = req.headers['x-cron-secret'] || req.query.secret || '';
  if (provided !== CRON_SECRET) return res.status(401).json({ error: 'Unauthorized cron request.' });
  next();
}

async function sendTelegramMessage(text, replyMarkup = null) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_ADMIN_CHAT_ID) return null;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: String(TELEGRAM_ADMIN_CHAT_ID).split(',')[0].trim(),
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (replyMarkup) body.reply_markup = replyMarkup;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new Error(`Telegram sendMessage failed: ${response.status}`);
  }
  return data;
}

async function telegramApi(method, payload) {
  if (!TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not configured.');
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new Error(`Telegram ${method} failed: ${response.status}`);
  }
  return data;
}

async function logBalanceChange(transaction, userId, amount, type, reason, referenceId, before, after) {
  const logRef = db.collection('balance_logs').doc();
  transaction.set(logRef, {
    userId,
    amount: money(amount),
    type,
    reason: sanitizeText(reason, 500),
    referenceId: referenceId || null,
    balanceBefore: money(before),
    balanceAfter: money(after),
    createdAt: FieldValue.serverTimestamp(),
    createdAtIso: nowIso()
  });
}

function calculateRefund(order, providerStatus) {
  const original = money(order.totalPrice);
  if (providerStatus.status === 'Canceled') return original;

  if (providerStatus.status !== 'Partial') return 0;

  if (providerStatus.charge !== null) {
    return Math.max(0, money(original - providerStatus.charge));
  }

  if (providerStatus.remains !== null && Number(order.quantity) > 0) {
    const remains = Math.min(Number(order.quantity), providerStatus.remains);
    return Math.max(0, money(original * (remains / Number(order.quantity))));
  }

  return 0;
}

async function applyRefundForOrder(orderId, providerStatus) {
  if (!['Canceled', 'Partial'].includes(providerStatus.status)) return { refunded: 0 };

  return db.runTransaction(async transaction => {
    const orderRef = db.collection('orders').doc(orderId);
    const orderSnap = await transaction.get(orderRef);
    if (!orderSnap.exists) return { refunded: 0 };
    const current = orderSnap.data();

    if (current.refundProcessed || current.status === 'Refunded') {
      return { refunded: 0, alreadyProcessed: true };
    }

    const refund = calculateRefund(current, providerStatus);
    const userRef = db.collection('users').doc(current.userId);
    const userSnap = await transaction.get(userRef);
    if (!userSnap.exists) throw new Error(`User ${current.userId} does not exist.`);

    const user = userSnap.data();
    const before = money(user.balance);
    const after = money(before + refund);
    const nextStatus = providerStatus.status;

    transaction.update(orderRef, {
      status: nextStatus,
      providerStatus: providerStatus.raw,
      providerCharge: providerStatus.charge,
      remains: providerStatus.remains,
      refundAmount: money(refund),
      refundProcessed: true,
      refundedAt: FieldValue.serverTimestamp(),
      syncedAt: FieldValue.serverTimestamp(),
      syncedAtIso: nowIso()
    });

    if (refund > 0) {
      transaction.update(userRef, {
        balance: after,
        updatedAt: FieldValue.serverTimestamp()
      });
      await logBalanceChange(
        transaction,
        current.userId,
        refund,
        'refund',
        `Auto refund for provider status ${nextStatus}`,
        orderId,
        before,
        after
      );
    }

    return { refunded: money(refund), status: nextStatus };
  });
}

async function syncOrders() {
  const snap = await db.collection('orders')
    .where('status', 'in', ['Pending', 'In progress'])
    .limit(100)
    .get();

  if (snap.empty) return { scanned: 0, updated: 0, refunded: 0, errors: [] };

  const orders = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }))
    .filter(order => order.providerOrderId);

  const result = { scanned: orders.length, updated: 0, refunded: 0, errors: [] };
  const chunkSize = 50;

  for (let i = 0; i < orders.length; i += chunkSize) {
    const chunk = orders.slice(i, i + chunkSize);
    let statusResponse;
    try {
      statusResponse = await providerRequest({
        action: 'status',
        orders: chunk.map(o => o.providerOrderId)
      });
    } catch (error) {
      result.errors.push({ stage: 'provider_status', message: error.message });
      continue;
    }

    const map = new Map();
    if (Array.isArray(statusResponse)) {
      statusResponse.forEach((item, index) => map.set(String(item.order ?? item.id ?? chunk[index]?.providerOrderId), item));
    } else if (statusResponse && typeof statusResponse === 'object') {
      for (const [key, value] of Object.entries(statusResponse)) map.set(String(key), value);
    }

    for (const order of chunk) {
      const providerRaw = map.get(String(order.providerOrderId));
      if (!providerRaw) continue;
      try {
        const providerStatus = normalizeProviderStatus(providerRaw);
        const refundResult = await applyRefundForOrder(order.id, providerStatus);
        if (!refundResult.alreadyProcessed) {
          result.updated += 1;
          result.refunded += refundResult.refunded || 0;
        }
      } catch (error) {
        result.errors.push({ orderId: order.id, message: error.message });
      }
    }
  }

  return result;
}

app.get('/api/health', async (req, res) => {
  res.json({ ok: true, service: 'TDMS1VN backend', time: nowIso() });
});

app.get('/api/services', verifyFirebaseToken, async (req, res, next) => {
  try {
    const providerData = await providerRequest({ action: 'services' });
    const items = Array.isArray(providerData)
      ? providerData
      : (Array.isArray(providerData?.services) ? providerData.services : []);
    const services = items.map(normalizeProviderService).filter(s => s.id && s.rate >= 0);
    res.json({ services });
  } catch (error) {
    next(error);
  }
});

app.get('/api/me', verifyFirebaseToken, async (req, res, next) => {
  try {
    const ref = db.collection('users').doc(req.user.uid);
    const snap = await ref.get();
    if (!snap.exists) {
      const record = {
        uid: req.user.uid,
        email: req.user.email || '',
        displayName: req.user.name || '',
        photoURL: req.user.picture || '',
        role: 'user',
        balance: 0,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      };
      await ref.set(record);
      return res.json({ uid: req.user.uid, ...record, balance: 0 });
    }
    return res.json({ uid: snap.id, ...snap.data() });
  } catch (error) {
    next(error);
  }
});

app.get('/api/orders', verifyFirebaseToken, async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 100);
    const snap = await db.collection('orders').where('userId', '==', req.user.uid).limit(limit).get();
    const orders = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => String(b.createdAtIso || '').localeCompare(String(a.createdAtIso || '')));
    res.json({ orders });
  } catch (error) {
    next(error);
  }
});

app.post('/api/orders', verifyFirebaseToken, async (req, res, next) => {
  let createdOrderId = null;
  try {
    const serviceId = sanitizeText(req.body.service, 100);
    const link = sanitizeText(req.body.link, 2000);
    const quantity = Math.floor(asFiniteNumber(req.body.quantity, 'quantity'));
    const requestedTotal = money(req.body.totalPrice);

    if (!serviceId) return res.status(400).json({ error: 'service is required.' });
    if (!link || !/^https?:\/\//i.test(link)) return res.status(400).json({ error: 'link must be a valid http(s) URL.' });
    if (!Number.isInteger(quantity) || quantity <= 0) return res.status(400).json({ error: 'quantity must be a positive integer.' });
    if (!Number.isFinite(requestedTotal) || requestedTotal <= 0) return res.status(400).json({ error: 'totalPrice must be positive.' });

    const servicesData = await providerRequest({ action: 'services' });
    const servicesRaw = Array.isArray(servicesData)
      ? servicesData
      : (Array.isArray(servicesData?.services) ? servicesData.services : []);
    const service = servicesRaw.map(normalizeProviderService).find(s => s.id === serviceId);
    if (!service) return res.status(400).json({ error: 'Service no longer exists at provider.' });
    if (quantity < service.min || quantity > service.max) {
      return res.status(400).json({ error: `Quantity must be between ${service.min} and ${service.max}.` });
    }

    const authoritativeTotal = money(quantity * service.rate / 1000);
    if (Math.abs(authoritativeTotal - requestedTotal) > 0.01) {
      return res.status(409).json({ error: 'Price changed. Refresh services and try again.', authoritativeTotal });
    }

    const orderRef = db.collection('orders').doc();
    createdOrderId = orderRef.id;

    await db.runTransaction(async transaction => {
      const userRef = db.collection('users').doc(req.user.uid);
      const userSnap = await transaction.get(userRef);
      if (!userSnap.exists) throw Object.assign(new Error('User profile not found. Call /api/me first.'), { statusCode: 400 });

      const user = userSnap.data();
      const before = money(user.balance);
      if (before < authoritativeTotal) throw Object.assign(new Error('Insufficient balance.'), { statusCode: 400 });
      const after = money(before - authoritativeTotal);

      transaction.update(userRef, {
        balance: after,
        updatedAt: FieldValue.serverTimestamp()
      });

      transaction.set(orderRef, {
        userId: req.user.uid,
        serviceId,
        serviceName: service.name,
        category: service.category,
        link,
        quantity,
        rate: service.rate,
        totalPrice: authoritativeTotal,
        status: 'Pending',
        providerOrderId: null,
        providerStatus: null,
        providerCharge: null,
        remains: null,
        refundAmount: 0,
        refundProcessed: false,
        createdAt: FieldValue.serverTimestamp(),
        createdAtIso: nowIso(),
        updatedAt: FieldValue.serverTimestamp()
      });

      await logBalanceChange(
        transaction,
        req.user.uid,
        -authoritativeTotal,
        'order',
        `Order ${orderRef.id} created`,
        orderRef.id,
        before,
        after
      );
    });

    let providerData;
    try {
      providerData = await providerRequest({
        action: 'add',
        service: service.id,
        link,
        quantity
      });
    } catch (providerError) {
      await db.runTransaction(async transaction => {
        const orderRef = db.collection('orders').doc(createdOrderId);
        const userRef = db.collection('users').doc(req.user.uid);
        const orderSnap = await transaction.get(orderRef);
        const userSnap = await transaction.get(userRef);
        if (!orderSnap.exists || !userSnap.exists) return;
        const order = orderSnap.data();
        if (order.refundProcessed) return;
        const user = userSnap.data();
        const before = money(user.balance);
        const refund = money(order.totalPrice);
        const after = money(before + refund);
        transaction.update(userRef, { balance: after, updatedAt: FieldValue.serverTimestamp() });
        transaction.update(orderRef, {
          status: 'Canceled',
          refundAmount: refund,
          refundProcessed: true,
          failureReason: providerError.message,
          updatedAt: FieldValue.serverTimestamp()
        });
        await logBalanceChange(transaction, req.user.uid, refund, 'refund', 'Automatic refund because provider rejected the order.', createdOrderId, before, after);
      });
      providerError.statusCode = 502;
      throw providerError;
    }

    const providerOrderId = providerData?.order ?? providerData?.order_id ?? providerData?.id ?? null;
    if (!providerOrderId) {
      const error = new Error('Provider did not return an order ID.');
      error.statusCode = 502;
      throw error;
    }

    await db.collection('orders').doc(createdOrderId).update({
      providerOrderId: String(providerOrderId),
      providerResponse: providerData,
      updatedAt: FieldValue.serverTimestamp()
    });

    try {
      await sendTelegramMessage(
        `<b>🆕 ĐƠN HÀNG TDMS1VN</b>\n` +
        `Order: <code>${createdOrderId}</code>\n` +
        `Provider: <code>${String(providerOrderId)}</code>\n` +
        `User: <code>${req.user.uid}</code>\n` +
        `Service: ${service.name.replace(/</g, '&lt;')}\n` +
        `Quantity: ${quantity.toLocaleString('en-US')}\n` +
        `Total: ${authoritativeTotal.toLocaleString('en-US')} VND`
      );
    } catch (telegramError) {
      console.error('Telegram order notification error:', telegramError.message);
    }

    res.status(201).json({
      order: {
        id: createdOrderId,
        providerOrderId: String(providerOrderId),
        totalPrice: authoritativeTotal,
        status: 'Pending'
      }
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/deposits', verifyFirebaseToken, async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 100);
    const snap = await db.collection('deposits').where('userId', '==', req.user.uid).limit(limit).get();
    const deposits = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => String(b.createdAtIso || '').localeCompare(String(a.createdAtIso || '')));
    res.json({ deposits });
  } catch (error) {
    next(error);
  }
});

app.post('/api/deposits', verifyFirebaseToken, async (req, res, next) => {
  try {
    const amount = money(asFiniteNumber(req.body.amount, 'amount'));
    const method = sanitizeText(req.body.method || 'Bank transfer', 100);
    const note = sanitizeText(req.body.note || '', 500);
    if (amount <= 0) return res.status(400).json({ error: 'Deposit amount must be positive.' });
    if (amount > 1000000000) return res.status(400).json({ error: 'Deposit amount is too large.' });

    const depositRef = db.collection('deposits').doc();
    const deposit = {
      id: depositRef.id,
      userId: req.user.uid,
      email: req.user.email || '',
      amount,
      method,
      note,
      status: 'Pending',
      createdAt: FieldValue.serverTimestamp(),
      createdAtIso: nowIso(),
      processedAt: null,
      processedBy: null
    };
    await depositRef.set(deposit);

    const keyboard = {
      inline_keyboard: [[
        { text: '✅ Duyệt', callback_data: `approve_deposit:${depositRef.id}` },
        { text: '❌ Từ chối', callback_data: `reject_deposit:${depositRef.id}` }
      ]]
    };

    try {
      await sendTelegramMessage(
        `<b>💰 YÊU CẦU NẠP TIỀN</b>\n` +
        `ID: <code>${depositRef.id}</code>\n` +
        `User: <code>${req.user.uid}</code>\n` +
        `Email: ${String(req.user.email || '').replace(/</g, '&lt;')}\n` +
        `Amount: <b>${amount.toLocaleString('en-US')} VND</b>\n` +
        `Method: ${method.replace(/</g, '&lt;')}\n` +
        `Note: ${note.replace(/</g, '&lt;') || '(none)'}`,
        keyboard
      );
    } catch (telegramError) {
      await depositRef.update({ telegramError: telegramError.message, updatedAt: FieldValue.serverTimestamp() });
      console.error('Telegram deposit notification error:', telegramError.message);
    }

    res.status(201).json({ deposit: { ...deposit, id: depositRef.id, status: 'Pending' } });
  } catch (error) {
    next(error);
  }
});

app.get('/api/balance-logs', verifyFirebaseToken, async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 200);
    const snap = await db.collection('balance_logs').where('userId', '==', req.user.uid).limit(limit).get();
    const logs = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => String(b.createdAtIso || '').localeCompare(String(a.createdAtIso || '')));
    res.json({ logs });
  } catch (error) {
    next(error);
  }
});

app.get('/api/cron/sync-orders', requireCronSecret, async (req, res, next) => {
  try {
    const result = await syncOrders();
    res.json({ ok: true, ...result, finishedAt: nowIso() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/telegram/webhook', async (req, res) => {
  try {
    const update = req.body || {};
    if (update.callback_query) {
      const callback = update.callback_query;
      const chatId = callback.message?.chat?.id;
      if (!isAdminChat(chatId)) {
        await telegramApi('answerCallbackQuery', { callback_query_id: callback.id, text: 'Không có quyền.', show_alert: true });
        return res.json({ ok: true });
      }

      const [action, depositId] = String(callback.data || '').split(':');
      if (!depositId || !['approve_deposit', 'reject_deposit'].includes(action)) {
        await telegramApi('answerCallbackQuery', { callback_query_id: callback.id, text: 'Callback không hợp lệ.', show_alert: true });
        return res.json({ ok: true });
      }

      let resultStatus = 'Rejected';
      let amountChanged = 0;
      await db.runTransaction(async transaction => {
        const depositRef = db.collection('deposits').doc(depositId);
        const depositSnap = await transaction.get(depositRef);
        if (!depositSnap.exists) throw Object.assign(new Error('Deposit not found.'), { statusCode: 404 });
        const deposit = depositSnap.data();
        if (deposit.status !== 'Pending') {
          resultStatus = deposit.status;
          return;
        }

        if (action === 'approve_deposit') {
          const userRef = db.collection('users').doc(deposit.userId);
          const userSnap = await transaction.get(userRef);
          if (!userSnap.exists) throw new Error('User profile not found.');
          const user = userSnap.data();
          const before = money(user.balance);
          const after = money(before + money(deposit.amount));
          transaction.update(userRef, { balance: after, updatedAt: FieldValue.serverTimestamp() });
          transaction.update(depositRef, {
            status: 'Completed',
            processedAt: FieldValue.serverTimestamp(),
            processedBy: String(callback.from?.id || '')
          });
          await logBalanceChange(transaction, deposit.userId, deposit.amount, 'deposit', 'Telegram admin approved deposit.', depositId, before, after);
          amountChanged = money(deposit.amount);
          resultStatus = 'Completed';
        } else {
          transaction.update(depositRef, {
            status: 'Rejected',
            processedAt: FieldValue.serverTimestamp(),
            processedBy: String(callback.from?.id || '')
          });
          resultStatus = 'Rejected';
        }
      });

      const label = resultStatus === 'Completed' ? '✅ ĐÃ DUYỆT' : '❌ ĐÃ TỪ CHỐI';
      await telegramApi('answerCallbackQuery', {
        callback_query_id: callback.id,
        text: resultStatus === 'Completed' ? `Đã cộng ${amountChanged.toLocaleString('en-US')} VND.` : 'Đã từ chối yêu cầu.'
      });

      const messageText = callback.message?.text || '';
      await telegramApi('editMessageText', {
        chat_id: chatId,
        message_id: callback.message?.message_id,
        text: `${messageText}\n\n<b>${label}</b>`,
        parse_mode: 'HTML'
      }).catch(() => null);
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('Telegram webhook error:', error);
    res.json({ ok: true });
  }
});

app.use((error, req, res, next) => {
  const status = Number(error.statusCode || 500);
  const message = status >= 500 ? 'Internal server error.' : error.message;
  console.error('API ERROR', { path: req.path, method: req.method, status, message, stack: error.stack });
  res.status(status).json({ error: message });
});

app.listen(PORT, () => {
  console.log(`TDMS1VN backend listening on ${PORT}`);
});

module.exports = app;
