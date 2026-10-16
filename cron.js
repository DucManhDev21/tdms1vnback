'use strict';

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { syncOrders } = require('./order-sync');
const { syncServices } = require('./services');

// VÔ HIỆU HÓA HOÀN TOÀN CRON TỰ ĐỘNG ĐỂ BẢO VỆ QUOTA FIREBASE
async function runScheduledSync(db, admin) {
  return { skipped: true, reason: 'cron-disabled-by-user' };
}

async function runScheduledServiceSync(db, admin) {
  return { skipped: true, reason: 'cron-disabled-by-user', serviceCount: 0 };
}

// Giữ lại API cho phép User chủ động bấm nút kiểm tra/đồng bộ đơn hàng cá nhân của họ
router.get('/sync-orders', (req, res, next) => req.app.locals.verifyToken(req, res, next), async (req, res) => {
  try {
    const result = await syncOrders({ db: req.app.locals.db, admin: req.app.locals.admin, uid: req.user.uid, limit: req.query.limit });
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('user sync orders:', error);
    res.status(502).json({ ok: false, error: 'Không đồng bộ được đơn hàng', detail: error?.message || 'Provider/Firestore error' });
  }
});

// Khóa endpoint POST cron tự động bên ngoài, trả về thông báo đã tắt để tránh ghi rác database
router.post('/sync-orders', (req, res) => {
  res.json({ ok: false, skipped: true, message: 'Cron sync orders is disabled.' });
});

router.post('/sync-services', (req, res) => {
  res.json({ ok: false, skipped: true, message: 'Cron sync services is disabled.' });
});

module.exports = router;
module.exports.runScheduledSync = runScheduledSync;
module.exports.runScheduledServiceSync = runScheduledServiceSync;
