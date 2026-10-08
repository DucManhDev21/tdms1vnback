const express = require('express');
const { providerAddOrder } = require('./provider');
const crypto = require('crypto');
const router = express.Router();
const { getServices } = require('./services');
const { calculateTotal, roundMoney } = require('./pricing');

function requireUser(req, res, next) {
  return req.app.locals.verifyToken(req, res, next);
}

function requestId(req) {
  return String(req.get('Idempotency-Key') || crypto.randomUUID());
}

function parseProviderOrderId(data) {
  const value = data?.order ?? data?.order_id ?? data?.id;
  return value == null ? '' : String(value);
}

function normalizeProviderStatus(value) {
  const s = String(value || '').toLowerCase();
  if (s.includes('complete')) return 'Completed';
  if (s.includes('partial')) return 'Partial';
  if (s.includes('cancel')) return 'Canceled';
  if (s.includes('progress')) return 'In progress';
  return 'Pending';
}

async function createProviderOrder({ serviceId, link, quantity }) {
  const data = await providerAddOrder({ service: serviceId, link, quantity });
  const providerOrderId = parseProviderOrderId(data);
  if (!providerOrderId) {
    const message = data?.error || data?.message || 'Provider không trả về mã đơn hàng';
    throw new Error(String(message));
  }
  return providerOrderId;
}

