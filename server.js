require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');

const path = require('path');
const servicesRouter = require('./services');
const orderRouter = require('./order');
const cronModule = require('./cron');
const cronRouter = cronModule;
const depositRouter = require('./deposit');

const app = express();
const PORT = Number(process.env.PORT || 8080);

if (!admin.apps.length) {
  const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!rawServiceAccount) {
    throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_JSON');
  }
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(rawServiceAccount);
  } catch (error) {
    throw new Error(`Invalid FIREBASE_SERVICE_ACCOUNT_JSON: ${error.message}`);
  }
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();
const auth = admin.auth();

app.locals.db = db;
app.locals.auth = auth;
app.locals.admin = admin;

app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({
  crossOriginResourcePolicy: false,
  contentSecurityPolicy: false
}));
app.use(cors({
  origin: (origin, callback) => {
    const allowed = (process.env.CORS_ORIGINS || 'https://tdms1vn.vercel.app').split(',').map(v => v.trim()).filter(Boolean);
    if (!origin || allowed.length === 0 || allowed.includes('*') || allowed.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('CORS origin denied'));
  },
  credentials: false
}));
app.use('/api/deposits/gateway/callback', express.raw({ type: '*/*', limit: '256kb' }));
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' }
});

const mutationLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' }
});

app.use('/api', publicLimiter);
app.use('/api/orders', mutationLimiter);
app.use('/api/deposits', mutationLimiter);

async function verifyToken(req, res, next) {
  const header = req.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }
  const token = header.slice(7).trim();
  if (!token) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }
  try {
    const decoded = await auth.verifyIdToken(token, true);
    req.user = decoded;
    return next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired authorization token' });
  }
}

app.locals.verifyToken = verifyToken;

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'TDMS1VN', time: new Date().toISOString() });
});

app.get('/api/public/stats', async (req, res) => {
  try {
    const [usersSnap, ordersSnap, completedSnap] = await Promise.all([
      db.collection('users').count().get(),
      db.collection('orders').count().get(),
      db.collection('orders').where('status', '==', 'Completed').count().get()
    ]);
    res.json({ users: usersSnap.data().count, orders: ordersSnap.data().count, completed: completedSnap.data().count });
  } catch (error) {
    console.error('public stats:', error.message);
    res.status(500).json({ error: 'Không lấy được thống kê' });
  }
});

app.get('/api/config/public', (req, res) => {
  res.json({
    telegram: process.env.ADMIN_TELEGRAM_HANDLE || '@ducmanh2109',
    email: process.env.ADMIN_EMAIL || 'tranvanmanhbg123bg@gmail.com',
    bank: {
      bankBin: process.env.BANK_BIN || '',
      accountNumber: process.env.BANK_ACCOUNT_NUMBER || '',
      accountName: process.env.BANK_ACCOUNT_NAME || '',
      qrTemplate: process.env.BANK_QR_TEMPLATE || 'compact2'
    },
    currency: process.env.CURRENCY || 'VND'
  });
});

app.use('/api/services', servicesRouter);
app.use('/api/orders', orderRouter);
app.use('/api/cron', cronRouter);
app.use('/api/deposits', depositRouter);

const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir, { extensions: ['html'] }));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  return res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'Internal server error' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`TDMS1VN full-stack server listening on ${PORT}`);
    const interval = Number(process.env.ORDER_SYNC_INTERVAL_MS || 300000);
    if (Number.isFinite(interval) && interval >= 60000) {
      setInterval(() => {
        cronModule.runScheduledSync(db, admin).catch(error => console.error('scheduled order sync:', error));
      }, interval).unref();
    }
  });
}

module.exports = app;
