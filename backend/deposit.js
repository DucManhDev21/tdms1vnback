const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const router = express.Router();

const cardTypes = new Set(['Viettel', 'Vinaphone', 'Mobifone', 'Zing', 'Gate']);
const amounts = new Set([10000, 20000, 30000, 50000, 100000, 200000, 300000, 500000, 1000000]);

function signPayload(raw) {
  const secret = process.env.DEPOSIT_WEBHOOK_SECRET || '';
  return crypto.createHmac('sha256', secret).update(raw).digest('hex');
}

function telegramClient() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  return axios.create({ baseURL: `https://api.telegram.org/bot${token}`, timeout: 15000 });
}

async function notifyAdminTelegram(text, keyboard) {
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (!chatId) throw new Error('TELEGRAM_ADMIN_CHAT_ID is not configured');
  const client = telegramClient();
  await client.post('/sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined
  });
}

async function grantDeposit(db, admin, depositId, decision) {
  const depositRef = db.collection('deposits').doc(depositId);
  await db.runTransaction(async tx => {
    const depSnap = await tx.get(depositRef);
    if (!depSnap.exists) throw new Error('Deposit not found');
    const dep = depSnap.data();
    if (['Thành công', 'Thất bại'].includes(dep.status)) return;
    if (decision === 'approve') {
      const userRef = db.collection('users').doc(dep.uid);
      const userSnap = await tx.get(userRef);
      const oldBalance = Number(userSnap.data()?.balance || 0);
      const credit = Number(dep.amount || 0);
      const newBalance = oldBalance + credit;
      tx.update(userRef, { balance: newBalance });
      tx.update(depositRef, { status: 'Thành công', reviewedAt: admin.firestore.FieldValue.serverTimestamp() });
      const logRef = db.collection('balance_logs').doc();
      tx.set(logRef, {
        uid: dep.uid,
        amount: credit,
        type: 'credit',
        reason: `Duyệt nạp tiền ${depositId}`,
        oldBalance,
        newBalance,
        depositId,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    } else {
      tx.update(depositRef, { status: 'Thất bại', reviewedAt: admin.firestore.FieldValue.serverTimestamp() });
    }
  });
}

router.post('/cards', async (req, res) => {
  const db = req.app.locals.db;
  const admin = req.app.locals.admin;
  const uid = req.user.uid;
  const { cardType, serial, code, amount } = req.body || {};
  const normalizedAmount = Number.parseInt(amount, 10);
  if (!cardTypes.has(String(cardType)) || !amounts.has(normalizedAmount) || !serial || !code) {
    return res.status(400).json({ error: 'Thông tin thẻ không hợp lệ' });
  }
  if (String(serial).length > 100 || String(code).length > 100) return res.status(400).json({ error: 'Thông tin thẻ quá dài' });
  try {
    const depositRef = db.collection('deposits').doc();
    txSafeCreate: {
      await db.runTransaction(async tx => {
        tx.create(depositRef, {
          uid,
          type: 'card',
          cardType: String(cardType),
          serial: String(serial).trim(),
          code: String(code).trim(),
          amount: normalizedAmount,
          status: 'Chờ duyệt',
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      });
    }

    let gatewayResult = null;
    if (process.env.DEPOSIT_GATEWAY_URL) {
      const response = await axios.post(process.env.DEPOSIT_GATEWAY_URL, {
        partner_id: process.env.DEPOSIT_GATEWAY_PARTNER_ID || '',
        partner_key: process.env.DEPOSIT_GATEWAY_PARTNER_KEY || '',
        telco: cardType,
        amount: normalizedAmount,
        serial,
        code,
        request_id: depositRef.id,
        callback_url: process.env.DEPOSIT_CALLBACK_URL || ''
      }, { timeout: 20000 });
      gatewayResult = response.data;
      await depositRef.update({ gatewayResponse: gatewayResult, status: gatewayResult?.status || 'Chờ duyệt' });
    }

    const text = `<b>TDMS1VN - Nạp thẻ</b>\nID: <code>${depositRef.id}</code>\nUser: <code>${uid}</code>\nLoại: ${cardType}\nMệnh giá: ${normalizedAmount.toLocaleString('vi-VN')}đ\nSeri: <code>${String(serial).replace(/&/g, '&amp;')}</code>`;
    await notifyAdminTelegram(text, [[
      { text: '✅ Duyệt', callback_data: `deposit:approve:${depositRef.id}` },
      { text: '❌ Không duyệt', callback_data: `deposit:reject:${depositRef.id}` }
    ]]);
    res.status(201).json({ ok: true, depositId: depositRef.id, gateway: gatewayResult });
  } catch (error) {
    console.error('deposit card:', error);
    res.status(500).json({ error: 'Không thể gửi yêu cầu nạp thẻ' });
  }
});

router.get('/', async (req, res) => {
  const db = req.app.locals.db;
  const uid = req.user.uid;
  try {
    const snap = await db.collection('deposits').where('uid', '==', uid).orderBy('createdAt', 'desc').limit(100).get();
    res.json({ deposits: snap.docs.map(doc => ({ id: doc.id, ...doc.data(), code: undefined })) });
  } catch (error) {
    console.error('deposit list:', error);
    res.status(500).json({ error: 'Không thể lấy lịch sử nạp tiền' });
  }
});

router.post('/gateway/callback', express.raw({ type: '*/*' }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''), 'utf8');
  const signature = req.get('X-Deposit-Signature') || '';
  const expected = signPayload(raw.toString('utf8'));
  if (!signature || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return res.status(401).send('invalid signature');
  const payload = JSON.parse(raw.toString('utf8'));
  const db = req.app.locals.db;
  const admin = req.app.locals.admin;
  const depositId = String(payload.request_id || payload.deposit_id || '');
  if (!depositId) return res.status(400).send('missing request id');
  const status = String(payload.status || '').toLowerCase();
  const success = ['success', 'completed', 'approved', '1'].includes(status);
  try {
    await db.collection('deposits').doc(depositId).update({
      gatewayCallback: payload,
      status: success ? 'Gateway xác nhận' : 'Thất bại',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ ok: true });
  } catch (error) {
    console.error('gateway callback:', error);
    res.status(500).send('error');
  }
});

async function handleTelegramUpdate(update, db, admin) {
  const message = update.message;
  const callback = update.callback_query;
  if (message?.text) {
    const chatId = String(message.chat.id);
    if (process.env.TELEGRAM_ADMIN_CHAT_ID && chatId !== String(process.env.TELEGRAM_ADMIN_CHAT_ID)) return;
    const text = message.text.trim();
    if (text.startsWith('/addpopup ')) {
      const payload = text.slice(10).trim();
      const parts = payload.split('|').map(v => v.trim());
      if (parts.length < 3) throw new Error('Format: /addpopup title | content | id');
      const [title, content, id] = parts;
      await db.collection('popups').doc(id).set({ id, title, content, createdAt: admin.firestore.FieldValue.serverTimestamp() });
      await telegramClient().post('/sendMessage', { chat_id: chatId, text: `✅ Đã thêm popup ${id}` });
      return;
    }
    if (text.startsWith('/deletepopup ')) {
      const id = text.slice(14).trim();
      if (!id) throw new Error('Missing popup id');
      await db.collection('popups').doc(id).delete();
      await telegramClient().post('/sendMessage', { chat_id: chatId, text: `✅ Đã xóa popup ${id}` });
      return;
    }
  }
  if (callback?.data) {
    const chatId = String(callback.message?.chat?.id || '');
    if (process.env.TELEGRAM_ADMIN_CHAT_ID && chatId !== String(process.env.TELEGRAM_ADMIN_CHAT_ID)) return;
    const parts = callback.data.split(':');
    if (parts[0] === 'deposit' && parts.length === 3) {
      const action = parts[1];
      const depositId = parts[2];
      await grantDeposit(db, admin, depositId, action === 'approve' ? 'approve' : 'reject');
      await telegramClient().post('/answerCallbackQuery', { callback_query_id: callback.id, text: 'Đã xử lý' });
      await telegramClient().post('/editMessageReplyMarkup', { chat_id: chatId, message_id: callback.message.message_id, reply_markup: { inline_keyboard: [] } });
    }
  }
}

router.post('/telegram/webhook', express.json({ limit: '128kb' }), async (req, res) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.get('X-Telegram-Bot-Api-Secret-Token') !== secret) return res.status(401).json({ error: 'Invalid secret' });
  try {
    await handleTelegramUpdate(req.body, req.app.locals.db, req.app.locals.admin);
    res.json({ ok: true });
  } catch (error) {
    console.error('telegram webhook:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

module.exports = router;
