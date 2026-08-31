const express = require('express');
const axios = require('axios');
const router = express.Router();
const { getServices } = require('./services');

function providerClient() {
  const baseURL = process.env.PROVIDER_API_URL;
  const key = process.env.PROVIDER_API_KEY;
  if (!baseURL || !key) throw new Error('Provider API is not configured');
  return axios.create({ baseURL, timeout: Number(process.env.PROVIDER_TIMEOUT_MS || 20000) });
}

function normalizeStatus(value) {
  const s = String(value || '').toLowerCase();
  if (s.includes('complete')) return 'Completed';
  if (s.includes('partial')) return 'Partial';
  if (s.includes('cancel')) return 'Canceled';
  if (s.includes('progress')) return 'In progress';
  return 'Pending';
}

async function providerStatus(providerOrderId) {
  const client = providerClient();
  const body = new URLSearchParams({ key: process.env.PROVIDER_API_KEY, action: 'status', order: String(providerOrderId) });
  const response = await client.post('', body.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  const data = response.data || {};
  return {
    status: normalizeStatus(data.status),
    remains: Number.parseInt(data.remains ?? 0, 10),
    charge: Number.parseFloat(data.charge ?? 0),
    raw: data
  };
}

async function applyPartialRefund(db, admin, doc, newStatus, newRemains) {
  const orderRef = doc.ref;
  await db.runTransaction(async tx => {
    const fresh = await tx.get(orderRef);
    if (!fresh.exists) return;
    const order = fresh.data();
    if (order.refundSettledAt) {
      tx.update(orderRef, { status: newStatus, remains: newRemains, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      return;
    }
    const originalQty = Number(order.quantity || 0);
    const remains = Math.max(0, Math.min(originalQty, Number(newRemains || 0)));
    const rate = Number(order.rate ?? (Number(order.totalPrice || 0) / Math.max(1, originalQty)));
    const refund = remains * rate;
    const userRef = db.collection('users').doc(order.uid);
    const userSnap = await tx.get(userRef);
    const oldBalance = Number(userSnap.data()?.balance || 0);
    const newBalance = oldBalance + refund;
    if (refund > 0) {
      tx.update(userRef, { balance: newBalance });
      const logRef = db.collection('balance_logs').doc();
      tx.set(logRef, {
        uid: order.uid,
        amount: refund,
        type: 'credit',
        reason: `Hoàn tiền ${newStatus} đơn ${fresh.id}`,
        oldBalance,
        newBalance,
        orderId: fresh.id,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
    tx.update(orderRef, {
      status: newStatus,
      remains,
      refundAmount: refund,
      refundSettledAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });
}

async function syncOrders(req, res) {
  const db = req.app.locals.db;
  const admin = req.app.locals.admin;
  const limit = Math.min(Number.parseInt(req.query.limit || 50, 10), 100);
  try {
    const services = await getServices(false);
    const serviceMap = new Map(services.map(s => [String(s.service), s]));
    let query = req.syncUid
      ? db.collection('orders').where('uid', '==', req.syncUid).limit(Math.min(limit * 3, 300))
      : db.collection('orders').where('status', 'in', ['Pending', 'In progress', 'Partial']).limit(limit);
    const rawSnap = await query.get();
    const docs = req.syncUid ? rawSnap.docs.filter(d => ['Pending', 'In progress', 'Partial'].includes(String(d.data().status))) : rawSnap.docs;
    const selectedDocs = docs.slice(0, limit);
    const snap = { docs: selectedDocs, size: selectedDocs.length };
    let updated = 0;
    for (const doc of snap.docs) {
      const order = doc.data();
      if (!order.providerOrderId) continue;
      try {
        const provider = await providerStatus(order.providerOrderId);
        const service = serviceMap.get(String(order.serviceId));
        const fallbackRate = Number(service?.rate ?? order.rate ?? (Number(order.totalPrice || 0) / Math.max(1, Number(order.quantity || 1))));
        const remains = Number.isFinite(provider.remains) ? Math.max(0, provider.remains) : Number(order.remains || 0);
        if ((provider.status === 'Canceled' || provider.status === 'Partial') && !order.refundSettledAt) {
          await applyPartialRefund(db, admin, doc, provider.status, remains);
        } else {
          await doc.ref.update({
            status: provider.status,
            remains,
            rate: fallbackRate,
            providerRawStatus: provider.raw,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }
        updated += 1;
      } catch (error) {
        await doc.ref.update({ lastProviderError: error.message, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      }
    }
    res.json({ ok: true, checked: snap.size, updated });
  } catch (error) {
    console.error('sync orders:', error);
    res.status(500).json({ error: 'Không đồng bộ được đơn hàng' });
  }
}

function cronGuard(req, res, next) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(503).json({ error: 'CRON_SECRET not configured' });
  const supplied = req.get('X-Cron-Secret') || req.query.secret || '';
  if (supplied !== secret) return res.status(401).json({ error: 'Invalid cron secret' });
  next();
}

router.get('/sync-orders', (req, res, next) => req.app.locals.verifyToken(req, res, next), async (req, res) => {
  req.syncUid = req.user.uid;
  return syncOrders(req, res);
});

router.post('/sync-orders', cronGuard, syncOrders);

module.exports = router;


let syncRunning = false;

async function runScheduledSync(db, admin) {
  if (syncRunning) return { skipped: true };
  syncRunning = true;
  try {
    const services = await getServices(false);
    const serviceMap = new Map(services.map(s => [String(s.service), s]));
    const snap = await db.collection('orders').where('status', 'in', ['Pending', 'In progress', 'Partial']).limit(100).get();
    let updated = 0;
    for (const doc of snap.docs) {
      const order = doc.data();
      if (!order.providerOrderId) continue;
      try {
        const provider = await providerStatus(order.providerOrderId);
        const service = serviceMap.get(String(order.serviceId));
        const fallbackRate = Number(service?.rate ?? order.rate ?? (Number(order.totalPrice || 0) / Math.max(1, Number(order.quantity || 1))));
        const remains = Number.isFinite(provider.remains) ? Math.max(0, provider.remains) : Number(order.remains || 0);
        if ((provider.status === 'Canceled' || provider.status === 'Partial') && !order.refundSettledAt) {
          await applyPartialRefund(db, admin, doc, provider.status, remains);
        } else {
          await doc.ref.update({ status: provider.status, remains, rate: fallbackRate, providerRawStatus: provider.raw, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        }
        updated += 1;
      } catch (error) {
        await doc.ref.update({ lastProviderError: error.message, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      }
    }
    return { checked: snap.size, updated };
  } finally {
    syncRunning = false;
  }
}

module.exports.runScheduledSync = runScheduledSync;

