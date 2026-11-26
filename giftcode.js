// Giftcode: admin phát riêng, người dùng nhập trên web để cộng tiền vào số dư.
const express = require('express');

const router = express.Router();
const CODE_RE = /^[A-Z0-9_-]{4,32}$/;
const MAX_PER_USE = 10000;   // tối đa 10.000đ mỗi lượt
const MAX_TOTAL = 20000;     // tổng tiền một mã tối đa 20.000đ (số lượt × số tiền)
const MAX_DAYS = 90;
const money = v => `${Math.round(Number(v || 0)).toLocaleString('vi-VN')}đ`;
const verifyUser = (req, res, next) => req.app.locals.verifyToken(req, res, next);

// Admin: /giftcode CODE số_tiền số_lượt số_ngày
async function createGiftcode(db, admin, input, createdBy) {
  const code = String(input.code || '').trim().toUpperCase();
  const amount = Number(input.amount);
  const uses = Number(input.uses);
  const days = Number(input.days);
  if (!CODE_RE.test(code)) throw new Error('Mã chỉ gồm chữ không dấu, số, _ hoặc -, dài 4 đến 32 ký tự.');
  if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_PER_USE) throw new Error(`Số tiền mỗi lượt phải từ 1 đến ${money(MAX_PER_USE)}.`);
  if (!Number.isInteger(uses) || uses <= 0) throw new Error('Số lượt phải là số nguyên dương.');
  if (amount * uses > MAX_TOTAL) throw new Error(`Tổng tiền mã (${money(amount)} × ${uses} = ${money(amount * uses)}) vượt ${money(MAX_TOTAL)}.`);
  if (!Number.isInteger(days) || days <= 0 || days > MAX_DAYS) throw new Error(`Số ngày sử dụng phải từ 1 đến ${MAX_DAYS}.`);

  const ref = db.collection('giftcodes').doc(code);
  const exists = await ref.get();
  if (exists.exists) throw new Error(`Mã ${code} đã tồn tại.`);
  const expiresAt = new Date(Date.now() + days * 24 * 3600 * 1000);
  await ref.set({
    code, amount, uses, usedCount: 0, total: amount * uses, active: true,
    expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
    createdBy, createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  return { code, amount, uses, total: amount * uses, expText: expiresAt.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) };
}

// Admin: /xoagiftcode CODE (vô hiệu hóa, giữ lịch sử)
async function disableGiftcode(db, admin, code) {
  const c = String(code || '').trim().toUpperCase();
  const ref = db.collection('giftcodes').doc(c);
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`Không tìm thấy mã ${c}.`);
  await ref.update({ active: false, disabledAt: admin.firestore.FieldValue.serverTimestamp() });
  return c;
}

// Người dùng nhập mã trên web
router.post('/redeem', verifyUser, async (req, res) => {
  try {
    const db = req.app.locals.db, admin = req.app.locals.admin, uid = req.user.uid;
    const code = String(req.body?.code || '').trim().toUpperCase();
    if (!CODE_RE.test(code)) return res.status(400).json({ error: 'Mã giftcode không hợp lệ.' });
    const ref = db.collection('giftcodes').doc(code);
    const usageRef = ref.collection('uses').doc(uid);
    const userRef = db.collection('users').doc(uid);
    const now = Date.now();

    const result = await db.runTransaction(async tx => {
      const [gift, usage, user] = await Promise.all([tx.get(ref), tx.get(usageRef), tx.get(userRef)]);
      if (!gift.exists) throw new Error('Mã giftcode không tồn tại.');
      const g = gift.data();
      if (!g.active) throw new Error('Mã giftcode đã bị vô hiệu hóa.');
      if (g.expiresAt && g.expiresAt.toMillis() <= now) throw new Error('Mã giftcode đã hết hạn.');
      if ((g.usedCount || 0) >= g.uses) throw new Error('Mã giftcode đã hết lượt.');
      if (usage.exists) throw new Error('Tài khoản của bạn đã nhập mã này rồi.');
      if (!user.exists) throw new Error('Không tìm thấy tài khoản.');

      const old = Math.round(Number(user.data()?.balance || 0) * 100) / 100;
      const next = Math.round((old + g.amount) * 100) / 100;
      tx.update(ref, { usedCount: (g.usedCount || 0) + 1 });
      tx.set(usageRef, { uid, amount: g.amount, usedAt: admin.firestore.FieldValue.serverTimestamp() });
      tx.update(userRef, { balance: next, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      tx.set(db.collection('balance_logs').doc(), {
        uid, amount: g.amount, type: 'credit', reason: `Giftcode ${code}`,
        oldBalance: old, newBalance: next, adminAction: 'giftcode',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return { amount: g.amount, newBalance: next };
    });
    res.json({ ok: true, code, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Không nhập được mã giftcode.' });
  }
});

module.exports = { router, createGiftcode, disableGiftcode, MAX_PER_USE, MAX_TOTAL };