router.post('/', requireUser, async (req, res) => {
  const db = req.app.locals.db;
  const admin = req.app.locals.admin;
  const uid = req.user.uid;
  const idem = requestId(req);
  const { serviceId, link, quantity } = req.body || {};

  const parsedServiceId = Number.parseInt(serviceId, 10);
  const parsedQuantity = Number.parseInt(quantity, 10);
  if (!Number.isInteger(parsedServiceId) || !link || !Number.isInteger(parsedQuantity) || parsedQuantity <= 0) {
    return res.status(400).json({ error: 'Thiếu hoặc sai dữ liệu đặt hàng' });
  }
  if (String(link).length > 2000) return res.status(400).json({ error: 'Link quá dài' });

  try {
    const services = await getServices(false, db);
    const service = services.find(v => v.service === parsedServiceId);
    if (!service) return res.status(400).json({ error: 'Dịch vụ không tồn tại' });
    const min = Number.parseInt(service.min, 10);
    const max = Number.parseInt(service.max, 10);
    if (parsedQuantity < min || parsedQuantity > max) {
      return res.status(400).json({ error: `Số lượng phải từ ${min} đến ${max}` });
    }
    const rate = Number.parseFloat(service.unitRateVnd ?? service.rate);
    if (!Number.isFinite(rate) || rate < 0) return res.status(400).json({ error: 'Giá dịch vụ không hợp lệ' });
    const totalPrice = calculateTotal(rate, parsedQuantity);
    if (!Number.isFinite(totalPrice) || totalPrice < 0) return res.status(400).json({ error: 'Giá dịch vụ không hợp lệ' });

    const idemRef = db.collection('order_requests').doc(`${uid}_${idem.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)}`);
    const result = await db.runTransaction(async tx => {
      const existingReq = await tx.get(idemRef);
      if (existingReq.exists) {
        const existing = existingReq.data();
        return { duplicate: true, orderId: existing.orderId };
      }
      const userRef = db.collection('users').doc(uid);
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) throw Object.assign(new Error('User not found'), { code: 'USER_NOT_FOUND' });
      const user = userSnap.data();
      const oldBalance = Number(user.balance || 0);
      if (oldBalance < totalPrice) throw Object.assign(new Error('Số dư không đủ'), { code: 'INSUFFICIENT_BALANCE' });

      const orderRef = db.collection('orders').doc();
      const newBalance = oldBalance - totalPrice;
      tx.update(userRef, { balance: newBalance });
      tx.set(orderRef, {
        uid,
        username: String(user.username || ''),
        email: String(user.email || req.user.email || ''),
        serviceId: parsedServiceId,
        serviceName: service.name,
        platform: service.platform,
        category: service.category,
        type: service.type,
        link: String(link).trim(),
        quantity: parsedQuantity,
        totalPrice,
        rate,
        unitRateVnd: rate,
        providerRate: service.providerRate ?? null,
        providerRateMode: service.providerRateMode ?? null,
        providerUnitRateVnd: service.providerUnitRateVnd ?? service.providerRate ?? null,
        sellingRateVnd: service.sellingRateVnd ?? rate,
        markupPercent: service.markupPercent ?? 0,
        fixedUnitRateVnd: service.fixedUnitRateVnd ?? null,
        providerOrderId: '',
        status: 'AwaitingProvider',
        providerCallStartedAt: admin.firestore.FieldValue.serverTimestamp(),
        remains: parsedQuantity,
        refill: service.refill,
        cancel: service.cancel,
        idempotencyKey: idem,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      const logRef = db.collection('balance_logs').doc();
      tx.set(logRef, {
        uid,
        amount: -totalPrice,
        type: 'debit',
        reason: `Đặt đơn ${orderRef.id}`,
        oldBalance,
        newBalance,
        orderId: orderRef.id,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      tx.set(idemRef, {
        uid,
        orderId: orderRef.id,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return { duplicate: false, orderId: orderRef.id };
    });

    if (result.duplicate) return res.status(200).json({ ok: true, duplicate: true, orderId: result.orderId });

    try {
      const providerOrderId = await createProviderOrder({ serviceId: parsedServiceId, link: String(link).trim(), quantity: parsedQuantity });
      await db.collection('orders').doc(result.orderId).update({ providerOrderId, status: 'Pending', providerCallCompletedAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      return res.status(201).json({ ok: true, orderId: result.orderId, providerOrderId, totalPrice });
    } catch (providerError) {
      const orderRef = db.collection('orders').doc(result.orderId);
      await db.runTransaction(async tx => {
        const orderSnap = await tx.get(orderRef);
        if (!orderSnap.exists || orderSnap.data()?.refundSettledAt) return;
        const order = orderSnap.data() || {};
        const userRef = db.collection('users').doc(uid);
        const userSnap = await tx.get(userRef);
        if (!userSnap.exists) throw new Error('Không tìm thấy tài khoản để hoàn tiền');
        const oldBalance = Number(userSnap.data()?.balance || 0);
        const refund = roundMoney(Number(order.totalPrice || 0));
        const newBalance = roundMoney(oldBalance + refund);
        tx.update(userRef, { balance: newBalance, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        tx.update(orderRef, { status: 'Canceled', remains: Number(order.quantity || 0), providerError: true, refundAmount: refund, refundSettledAt: admin.firestore.FieldValue.serverTimestamp(), cancelReason: String(providerError.message || 'Provider error').slice(0, 500), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        const logRef = db.collection('balance_logs').doc();
        tx.set(logRef, { uid, amount: refund, type: 'credit', reason: `Hoàn tiền đơn ${result.orderId}: Provider error`, oldBalance, newBalance, orderId: result.orderId, createdAt: admin.firestore.FieldValue.serverTimestamp() });
      });
      return res.status(502).json({ error: 'Provider lỗi, hệ thống đã hoàn tiền 100%', refunded: true, orderId: result.orderId });
    }
  } catch (error) {
    if (error.code === 'INSUFFICIENT_BALANCE') return res.status(400).json({ error: 'Số dư không đủ' });
    if (error.code === 'USER_NOT_FOUND') return res.status(404).json({ error: 'Tài khoản chưa được khởi tạo' });
    console.error('order create:', error);
    return res.status(500).json({ error: 'Không thể tạo đơn hàng' });
  }
});

router.get('/', requireUser, async (req, res) => {
  const db = req.app.locals.db;
  const uid = req.user.uid;
  try {
    const snap = await db.collection('orders').where('uid', '==', uid).limit(100).get();
    const orders = snap.docs.map(doc => ({ id: doc.id, ...doc.data() })).sort((a, b) => {
      const ta = a.createdAt?.toMillis ? a.createdAt.toMillis() : new Date(a.createdAt || 0).getTime();
      const tb = b.createdAt?.toMillis ? b.createdAt.toMillis() : new Date(b.createdAt || 0).getTime();
      return tb - ta;
    });
    res.json({ orders });
  } catch (error) {
    console.error('orders list:', error);
    res.status(500).json({ error: 'Không thể lấy đơn hàng' });
  }
});

module.exports = router;
