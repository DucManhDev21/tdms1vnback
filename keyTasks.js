const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { createVoucher } = require('./vouchers');

const router = express.Router();
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const KEY_RE = /^TDM-[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const MIN_WAIT_MS = 25 * 1000;
const TOKEN_TTL_MS = 15 * 60 * 1000;
const KEY_TTL_MS = 24 * 60 * 60 * 1000;
const DAILY_LIMIT = 3;
const VOUCHER_PERCENT = 10;
const VOUCHER_DAYS = 7;

const sha = v => crypto.createHash('sha256').update(v).digest('hex');
const rnd = n => Array.from({ length: n }, () => ALPHA[crypto.randomInt(ALPHA.length)]).join('');
const toMs = v => (v && v.toMillis ? v.toMillis() : v && v._seconds != null ? v._seconds * 1000 : new Date(v || 0).getTime());
const today = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
const fail = (res, code, msg) => res.status(code).json({ error: msg });
const keySite = () => process.env.KEY_SITE_URL || 'https://key-tdms1vn.vercel.app';
const verifyUser = (req, res, next) => req.app.locals.verifyToken(req, res, next);

// Rút gọn link bằng Link4M (đặt LINK4M_API_KEY trên Railway)
async function shorten(url) {
  const api = process.env.LINK4M_API_KEY;
  if (!api) throw new Error('Chưa cấu hình LINK4M_API_KEY');
  const { data } = await axios.get('https://link4m.co/api-shorten/v2', { params: { api, url }, timeout: 10000 });
  if (!data || data.status !== 'success' || !data.shortenedUrl) throw new Error('Không tạo được link nhiệm vụ');
  return data.shortenedUrl;
}

// 1. Người dùng bấm Lấy key: tạo token và link nhiệm vụ
router.post('/tasks/start', verifyUser, async (req, res) => {
  try {
    const db = req.app.locals.db, admin = req.app.locals.admin, uid = req.user.uid;
    const day = today();
    const recent = await db.collection('key_tasks').where('uid', '==', uid).where('day', '==', day).limit(DAILY_LIMIT + 1).get();
    if (recent.size >= DAILY_LIMIT) return fail(res, 429, `Hôm nay bạn đã làm đủ ${DAILY_LIMIT} nhiệm vụ. Quay lại ngày mai nhé.`);
    const token = crypto.randomBytes(24).toString('base64url');
    const now = Date.now();
    await db.collection('key_tasks').doc(sha(token)).set({
      uid, day,
      createdAt: admin.firestore.Timestamp.fromMillis(now),
      expiresAt: admin.firestore.Timestamp.fromMillis(now + TOKEN_TTL_MS),
      usedAt: null
    });
    const url = await shorten(`${keySite()}/?t=${token}`);
    res.json({ url });
  } catch (e) {
    console.error('tasks/start:', e.message);
    fail(res, 500, e.message || 'Không tạo được nhiệm vụ');
  }
});

// 2. Trang key gọi khi người dùng quay về sau khi vượt link
router.get('/key/verify', async (req, res) => {
  try {
    const db = req.app.locals.db, admin = req.app.locals.admin;
    const token = String(req.query.t || '');
    if (!token) return fail(res, 400, 'Thiếu mã nhiệm vụ');
    const ref = db.collection('key_tasks').doc(sha(token));
    const now = Date.now();
    const key = await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('Link nhiệm vụ không hợp lệ');
      const t = snap.data();
      if (t.usedAt) throw new Error('Link này đã được dùng');
      if (toMs(t.expiresAt) <= now) throw new Error('Link nhiệm vụ đã hết hạn, hãy lấy link mới');
      if (now - toMs(t.createdAt) < MIN_WAIT_MS) throw new Error('Bạn vượt link quá nhanh, hãy xem đủ thời gian rồi thử lại');
      const code = `TDM-${rnd(4)}-${rnd(4)}`;
      tx.update(ref, { usedAt: admin.firestore.FieldValue.serverTimestamp(), key: code });
      tx.set(db.collection('keys').doc(code), {
        uid: t.uid,
        createdAt: admin.firestore.Timestamp.fromMillis(now),
        expiresAt: admin.firestore.Timestamp.fromMillis(now + KEY_TTL_MS),
        usedAt: null
      });
      return code;
    });
    res.json({ key });
  } catch (e) {
    fail(res, 400, e.message || 'Không xác nhận được');
  }
});

// 3. Người dùng dán key trên TDMS1VN để nhận voucher 10%
router.post('/keys/redeem', verifyUser, async (req, res) => {
  try {
    const db = req.app.locals.db, admin = req.app.locals.admin, uid = req.user.uid;
    const key = String(req.body?.key || '').trim().toUpperCase();
    if (!KEY_RE.test(key)) return fail(res, 400, 'Key không đúng định dạng TDM-XXXX-XXXX');
    const ref = db.collection('keys').doc(key);
    const now = Date.now();
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('Key không tồn tại');
      const k = snap.data();
      if (k.uid !== uid) throw new Error('Key này không thuộc tài khoản của bạn');
      if (k.usedAt) throw new Error('Key đã được dùng');
      if (toMs(k.expiresAt) <= now) throw new Error('Key đã hết hạn');
      tx.update(ref, { usedAt: admin.firestore.FieldValue.serverTimestamp() });
    });
    const code = 'VC' + rnd(6);
    await createVoucher(db, admin, { code, percent: VOUCHER_PERCENT, maxUses: 1, days: VOUCHER_DAYS }, 'key');
    await db.collection('user_vouchers').doc(`${uid}_${code}`).set({
      uid, code, savedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ code, percent: VOUCHER_PERCENT });
  } catch (e) {
    fail(res, 400, e.message || 'Không đổi được key');
  }
});

module.exports = router;
