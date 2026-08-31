const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const router = express.Router();
const { getServices } = require('./services');

function providerClient() {
  const baseURL = process.env.PROVIDER_API_URL;
  const key = process.env.PROVIDER_API_KEY;
  if (!baseURL || !key) throw new Error('Provider API is not configured');
  return axios.create({ baseURL, timeout: Number(process.env.PROVIDER_TIMEOUT_MS || 20000) });
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
  const client = providerClient();
  const body = new URLSearchParams({
    key: process.env.PROVIDER_API_KEY,
    action: 'add',
    service: String(serviceId),
    link,
    quantity: String(quantity)
  });
  const response = await client.post('', body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  const providerOrderId = parseProviderOrderId(response.data);
  if (!providerOrderId) {
    const message = response.data?.error || response.data?.message || 'Provider did not return an order id';
    throw new Error(String(message));
  }
  return providerOrderId;
}

async function refundCanceledOrder(db, admin, orderId, reason) {
  const orderRef = db.collection('orders').doc(orderId);
  await db.runTransaction(async tx => {
    const snap = await tx.get(orderRef);
    if (!snap.exists) throw new Error('Order not found during refund');
    const order = snap.data();
    if (order.refundedAt) return;
    const userRef = db.collection('users').doc(order.uid);
    const userSnap = await tx.get(userRef);
    const user = userSnap.exists ? userSnap.data() : { balance: 0 };
    const oldBalance = Number(user.balance || 0);
    const refund = Number(order.totalPrice || 0);
    const newBalance = oldBalance + refund;
    tx.update(userRef, { balance: newBalance });
    tx.update(orderRef, {
      status: 'Canceled',
      remains: Number(order.quantity || 0),
      refundedAt: admin.firestore.FieldValue.serverTimestamp(),
      refundAmount: refund,
      cancelReason: reason
    });
    const logRef = db.collection('balance_logs').doc();
    tx.set(logRef, {
      uid: order.uid,
      amount: refund,
      type: 'credit',
      reason: `Hoàn tiền đơn ${orderId}: ${reason}`,
      oldBalance,
      newBalance,
      orderId,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });
}

router.post('/', async (req, res) => {
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
    const services = await getServices(false);
    const service = services.find(v => v.service === parsedServiceId);
    if (!service) return res.status(400).json({ error: 'Dịch vụ không tồn tại' });
    const min = Number.parseInt(service.min, 10);
    const max = Number.parseInt(service.max, 10);
    if (parsedQuantity < min || parsedQuantity > max) {
      return res.status(400).json({ error: `Số lượng phải từ ${min} đến ${max}` });
    }
    const rate = Number.parseFloat(service.rate);
    const totalPrice = parsedQuantity * rate;
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
        serviceId: parsedServiceId,
        serviceName: service.name,
        platform: service.platform,
        category: service.category,
        type: service.type,
        link: String(link).trim(),
        quantity: parsedQuantity,
        totalPrice,
        rate,
        providerOrderId: '',
        status: 'Pending',
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
      await db.collection('orders').doc(result.orderId).update({ providerOrderId, status: 'Pending', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      return res.status(201).json({ ok: true, orderId: result.orderId, providerOrderId, totalPrice });
    } catch (providerError) {
      await refundCanceledOrder(db, admin, result.orderId, providerError.message || 'Provider error');
      return res.status(502).json({ error: 'Provider lỗi, hệ thống đã hoàn tiền 100%', refunded: true, orderId: result.orderId });
    }
  } catch (error) {
    if (error.code === 'INSUFFICIENT_BALANCE') return res.status(400).json({ error: 'Số dư không đủ' });
    if (error.code === 'USER_NOT_FOUND') return res.status(404).json({ error: 'Tài khoản chưa được khởi tạo' });
    console.error('order create:', error);
    return res.status(500).json({ error: 'Không thể tạo đơn hàng' });
  }
});

router.get('/', async (req, res) => {
  const db = req.app.locals.db;
  const uid = req.user.uid;
  try {
    const snap = await db.collection('orders').where('uid', '==', uid).orderBy('createdAt', 'desc').limit(100).get();
    const orders = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ orders });
  } catch (error) {
    console.error('orders list:', error);
    res.status(500).json({ error: 'Không thể lấy đơn hàng' });
  }
});

module.exports = router;
