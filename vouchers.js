const express = require('express');

const CODE_RE = /^[A-Z0-9_-]{3,32}$/;
const router = express.Router();

function requireUser(req, res, next) {
  return req.app.locals.verifyToken(req, res, next);
}

function normalizeCode(value) {
  return String(value || '').trim().toUpperCase();
}

function voucherError(message) {
  return Object.assign(new Error(message), { code: 'VOUCHER_INVALID' });
}

function toMillis(value) {
  if (value?.toMillis) return value.toMillis();
  return new Date(value || 0).getTime();
}

// Kiểm tra mã còn dùng được không (không kiểm tra việc user đã dùng chưa)
function assertUsable(voucher, now = Date.now()) {
  if (!voucher || voucher.active === false) throw voucherError('Mã giảm giá không tồn tại hoặc đã bị tắt.');
  if (toMillis(voucher.expiresAt) <= now) throw voucherError('Mã giảm giá đã hết hạn.');
  if (Number(voucher.usedCount || 0) >= Number(voucher.maxUses || 0)) throw voucherError('Mã giảm giá đã hết lượt dùng.');
}

function parseThemCode(text) {
  const p = String(text || '').trim().split(/\s+/);
  if (p.length !== 5) throw new Error('Cú pháp: /themcode CODE % lượt_dùng số_ngày\nVí dụ: /themcode SALE20 20 100 7');
  const code = normalizeCode(p[1]);
  if (!CODE_RE.test(code)) throw new Error('Mã chỉ gồm chữ, số, _ hoặc -, từ 3 đến 32 ký tự.');
  const percent = Number(String(p[2]).replace('%', ''));
  if (!Number.isInteger(percent) || percent < 1 || percent > 90) throw new Error('% giảm phải là số nguyên từ 1 đến 90.');
  const maxUses = Number(p[3]);
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000000) throw new Error('Lượt dùng phải là số nguyên từ 1 đến 1.000.000.');
  const days = Number(p[4]);
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error('Số ngày dùng phải là số nguyên từ 1 đến 3650.');
  return { code, percent, maxUses, days };
}

async function createVoucher(db, admin, data, createdBy) {
  const ref = db.collection('vouchers').doc(data.code);
  const expiresAt = new Date(Date.now() + data.days * 86400000);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (snap.exists) throw new Error(`Mã ${data.code} đã tồn tại.`);
    tx.create(ref, {
      code: data.code,
      percent: data.percent,
      maxUses: data.maxUses,
      usedCount: 0,
      days: data.days,
      expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
      active: true,
      createdBy: String(createdBy || ''),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });
  return { ...data, expiresAt };
}

function statusOf(voucher, used) {
  if (!voucher || voucher.active === false) return 'Đã tắt';
  if (toMillis(voucher.expiresAt) <= Date.now()) return 'Hết hạn';
  if (Number(voucher.usedCount || 0) >= Number(voucher.maxUses || 0)) return 'Hết lượt';
  if (used) return 'Đã dùng';
  return 'Có thể dùng';
}

// Kiểm tra mã khi người dùng bấm "Áp dụng" ở trang đặt hàng
router.post('/check', requireUser, async (req, res) => {
  try {
    const code = normalizeCode(req.body?.code);
    if (!CODE_RE.test(code)) return res.status(400).json({ error: 'Mã giảm giá không hợp lệ' });
    const db = req.app.locals.db;
    const [vSnap, useSnap] = [
      await db.collection('vouchers').doc(code).get(),
      await db.collection('voucher_uses').doc(`${code}_${req.user.uid}`).get()
    ];
    const v = vSnap.exists ? vSnap.data() : null;
    assertUsable(v);
    if (useSnap.exists) throw voucherError('Bạn đã sử dụng mã này rồi.');
    res.json({ code, percent: Number(v.percent) });
  } catch (error) {
    if (error.code === 'VOUCHER_INVALID') return res.status(400).json({ error: error.message });
    console.error('voucher check:', error);
    res.status(500).json({ error: 'Không kiểm tra được mã giảm giá' });
  }
});

// Lưu mã vào Kho voucher của người dùng
router.post('/save', requireUser, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const code = normalizeCode(req.body?.code);
    if (!CODE_RE.test(code)) return res.status(400).json({ error: 'Mã giảm giá không hợp lệ' });
    const vSnap = await db.collection('vouchers').doc(code).get();
    if (!vSnap.exists) return res.status(400).json({ error: 'Mã giảm giá không tồn tại' });
    const v = vSnap.data();
    if (v.active === false) return res.status(400).json({ error: 'Mã giảm giá đã bị tắt' });
    if (toMillis(v.expiresAt) <= Date.now()) return res.status(400).json({ error: 'Mã giảm giá đã hết hạn' });
    await db.collection('user_vouchers').doc(`${req.user.uid}_${code}`).set({
      uid: req.user.uid,
      code,
      savedAt: req.app.locals.admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    res.json({ ok: true, code });
  } catch (error) {
    console.error('voucher save:', error);
    res.status(500).json({ error: 'Không lưu được mã giảm giá' });
  }
});

// Danh sách Kho voucher kèm trạng thái
router.get('/mine', requireUser, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const uid = req.user.uid;
    const saved = await db.collection('user_vouchers').where('uid', '==', uid).limit(100).get();
    const codes = saved.docs.map(d => String(d.data().code || '')).filter(Boolean);
    if (!codes.length) return res.json({ vouchers: [] });
    const vRefs = codes.map(c => db.collection('vouchers').doc(c));
    const uRefs = codes.map(c => db.collection('voucher_uses').doc(`${c}_${uid}`));
    const [vSnaps, uSnaps] = [await db.getAll(...vRefs), await db.getAll(...uRefs)];
    const vouchers = codes.map((code, i) => {
      const v = vSnaps[i].exists ? vSnaps[i].data() : null;
      return {
        code,
        percent: v ? Number(v.percent) : 0,
        expiresAt: v?.expiresAt?.toDate ? v.expiresAt.toDate().toISOString() : null,
        status: statusOf(v, uSnaps[i].exists)
      };
    });
    res.json({ vouchers });
  } catch (error) {
    console.error('voucher mine:', error);
    res.status(500).json({ error: 'Không lấy được Kho voucher' });
  }
});

module.exports = { router, CODE_RE, normalizeCode, voucherError, assertUsable, parseThemCode, createVoucher };
