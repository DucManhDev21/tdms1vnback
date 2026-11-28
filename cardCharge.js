// Gửi thẻ cào lên gachthe47 (endpoint /chargingws/v2, form-data).
// Chưa có cách ký (sign) và địa chỉ API thật nên route sẽ báo lỗi cấu hình, không gửi đi.
const express = require('express');
const crypto = require('crypto');

const router = express.Router();
const TELCOS = new Set(['VIETTEL', 'MOBIFONE', 'VINAPHONE', 'ZING', 'GARENA', 'VCOIN', 'SCOIN']);
const VALUES = new Set([10000, 20000, 30000, 50000, 100000, 200000, 300000, 500000, 1000000]);
const CREDIT_RATE = 0.7;   // khách nhận 70% mệnh giá
const MAX_PENDING = 3;     // tối đa 3 thẻ đang chờ cho mỗi tài khoản

const verifyUser = (req, res, next) => req.app.locals.verifyToken(req, res, next);

// Chữ ký theo công thức gachthe47: md5(partner_key + code + serial)
function signRequest(fields) {
  const key = process.env.CARD_PARTNER_KEY;
  if (!key) throw new Error('Chưa cấu hình CARD_PARTNER_KEY');
  return crypto.createHash('md5').update(String(key) + String(fields.code) + String(fields.serial)).digest('hex');
}

router.post('/charge', verifyUser, async (req, res) => {
  const db = req.app.locals.db, admin = req.app.locals.admin, uid = req.user.uid;
  try {
    if (process.env.CARD_ENABLED !== 'true') return res.status(503).json({ error: 'Nạp thẻ đang tạm đóng' });
    const telco = String(req.body?.telco || '').trim().toUpperCase();
    const value = Number(req.body?.value);
    const serial = String(req.body?.serial || '').replace(/\s/g, '');
    const code = String(req.body?.code || '').replace(/\s/g, '');
    if (!TELCOS.has(telco)) return res.status(400).json({ error: 'Nhà mạng không hợp lệ' });
    if (!VALUES.has(value)) return res.status(400).json({ error: 'Mệnh giá không hợp lệ' });
    if (!/^\d{8,20}$/.test(serial)) return res.status(400).json({ error: 'Số seri không hợp lệ' });
    if (!/^\d{8,20}$/.test(code)) return res.status(400).json({ error: 'Mã thẻ không hợp lệ' });

    const pending = await db.collection('card_orders').where('uid', '==', uid).where('status', '==', 'pending').limit(MAX_PENDING + 1).get();
    if (pending.size >= MAX_PENDING) return res.status(429).json({ error: 'Bạn đang có quá nhiều thẻ chờ xử lý' });

    const requestId = crypto.randomBytes(12).toString('hex');
    const orderRef = db.collection('card_orders').doc(requestId);
    // Không lưu mã thẻ đầy đủ, chỉ lưu 4 số cuối
    await orderRef.set({
      uid, requestId, telco, declaredValue: value, expectedCredit: Math.round(value * CREDIT_RATE),
      serialLast4: serial.slice(-4), codeLast4: code.slice(-4), status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const fields = {
      telco, code, serial, amount: String(value), request_id: requestId,
      partner_id: process.env.CARD_PARTNER_ID || '', command: 'charging'
    };
    fields.sign = signRequest(fields);

    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    const r = await fetch(process.env.CARD_API_URL, { method: 'POST', body: form, signal: AbortSignal.timeout(20000) });
    const data = await r.json().catch(() => ({}));
    await orderRef.update({ transId: data.trans_id ?? null, providerStatus: data.status ?? null, providerMessage: data.message ?? null, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    return res.json({ requestId, status: 'pending', message: 'Đang xử lý thẻ, vui lòng chờ' });
  } catch (e) {
    console.error('card/charge:', e.message);
    return res.status(400).json({ error: e.message || 'Không gửi được thẻ' });
  }
});

module.exports = { router, CREDIT_RATE };
