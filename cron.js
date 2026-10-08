'use strict';

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { syncOrders } = require('./order-sync');
const { syncServices } = require('./services');

const LOCK_TTL_MS = Math.min(Math.max(Number(process.env.SYNC_LOCK_TTL_MS || 10 * 60 * 1000), 60_000), 30 * 60 * 1000);

function cronGuard(req, res, next) {
  const secret = String(process.env.CRON_SECRET || '').trim();
  if (!secret) return res.status(503).json({ error: 'CRON_SECRET not configured' });
  const supplied = String(req.get('X-Cron-Secret') || req.query.secret || '').trim();
  if (!supplied || supplied !== secret) return res.status(401).json({ error: 'Invalid cron secret' });
  next();
}

async function withFirestoreLock(db, admin, name, fn) {
  const ref = db.collection('system_locks').doc(name);
  const owner = crypto.randomUUID();
  const now = Date.now();
  const expiresAtMs = now + LOCK_TTL_MS;
  const acquired = await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const data = snap.exists ? (snap.data() || {}) : {};
    const currentExpiry = data.expiresAt?.toMillis ? data.expiresAt.toMillis() : Number(data.expiresAtMs || 0);
    if (data.owner && currentExpiry > now) return false;
    tx.set(ref, {
      owner,
      acquiredAt: admin.firestore.Timestamp.fromMillis(now),
      expiresAt: admin.firestore.Timestamp.fromMillis(expiresAtMs),
      expiresAtMs,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return true;
  });
  if (!acquired) return { skipped: true, reason: 'already-running' };
  try {
    return await fn();
  } finally {
    try {
      await db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (snap.exists && snap.data()?.owner === owner) tx.delete(ref);
      });
    } catch (error) {
      console.error(`release ${name} lock:`, error?.message || error);
    }
  }
}

async function runScheduledSync(db, admin) {
  return withFirestoreLock(db, admin, 'ordersSync', () => syncOrders({ db, admin, limit: 100 }));
}

async function runScheduledServiceSync(db, admin) {
  return withFirestoreLock(db, admin, 'servicesSync', async () => {
    const services = await syncServices(db, true);
    return { serviceCount: services.length };
  });
}

router.get('/sync-orders', (req, res, next) => req.app.locals.verifyToken(req, res, next), async (req, res) => {
  try {
    const result = await syncOrders({ db: req.app.locals.db, admin: req.app.locals.admin, uid: req.user.uid, limit: req.query.limit });
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('user sync orders:', error);
    res.status(502).json({ ok: false, error: 'Không đồng bộ được đơn hàng', detail: error?.message || 'Provider/Firestore error' });
  }
});

router.post('/sync-orders', cronGuard, async (req, res) => {
  try {
    const result = await runScheduledSync(req.app.locals.db, req.app.locals.admin);
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('cron sync orders:', error);
    res.status(502).json({ ok: false, error: 'Không đồng bộ được đơn hàng', detail: error?.message || 'Provider/Firestore error' });
  }
});

router.post('/sync-services', cronGuard, async (req, res) => {
  try {
    const result = await runScheduledServiceSync(req.app.locals.db, req.app.locals.admin);
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('cron sync services:', error);
    res.status(502).json({ ok: false, error: 'Không đồng bộ được dịch vụ Provider', detail: error?.message || 'Provider/Firestore error' });
  }
});

module.exports = router;
module.exports.runScheduledSync = runScheduledSync;
module.exports.runScheduledServiceSync = runScheduledServiceSync;
