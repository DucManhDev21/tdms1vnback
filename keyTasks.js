// Hệ thống nhiệm vụ lấy key: mỗi nhiệm vụ có link riêng, key riêng, lịch sử riêng.
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { createVoucher } = require('./vouchers');

const router = express.Router();
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MIN_WAIT_MS = 25 * 1000;          // phải ở trên link tối thiểu 25 giây
const TASK_TTL_MS = 6 * 60 * 60 * 1000; // nhiệm vụ đang dở giữ 6 giờ
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

async function shorten(url) {
  const api = process.env.LINK4M_API_KEY;
  if (!api) throw new Error('Chưa cấu hình LINK4M_API_KEY');
  const { data } = await axios.get('https://link4m.co/api-shorten/v2', { params: { api, url }, timeout: 10000 });
  const short = data && (data.shortenedUrl || data.short || (data.data && data.data.shortenedUrl));
  if (!short) {
    console.error('Link4M response:', JSON.stringify(data).slice(0, 300));
    throw new Error('Không tạo được link nhiệm vụ, thử lại sau');
  }
  return short;
}

// Trạng thái hiển thị: done | issued (đã có key) | pending (đang vượt link) | expired
function viewOf(t, now = Date.now()) {
  let status = t.status;
  if (status === 'pending' && toMs(t.expiresAt) <= now) status = 'expired';
  return {
    id: t.id,
    status,
    createdAt: new Date(toMs(t.createdAt)).toISOString(),
    url: status === 'pending' || status === 'issued' ? t.url : null,
    key: status === 'issued' ? t.keyCode : null,
    voucherCode: status === 'done' ? t.voucherCode || null : null
  };
}

// 1. Lấy nhiệm vụ đang dở hoặc tạo nhiệm vụ mới (mỗi tài khoản chỉ 1 nhiệm vụ đang dở)
router.post('/tasks/start', verifyUser, async (req, res) => {
  try {
    const db = req.app.locals.db, admin = req.app.locals.admin, uid = req.user.uid;
    const now = Date.now();
    const mine = await db.collection('tasks').where('uid', '==', uid).limit(100).get();
    const open = mine.docs.map(d => ({ id: d.id, ...d.data() })).find(t => (t.status === 'pending' || t.status === 'issued') && toMs(t.expiresAt) > now);
    if (open) return res.json({ task: viewOf(open), resumed: true });

    const day = today();
    const todayCount = mine.docs.filter(d => d.data().day === day).length;
    if (todayCount >= DAILY_LIMIT) return fail(res, 429, `Hôm nay bạn đã làm đủ ${DAILY_LIMIT} nhiệm vụ. Quay lại ngày mai nhé.`);

    const id = rnd(10);
    const token = crypto.randomBytes(24).toString('base64url');
    const url = await shorten(`${keySite()}/?t=${token}`);
    const doc = {
      uid, day, status: 'pending', url, tokenHash: sha(token),
      createdAt: admin.firestore.Timestamp.fromMillis(now),
      expiresAt: admin.firestore.Timestamp.fromMillis(now + TASK_TTL_MS)
    };
    await db.collection('tasks').doc(id).set(doc);
    res.json({ task: viewOf({ id, ...doc }), resumed: false });
  } catch (e) {
    console.error('tasks/start:', e.message);
    fail(res, 500, e.message || 'Không tạo được nhiệm vụ');
  }
});

// 2. Lịch sử nhiệm vụ của tài khoản
router.get('/tasks', verifyUser, async (req, res) => {
  try {
    const db = req.app.locals.db, uid = req.user.uid;
    const snap = await db.collection('tasks').where('uid', '==', uid).limit(100).get();
    const items = snap.docs.map(d => viewOf({ id: d.id, ...d.data() }))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ items });
  } catch (e) {
    console.error('tasks list:', e.message);
    fail(res, 500, 'Không tải được lịch sử nhiệm vụ');
  }
});

// 3. Trang key gọi khi người dùng quay về từ link (có thể gọi lại nhiều lần, key không đổi)
router.get('/key/verify', async (req, res) => {
  try {
    const db = req.app.locals.db, admin = req.app.locals.admin;
    const token = String(req.query.t || '');
    if (!token) return fail(res, 400, 'Thiếu mã nhiệm vụ');
    const snap = await db.collection('tasks').where('tokenHash', '==', sha(token)).limit(1).get();
    if (snap.empty) return fail(res, 400, 'Link nhiệm vụ không hợp lệ');
    const ref = snap.docs[0].ref;
    const now = Date.now();
    const out = await db.runTransaction(async tx => {
      const s = await tx.get(ref);
      const t = s.data();
      if (t.status === 'done') throw new Error('Nhiệm vụ này đã hoàn thành');
      if (t.status === 'expired' || toMs(t.expiresAt) <= now) throw new Error('Nhiệm vụ đã hết hạn, hãy tạo nhiệm vụ mới');
      if (t.status === 'issued' && t.keyCode) return { taskId: s.id, key: t.keyCode };
      if (now - toMs(t.createdAt) < MIN_WAIT_MS) throw new Error('Bạn vượt link quá nhanh, hãy xem đủ thời gian rồi thử lại');
      const key = `TDM-${rnd(4)}-${rnd(4)}`;
      tx.update(ref, { status: 'issued', keyCode: key, keyIssuedAt: admin.firestore.Timestamp.fromMillis(now) });
      return { taskId: s.id, key };
    });
    res.json(out);
  } catch (e) {
    fail(res, 400, e.message || 'Không xác nhận được');
  }
});

// 4. Nhập key tại đúng nhiệm vụ đó để nhận voucher. Key của nhiệm vụ khác sẽ bị từ chối.
router.post('/tasks/:id/redeem', verifyUser, async (req, res) => {
  try {
    const db = req.app.locals.db, admin = req.app.locals.admin, uid = req.user.uid;
    const key = String(req.body?.key || '').trim().toUpperCase();
    const ref = db.collection('tasks').doc(String(req.params.id));
    const now = Date.now();
    const snap = await ref.get();
    if (!snap.exists) return fail(res, 404, 'Không tìm thấy nhiệm vụ');
    const t = snap.data();
    if (t.uid !== uid) return fail(res, 403, 'Nhiệm vụ này không thuộc tài khoản của bạn');
    if (t.status === 'done') return fail(res, 400, 'Nhiệm vụ này đã hoàn thành');
    if (t.status !== 'issued' || !t.keyCode) return fail(res, 400, 'Bạn chưa vượt link của nhiệm vụ này');
    if (t.keyCode !== key) return fail(res, 400, 'Key không đúng với nhiệm vụ này');
    if (toMs(t.expiresAt) <= now) return fail(res, 400, 'Nhiệm vụ đã hết hạn');

    const code = 'VC' + rnd(6);
    await db.runTransaction(async tx => {
      const s = await tx.get(ref);
      if (s.data().status !== 'issued') throw new Error('Nhiệm vụ đã được xử lý');
      tx.update(ref, { status: 'done', doneAt: admin.firestore.FieldValue.serverTimestamp(), voucherCode: code });
    });
    await createVoucher(db, admin, { code, percent: VOUCHER_PERCENT, maxUses: 1, days: VOUCHER_DAYS }, 'task');
    await db.collection('user_vouchers').doc(`${uid}_${code}`).set({ uid, code, savedAt: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ code, percent: VOUCHER_PERCENT });
  } catch (e) {
    fail(res, 400, e.message || 'Không nhận được voucher');
  }
});

module.exports = router;
