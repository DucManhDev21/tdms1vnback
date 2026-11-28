// Callback nạp thẻ + kiểm tra trạng thái. Mặc định TẮT (CARD_ENABLED != 'true').
// Quy tắc: chỉ cộng tiền khi (1) callback_sign đúng, (2) hỏi lại gachthe47 (command=check) báo status 1,
// (3) số tiền khớp với số đã tính, (4) đơn còn đang chờ. Chống cộng trùng bằng trạng thái đơn.
const express = require('express');
const crypto = require('crypto');

const router = express.Router();
const CREDIT_RATE = 0.7; // khách nhận 70% mệnh giá (đối tác thu phí 30%)

function md5(text) {
  return crypto.createHash('md5').update(text).digest('hex');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Hỏi lại trạng thái thẻ: POST cùng endpoint, command=check, ký md5(partner_key + code + serial)
async function checkCardStatus(f) {
  const key = process.env.CARD_PARTNER_KEY, pid = process.env.CARD_PARTNER_ID, url = process.env.CARD_API_URL;
  if (!key || !pid || !url) throw new Error('Thiếu cấu hình CARD_PARTNER_KEY, CARD_PARTNER_ID hoặc CARD_API_URL');
  const form = new FormData();
  const fields = {
    telco: f.telco, code: f.code, serial: f.serial,
    amount: String(f.declared_value), request_id: f.request_id,
    partner_id: pid, sign: md5(key + f.code + f.serial), command: 'check'
  };
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const r = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(20000) });
  const data = await r.json().catch(() => null);
  if (!data) throw new Error('Phản hồi kiểm tra thẻ không hợp lệ');
  return data; // có status, amount, message...
}

// Cộng tiền đúng một lần cho đơn đã xác minh
async function creditCardOrder(db, admin, orderRef, expectedCredit, verifiedAmount) {
  return db.runTransaction(async tx => {
    const snap = await tx.get(orderRef);
    if (!snap.exists) throw new Error('Không tìm thấy đơn nạp');
    const o = snap.data();
    if (o.status === 'success') return { alreadyDone: true };
    if (o.status !== 'pending') throw new Error(`Đơn đang ở trạng thái ${o.status}`);
    if (Math.round(Number(verifiedAmount)) !== Math.round(expectedCredit)) {
      tx.update(orderRef, { status: 'needs_review', reviewReason: 'Số tiền không khớp', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      throw new Error('Số tiền không khớp, chuyển admin kiểm tra');
    }
    const userRef = db.collection('users').doc(o.uid);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error('Không tìm thấy tài khoản');
    const old = Math.round(Number(userSnap.data()?.balance || 0) * 100) / 100;
    const next = Math.round((old + expectedCredit) * 100) / 100;
    tx.update(orderRef, { status: 'success', creditedAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    tx.update(userRef, { balance: next, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    tx.set(db.collection('balance_logs').doc(), {
      uid: o.uid, amount: expectedCredit, type: 'credit',
      reason: `Nạp thẻ ${o.telco} ${o.declaredValue}đ`,
      oldBalance: old, newBalance: next, adminAction: 'card_callback', requestId: o.requestId,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return { alreadyDone: false, credited: expectedCredit, newBalance: next };
  });
}

async function handleCallback(req, res) {
  const db = req.app.locals.db, admin = req.app.locals.admin;
  if (process.env.CARD_ENABLED !== 'true') return res.status(503).json({ error: 'Nạp thẻ tự động đang tắt' });

  // Callback có thể là POST JSON hoặc GET (tham số trên URL)
  const body = { ...(req.query || {}), ...(req.body || {}) };
  const code = String(body.code || ''), serial = String(body.serial || '');
  const requestId = String(body.request_id || '').slice(0, 64);
  if (!requestId || !code || !serial) return res.status(400).json({ error: 'Thiếu dữ liệu callback' });

  // Xác thực chữ ký callback: md5(partner_key + code + serial)
  if (!process.env.CARD_PARTNER_KEY) return res.status(503).json({ error: 'Chưa cấu hình khóa đối tác' });
  if (!safeEqual(body.callback_sign, md5(process.env.CARD_PARTNER_KEY + code + serial))) {
    return res.status(403).json({ error: 'Sai chữ ký callback' });
  }

  // Lưu log đã che mã thẻ
  const logId = md5(JSON.stringify(body)) + crypto.randomBytes(4).toString('hex');
  const safe = { ...body };
  if (safe.code) safe.code = '*'.repeat(Math.max(0, code.length - 4)) + code.slice(-4);
  if (safe.serial) safe.serial = '*'.repeat(Math.max(0, serial.length - 4)) + serial.slice(-4);
  delete safe.callback_sign;
  await db.collection('card_callbacks').doc(logId).set({ body: safe, requestId, receivedAt: admin.firestore.FieldValue.serverTimestamp() });

  const orderRef = db.collection('card_orders').doc(requestId);
  const order = await orderRef.get();
  if (!order.exists) return res.status(404).json({ error: 'Không có đơn nạp này' });
  const o = order.data();
  if (o.status === 'success') return res.json({ ok: true, alreadyDone: true });

  const cbStatus = Number(body.status);
  if (cbStatus === 99) return res.status(202).json({ ok: false, pending: true });
  if (cbStatus !== 1) {
    // 2: sai mệnh giá, 3: thẻ lỗi, 4: bảo trì, 100: thất bại -> admin xem
    await orderRef.update({ status: 'needs_review', reviewReason: `Callback status ${cbStatus}: ${body.message || ''}`, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    return res.status(202).json({ ok: false, needsReview: true });
  }

  try {
    // Hỏi lại gachthe47 trước khi cộng tiền
    const chk = await checkCardStatus({ telco: body.telco, code, serial, declared_value: body.declared_value || o.declaredValue, request_id: requestId });
    if (Number(chk.status) !== 1) throw new Error(`Kiểm tra thẻ: status ${chk.status} ${chk.message || ''}`);
    const credited = await creditCardOrder(db, admin, orderRef, o.expectedCredit, chk.amount);
    return res.json({ ok: true, ...credited });
  } catch (e) {
    await orderRef.update({ lastCallbackError: e.message, updatedAt: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
    return res.status(202).json({ ok: false, error: e.message });
  }
}

// Đường dẫn có secret (mount dưới /api): /api/card/callback/<secret>
const withSecret = (req, res, next) => {
  if (!safeEqual(req.params.secret, process.env.CARD_CALLBACK_SECRET)) return res.status(403).json({ error: 'Forbidden' });
  next();
};
router.post('/card/callback/:secret', withSecret, express.json(), express.urlencoded({ extended: true }), handleCallback);
router.get('/card/callback/:secret', withSecret, handleCallback);

// Đường dẫn gốc đang cấu hình trên gachthe47: /charge/callback
// Không cần secret: callback đã được xác thực bằng callback_sign và hỏi lại command=check
const rootRouter = express.Router();
rootRouter.post('/charge/callback', express.json(), express.urlencoded({ extended: true }), handleCallback);
rootRouter.get('/charge/callback', handleCallback);

module.exports = { router, rootRouter, checkCardStatus, creditCardOrder, CREDIT_RATE, md5 };
