require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');

const servicesRouter = require('./services');
const orderRouter = require('./order');
const cronModule = require('./cron');
const servicesModule = require('./services');
const { getPricingOverrides, parseMarkup, roundMoney } = require('./pricing');
const depositRouter = require('./deposit');
const { startAdminBot } = require('./admin-bot');
const { ensureOwnerAdmin, isAdmin, listAdmins, addAdmin, deleteAdmin } = require('./admins');
const { providerConfig, providerServices } = require('./provider');

const app = express();
const PORT = Number(process.env.PORT || 8080);
const APP_VERSION = String(process.env.APP_VERSION || '12.2.0').trim() || '12.2.0';

if (!admin.apps.length) {
  const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!rawServiceAccount) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_JSON');
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(rawServiceAccount);
  } catch (error) {
    throw new Error(`Invalid FIREBASE_SERVICE_ACCOUNT_JSON: ${error.message}`);
  }
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
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

const DEFAULT_CORS_ORIGINS = [
  'https://tdms1vip.vercel.app',
  'http://localhost:3000',
  'http://localhost:5173'
];

const allowedCorsOrigins = new Set(
  String(process.env.CORS_ORIGINS || '')
    .split(',')
    .map(v => v.trim().replace(/\/$/, ''))
    .filter(Boolean)
);

for (const origin of DEFAULT_CORS_ORIGINS) allowedCorsOrigins.add(origin);

if (process.env.CORS_ORIGINS === '*') allowedCorsOrigins.add('*');

function isAllowedOrigin(origin) {
  return !origin || allowedCorsOrigins.has('*') || allowedCorsOrigins.has(origin);
}

// Explicit CORS headers are set before every route so even API errors keep the
// Access-Control-Allow-Origin header and the browser can expose the response.
app.use((req, res, next) => {
  const origin = req.get('Origin');
  if (isAllowedOrigin(origin)) {
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    else if (allowedCorsOrigins.has('*')) res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key, X-Cron-Secret, X-Telegram-Bot-Api-Secret-Token, X-Deposit-Signature');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') {
    if (!isAllowedOrigin(origin)) return res.status(403).json({ error: 'CORS origin denied' });
    return res.status(204).end();
  }
  next();
});

app.use(cors({
  origin: (origin, callback) => callback(null, isAllowedOrigin(origin)),
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Cron-Secret', 'X-Telegram-Bot-Api-Secret-Token', 'X-Deposit-Signature'],
  credentials: false,
  maxAge: 86400
}));

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
  if (!token) return res.status(401).json({ error: 'Missing authorization token' });
  try {
    req.user = await auth.verifyIdToken(token, true);
    return next();
  } catch (error) {
    console.error('verify token:', error.message);
    return res.status(401).json({ error: 'Invalid or expired authorization token' });
  }
}

app.locals.verifyToken = verifyToken;

function errorInfo(error) {
  return { code: error?.code || error?.name || 'UNKNOWN_ERROR', message: String(error?.message || 'Unknown error') };
}
function serializeDeep(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date || (value && typeof value.toDate === 'function')) {
    try { return value instanceof Date ? value.toISOString() : value.toDate().toISOString(); } catch { return String(value); }
  }
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(v => serializeDeep(v, seen));
  const out={}; for (const [k,v] of Object.entries(value)) out[k]=serializeDeep(v,seen); return out;
}
function jsonSafe(res,payload,status=200){
  try{return res.status(status).json(serializeDeep(payload));}
  catch(error){console.error('json serialization failure:',errorInfo(error));return res.status(200).json({ok:true,degraded:true,code:'JSON_SERIALIZATION_FALLBACK',error:'Không thể tuần tự hóa một phần dữ liệu.'});}
}


app.get('/health', (req, res) => {
  res.set('Cache-Control','no-store');
  res.json({ ok: true, service: 'TDMS1VN', version: APP_VERSION, time: new Date().toISOString() });
});

app.get('/api/health', (req,res) => {
  res.set('Cache-Control','no-store');
  res.set('X-TDMS-Version', APP_VERSION);
  res.json({ ok:true, service:'TDMS1VN API', version:APP_VERSION, providerConfigured:Boolean(String(process.env.PROVIDER_API_URL||'').trim()&&String(process.env.PROVIDER_API_KEY||'').trim()), time:new Date().toISOString() });
});

app.get('/api/version', (req,res) => {
  res.set('Cache-Control','no-store');
  res.json({ ok:true, service:'TDMS1VN API', version:APP_VERSION, providerApiUrl:String(process.env.PROVIDER_API_URL||'').trim()||null, providerConfigured:Boolean(String(process.env.PROVIDER_API_URL||'').trim()&&String(process.env.PROVIDER_API_KEY||'').trim()), time:new Date().toISOString() });
});

app.get('/api/ping', (req,res) => res.json({ ok:true, time:new Date().toISOString() }));

app.get('/api/system/status', async (req, res) => {
  try {
    await db.collection('users').limit(1).get();
    res.set('Cache-Control','no-store');
    res.json({
      ok: true,
      api: 'online',
      firestore: 'online',
      adminTelegramBot: Boolean(String(process.env.ADMIN_TELEGRAM_BOT_TOKEN || '').trim()),
      pricing: { providerRateMode: process.env.PROVIDER_RATE_MODE || 'USD_PER_1000', displayUnit: 'VND/1', defaultMarkupPercent: Number(process.env.SERVICE_MARKUP_PERCENT || 0) },
      time: new Date().toISOString()
    });
  } catch (error) {
    console.error('system status:', error);
    res.status(503).json({ ok:false, api:'online', firestore:'error', error:'Firestore unavailable' });
  }
});

// API root must be a real API response. The old server tried to serve
// /public/index.html here, but the Railway backend repository does not contain
// a public/ directory because the SPA is deployed separately on Vercel.
app.get('/api', (req, res) => {
  res.json({
    ok: true,
    service: 'TDMS1VN API',
    version: APP_VERSION,
    frontend: 'https://tdms1vip.vercel.app',
    endpoints: ['/health', '/api/config/public', '/api/public/stats', '/api/services', '/api/orders', '/api/deposits', '/api/balance-logs', '/api/me', '/api/admin/session','/api/admin/dashboard','/api/admin/diagnostics','/api/admin/provider/test','/api/admin/orders/sync']
  });
});


const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();

app.get('/api/admin/session', verifyToken, async (req, res) => {
  try {
    const userRecord = await auth.getUser(req.user.uid);
    const email = String(userRecord.email || '').trim().toLowerCase();
    if (!email) return res.status(403).json({ ok:false, error:'Tài khoản chưa có email.' });
    if (userRecord.disabled) return res.status(403).json({ ok:false, error:'Tài khoản đã bị vô hiệu hóa.' });
    if (!userRecord.emailVerified) return res.status(403).json({ ok:false, error:'Gmail chưa được xác minh trên Firebase.' });
    try {
      const allowed = await isAdmin(db, email);
      if (!allowed) return res.status(403).json({ ok:false, error:'Tài khoản này không nằm trong danh sách Admin.' });
    } catch (dependencyError) {
      console.error('admin session dependency:', dependencyError?.code || 'unknown', dependencyError?.message || dependencyError);
      if (email !== ADMIN_EMAIL) return res.status(503).json({ ok:false, error:'Dịch vụ phân quyền Admin tạm thời không khả dụng.', code:'ADMIN_AUTH_DEPENDENCY_UNAVAILABLE' });
    }
    res.set('Cache-Control','no-store');
    res.json({ ok:true, admin:true, uid:userRecord.uid, email:userRecord.email, degraded: false });
  } catch (error) {
    console.error('admin session:', error);
    res.status(503).json({ ok:false, error:'Máy chủ Admin tạm thời không thể xác thực phiên.', code:error?.code || 'ADMIN_SESSION_UNAVAILABLE' });
  }
});

async function requireAdmin(req, res, next) {
  const email = String(req.user?.email || '').trim().toLowerCase();
  if (!email) return res.status(403).json({ ok:false, error:'Tài khoản không có email.' });
  try {
    if (await isAdmin(db, email)) return next();
    return res.status(403).json({ ok:false, error:'Bạn không có quyền Admin.' });
  } catch (error) {
    console.error('requireAdmin:', error?.code || 'unknown', error?.message || error);
    // The permanent owner can still enter the control center if Firestore is temporarily unavailable.
    // Other admins cannot be safely authorized without the admins collection.
    if (email === ADMIN_EMAIL) return next();
    return res.status(503).json({ ok:false, error:'Dịch vụ phân quyền Admin tạm thời không khả dụng.', code:'ADMIN_AUTH_DEPENDENCY_UNAVAILABLE' });
  }
}

app.get('/api/admin/admins', verifyToken, requireAdmin, async (req, res) => {
  try {
    const items = await listAdmins(db);
    res.set('Cache-Control','no-store');
    res.json({ ok:true, total:items.length, items });
  } catch (error) {
    console.error('admin list:', error);
    res.status(500).json({ ok:false, error:'Không thể tải danh sách Admin.' });
  }
});

app.post('/api/admin/admins', verifyToken, requireAdmin, async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim();
    if (!email) return res.status(400).json({ ok:false, error:'Vui lòng nhập email Admin.' });
    const item = await addAdmin(db, admin, email, { source:'web_admin', email:req.user.email || '', uid:req.user.uid });
    res.status(201).json({ ok:true, item });
  } catch (error) {
    console.error('admin add:', error);
    res.status(400).json({ ok:false, error:error.message || 'Không thể thêm Admin.' });
  }
});

app.delete('/api/admin/admins/:email', verifyToken, requireAdmin, async (req, res) => {
  try {
    const email = decodeURIComponent(String(req.params.email || '')).trim();
    const deleted = await deleteAdmin(db, admin, email, { source:'web_admin', email:req.user.email || '', uid:req.user.uid });
    res.json({ ok:true, email:deleted });
  } catch (error) {
    console.error('admin delete:', error);
    res.status(400).json({ ok:false, error:error.message || 'Không thể xóa Admin.' });
  }
});

app.get('/api/admin/audit-logs', verifyToken, requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit || '100', 10) || 100, 1), 300);
    const snap = await db.collection('admin_audit_logs').limit(limit).get();
    const items = snap.docs.map(serializeDoc).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
    res.set('Cache-Control','no-store');
    res.json({ ok:true, total:items.length, items });
  } catch (error) {
    console.error('admin audit logs:', error);
    res.status(500).json({ ok:false, error:'Không thể tải nhật ký Admin.' });
  }
});

app.get('/api/admin/balance-logs', verifyToken, requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit || '100', 10) || 100, 1), 300);
    const snap = await db.collection('balance_logs').limit(limit).get();
    const items = snap.docs.map(serializeDoc).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
    res.set('Cache-Control','no-store');
    res.json({ ok:true, total:items.length, items });
  } catch (error) {
    console.error('admin balance logs:', error);
    res.status(500).json({ ok:false, error:'Không thể tải biến động số dư.' });
  }
});

app.get('/api/admin/system', verifyToken, requireAdmin, async (req, res) => {
  try {
    const [healthSnap, syncSnap] = await Promise.all([
      db.collection('system').doc('health').get(),
      db.collection('system').doc('serviceSync').get()
    ]);
    const recentAudit = await db.collection('admin_audit_logs').limit(10).get();
    const admins = await listAdmins(db);
    res.set('Cache-Control','no-store');
    res.json({
      ok:true,
      api:{version:APP_VERSION, node:process.version, environment:process.env.NODE_ENV || 'production'},
      firebase:{projectId:process.env.FIREBASE_PROJECT_ID || null, configured:Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)},
      provider:{configured:Boolean(process.env.PROVIDER_API_URL && process.env.PROVIDER_API_KEY), baseUrl:process.env.PROVIDER_API_URL || null},
      telegram:{configured:Boolean(String(process.env.ADMIN_TELEGRAM_BOT_TOKEN || '').trim()), chatConfigured:Boolean(String(process.env.ADMIN_TELEGRAM_CHAT_ID || '').trim())},
      cors:{origins:Array.from(allowedCorsOrigins).filter(x=>x!=='*')},
      pricing:{mode:process.env.PROVIDER_RATE_MODE || 'USD_PER_1000', defaultMarkupPercent:Number(process.env.SERVICE_MARKUP_PERCENT || 0)},
      bank:{accountName:process.env.BANK_ACCOUNT_NAME || '', accountNumber:process.env.BANK_ACCOUNT_NUMBER || '', bankBin:process.env.BANK_BIN || ''},
      serviceSync:syncSnap.exists ? serializeData(syncSnap.data()) : {},
      healthDoc:healthSnap.exists ? serializeData(healthSnap.data()) : {},
      adminCount:admins.length,
      recentAudit:recentAudit.docs.map(serializeDoc).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')))
    });
  } catch (error) {
    console.error('admin system:', error);
    return jsonSafe(res,{ok:true,degraded:true,error:'Không thể tải đầy đủ thông tin hệ thống.',warnings:[errorInfo(error).message]},200);
  }
});

app.get('/api/admin/users', verifyToken, requireAdmin, async (req,res) => {
  try {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit || '100',10) || 100,1),200);
    const snap = await db.collection('users').limit(limit).get();
    res.json({ ok:true, total:snap.size, items:snap.docs.map(serializeDoc) });
  } catch(error) { console.error('admin users:',error); return jsonSafe(res,{ok:true,degraded:true,total:0,items:[],warnings:[errorInfo(error).message],code:errorInfo(error).code},200); }
});

app.get('/api/admin/orders', verifyToken, requireAdmin, async (req,res) => {
  try {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit || '100',10) || 100,1),200);
    const snap = await db.collection('orders').limit(limit).get();
    res.json({ ok:true, total:snap.size, items:snap.docs.map(serializeDoc).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||''))) });
  } catch(error) { console.error('admin orders:',error); return jsonSafe(res,{ok:true,degraded:true,total:0,items:[],warnings:[errorInfo(error).message],code:errorInfo(error).code},200); }
});

app.get('/api/admin/deposits', verifyToken, requireAdmin, async (req,res) => {
  try {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit || '100',10) || 100,1),200);
    const snap = await db.collection('deposits').limit(limit).get();
    const items = snap.docs.map(serializeDoc).map(x=>{ delete x.code; return x; }).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
    res.json({ ok:true, total:items.length, items });
  } catch(error) { console.error('admin deposits:',error); return jsonSafe(res,{ok:true,degraded:true,total:0,items:[],warnings:[errorInfo(error).message],code:errorInfo(error).code},200); }
});

app.get('/api/admin/popups', verifyToken, requireAdmin, async (req,res) => {
  try {
    const snap = await db.collection('popups').limit(50).get();
    const items = snap.docs.map(serializeDoc).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
    res.json({ok:true,total:items.length,items});
  } catch(error) { console.error('admin popups:',error); return jsonSafe(res,{ok:true,degraded:true,total:0,items:[],warnings:[errorInfo(error).message],code:errorInfo(error).code},200); }
});

app.post('/api/admin/popups', verifyToken, requireAdmin, async (req,res) => {
  try {
    const id = String(req.body?.id||'').trim();
    const title = String(req.body?.title||'Thông Báo Chung').trim();
    const content = String(req.body?.content||'');
    const active = req.body?.active !== false;
    if(!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return res.status(400).json({ok:false,error:'ID Popup không hợp lệ.'});
    if(!title || title.length>200 || !content || content.length>5000) return res.status(400).json({ok:false,error:'Tiêu đề hoặc nội dung không hợp lệ.'});
    const ref=db.collection('popups').doc(id);
    await ref.set({id,title,content,active,updatedAt:admin.firestore.FieldValue.serverTimestamp(),createdAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
    res.status(201).json({ok:true,id});
  } catch(error) { console.error('admin popup write:',error); res.status(500).json({ok:false,error:'Không thể lưu Popup.'}); }
});

app.delete('/api/admin/popups/:id', verifyToken, requireAdmin, async (req,res) => {
  try {
    const id=String(req.params.id||'').trim();
    if(!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return res.status(400).json({ok:false,error:'ID Popup không hợp lệ.'});
    await db.collection('popups').doc(id).delete();
    res.json({ok:true});
  } catch(error) { console.error('admin popup delete:',error); res.status(500).json({ok:false,error:'Không thể xóa Popup.'}); }
});

app.post('/api/admin/users/balance', verifyToken, requireAdmin, async (req,res) => {
  try {
    const username=String(req.body?.username||'').replace(/^@/,'').trim();
    const amount=Number(req.body?.amount);
    const reason=String(req.body?.reason||'Admin web điều chỉnh số dư').trim().slice(0,200);
    if(!/^[a-zA-Z0-9_]{3,24}$/.test(username) || !Number.isFinite(amount) || amount===0 || Math.abs(amount)>1000000000) return res.status(400).json({ok:false,error:'Username hoặc số tiền không hợp lệ.'});
    const key=username.toLowerCase();
    const map=await db.collection('usernames').doc(key).get();
    let uid=map.exists?String(map.data()?.uid||''):'';
    if(!uid){const exact=await db.collection('users').where('usernameLower','==',key).limit(1).get();if(exact.empty)return res.status(404).json({ok:false,error:'Không tìm thấy username.'});uid=exact.docs[0].id;}
    const userRef=db.collection('users').doc(uid);
    const result=await db.runTransaction(async tx=>{
      const snap=await tx.get(userRef);if(!snap.exists)throw new Error('Tài khoản không tồn tại.');
      const data=snap.data()||{};const oldBalance=Number(data.balance||0);if(!Number.isFinite(oldBalance))throw new Error('Số dư hiện tại không hợp lệ.');
      const newBalance=Math.round((oldBalance+amount)*100)/100;if(newBalance<0)throw new Error('Không thể trừ quá số dư hiện tại.');
      const logRef=db.collection('balance_logs').doc();tx.update(userRef,{balance:newBalance,updatedAt:admin.firestore.FieldValue.serverTimestamp()});tx.set(logRef,{uid,amount,type:amount>0?'credit':'debit',reason,oldBalance,newBalance,adminAction:'web_admin',adminUid:req.user.uid,createdAt:admin.firestore.FieldValue.serverTimestamp()});return {username:String(data.username||username),email:String(data.email||''),oldBalance,newBalance};
    });
    res.json({ok:true,balance:result.newBalance,...result});
  } catch(error){console.error('admin balance:',error);res.status(400).json({ok:false,error:error.message||'Không thể điều chỉnh số dư.'});}
});


async function adminDashboard(db) {
  const warnings=[];
  const result={users:0,orders:0,deposits:0,popups:0,completed:0,processing:0,canceled:0,orderRevenue:0,completedRevenue:0,approvedDepositCredit:0,warnings};
  async function safeCount(name){
    try{const c=db.collection(name);if(typeof c.count==='function'){try{const x=await c.count().get();return Number(x.data()?.count||0);}catch(error){warnings.push(`${name}:count:${errorInfo(error).code}`);}}const x=await c.limit(5000).get();if(x.size>=5000)warnings.push(`${name}:estimate_limited_5000`);return x.size;}
    catch(error){warnings.push(`${name}:unavailable:${errorInfo(error).code}`);return 0;}
  }
  async function safeDocs(name,limit=2000){try{const x=await db.collection(name).limit(limit).get();if(x.size>=limit)warnings.push(`${name}:snapshot_limit_${limit}`);return x;}catch(error){warnings.push(`${name}:unavailable:${errorInfo(error).code}`);return null;}}
  const counts=await Promise.allSettled([safeCount('users'),safeCount('orders'),safeCount('deposits'),safeCount('popups')]);
  result.users=counts[0].status==='fulfilled'?counts[0].value:0;result.orders=counts[1].status==='fulfilled'?counts[1].value:0;result.deposits=counts[2].status==='fulfilled'?counts[2].value:0;result.popups=counts[3].status==='fulfilled'?counts[3].value:0;
  const [or,dr]=await Promise.allSettled([safeDocs('orders'),safeDocs('deposits')]);
  for(const doc of (or.status==='fulfilled'?or.value:null)?.docs||[]){try{const d=doc.data()||{},st=String(d.status||'').trim().toLowerCase(),v=Number(d.totalPrice??d.price??0);if(st==='completed')result.completed++;else if(['pending','in progress','partial','processing'].includes(st))result.processing++;else if(['canceled','cancelled'].includes(st))result.canceled++;if(Number.isFinite(v)&&v>=0){result.orderRevenue+=v;if(st==='completed')result.completedRevenue+=v;}}catch{warnings.push(`order:${doc.id}:invalid`);}}
  for(const doc of (dr.status==='fulfilled'?dr.value:null)?.docs||[]){try{const d=doc.data()||{},v=Number(d.creditedAmount??d.amount??0),st=String(d.status||'').trim().toLowerCase();if(['đã duyệt','approved','completed'].includes(st)&&Number.isFinite(v))result.approvedDepositCredit+=v;}catch{warnings.push(`deposit:${doc.id}:invalid`);}}
  result.orderRevenue=roundMoney(result.orderRevenue);result.completedRevenue=roundMoney(result.completedRevenue);result.approvedDepositCredit=roundMoney(result.approvedDepositCredit);return result;
}

app.get('/api/admin/dashboard', verifyToken, requireAdmin, async (req,res)=>{
  const safe={ok:true,degraded:false,users:0,orders:0,deposits:0,popups:0,completed:0,processing:0,canceled:0,orderRevenue:0,completedRevenue:0,approvedDepositCredit:0,serviceSync:{},warnings:[]};
  try{Object.assign(safe,await adminDashboard(db));}catch(error){console.error('admin dashboard core:',errorInfo(error));safe.degraded=true;safe.warnings.push(`core:${errorInfo(error).code}`);}
  try{const snap=await db.collection('system').doc('serviceSync').get();safe.serviceSync=snap.exists?serializeData(snap.data()||{}):{};}catch(error){console.error('dashboard serviceSync:',errorInfo(error));safe.degraded=true;safe.warnings.push(`system/serviceSync:${errorInfo(error).code}`);}
  safe.degraded=Boolean(safe.degraded||safe.warnings.length);safe.generatedAt=new Date().toISOString();res.set('Cache-Control','no-store');return jsonSafe(res,safe,200);
});

app.get('/api/admin/provider/test', verifyToken, requireAdmin, async (req, res) => {
  try {
    const cfg = providerConfig();
    const data = await providerServices();
    if (!Array.isArray(data)) throw new Error('Provider không trả về mảng services');
    return jsonSafe(res, { ok: true, provider: true, endpoint: cfg.url, serviceCount: data.length }, 200);
  } catch (error) {
    console.error('provider test GET:', errorInfo(error));
    return jsonSafe(res, {
      ok: false,
      provider: false,
      code: error?.providerCode || error?.code || 'PROVIDER_ERROR',
      httpStatus: error?.providerStatus || null,
      error: error?.message || 'Provider test failed'
    }, 200);
  }
});

app.post('/api/admin/provider/test', verifyToken, requireAdmin, async (req, res) => {
  try {
    const cfg = providerConfig();
    const data = await providerServices();
    if (!Array.isArray(data)) throw new Error('Provider không trả về mảng services');
    return jsonSafe(res, { ok:true, provider:true, endpoint:cfg.url, serviceCount:data.length }, 200);
  } catch (error) {
    console.error('provider test:', errorInfo(error));
    return jsonSafe(res, { ok:false, provider:false, code:error?.providerCode || error?.code || 'PROVIDER_ERROR', httpStatus:error?.providerStatus || null, error:error?.message || 'Provider test failed' }, 200);
  }
});

app.get('/api/admin/diagnostics', verifyToken, requireAdmin, async (req,res)=>{
  const r={ok:true,version:APP_VERSION,node:process.version,environment:process.env.NODE_ENV||'production',checks:{},warnings:[]};
  r.checks.firebaseAuth={configured:Boolean(admin.apps.length)};r.checks.adminEmail={configured:Boolean(ADMIN_EMAIL),value:ADMIN_EMAIL||null};
  r.checks.provider={configured:Boolean(String(process.env.PROVIDER_API_URL||'').trim()&&String(process.env.PROVIDER_API_KEY||'').trim()),baseUrl:String(process.env.PROVIDER_API_URL||'').trim()||null};
  r.checks.telegram={configured:Boolean(String(process.env.ADMIN_TELEGRAM_BOT_TOKEN||'').trim()),chatConfigured:Boolean(String(process.env.ADMIN_TELEGRAM_CHAT_ID||'').trim())};
  try{await db.collection('admins').limit(1).get();r.checks.firestore={reachable:true};}catch(error){r.checks.firestore={reachable:false,code:errorInfo(error).code,message:errorInfo(error).message};r.warnings.push('Firestore unavailable');}
  try{const x=await db.collection('service_catalog').limit(1).get();r.checks.serviceCatalog={reachable:true,hasData:!x.empty};}catch(error){r.checks.serviceCatalog={reachable:false,code:errorInfo(error).code};r.warnings.push('Service catalog unavailable');}
  r.degraded=r.warnings.length>0;return jsonSafe(res,r,200);
});

app.post('/api/admin/orders/sync', verifyToken, requireAdmin, async (req,res)=>{
  try{return jsonSafe(res,{ok:true,...(await cronModule.runScheduledSync(db,admin))},200);}catch(error){console.error('admin order sync:',errorInfo(error));return jsonSafe(res,{ok:true,degraded:true,code:'ORDER_SYNC_UNAVAILABLE',error:errorInfo(error).message,checked:0,updated:0,refunded:0},200);}
});

function serializeData(data) {
  const result={...(data||{})};for(const key of Object.keys(result)){const value=result[key];if(value&&typeof value.toDate==='function')result[key]=value.toDate().toISOString();}return result;
}

app.get('/api/admin/services', verifyToken, requireAdmin, async (req, res) => {
  try {
    const services = await servicesModule.getServices(req.query.refresh === '1', db);
    const overrides = await getPricingOverrides(db);
    const items = services.map(service => ({ ...service, pricingOverride: overrides.get(String(service.service)) || null }));
    res.json({ ok: true, total: items.length, items, defaultMarkupPercent: Number(process.env.SERVICE_MARKUP_PERCENT || 0) });
  } catch (error) {
    console.error('admin services:', error);
    return jsonSafe(res,{ok:true,degraded:true,total:0,items:[],warnings:[errorInfo(error).message],code:'SERVICE_CATALOG_UNAVAILABLE'},200);
  }
});

app.post('/api/admin/services/sync', verifyToken, requireAdmin, async (req, res) => {
  try {
    const services = await servicesModule.syncServices(db, true);
    res.json({ ok: true, serviceCount: services.length, markupPercent: Number(process.env.SERVICE_MARKUP_PERCENT || 0), syncedAt: new Date().toISOString() });
  } catch (error) {
    console.error('admin service sync:', error);
    return jsonSafe(res,{ok:true,degraded:true,serviceCount:0,items:[],providerUnavailable:true,code:'PROVIDER_UNAVAILABLE',error:errorInfo(error).message},200);
  }
});

app.post('/api/admin/services/:serviceId/pricing', verifyToken, requireAdmin, async (req, res) => {
  try {
    const serviceId = Number.parseInt(req.params.serviceId, 10);
    if (!Number.isSafeInteger(serviceId)) return res.status(400).json({ ok: false, error: 'Service ID không hợp lệ.' });
    const markupPercent = parseMarkup(req.body?.markupPercent, Number(process.env.SERVICE_MARKUP_PERCENT || 0));
    let fixedUnitRateVnd = null;
    if (req.body?.fixedUnitRateVnd !== undefined && req.body?.fixedUnitRateVnd !== null && String(req.body.fixedUnitRateVnd).trim() !== '') {
      fixedUnitRateVnd = Number(req.body.fixedUnitRateVnd);
      if (!Number.isFinite(fixedUnitRateVnd) || fixedUnitRateVnd < 0) return res.status(400).json({ ok: false, error: 'Giá bán cố định không hợp lệ.' });
      fixedUnitRateVnd = roundMoney(fixedUnitRateVnd);
    }
    const enabled = req.body?.enabled !== false;
    await db.collection('service_pricing').doc(String(serviceId)).set({
      serviceId,
      markupPercent,
      fixedUnitRateVnd,
      enabled,
      updatedBy: req.user.uid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    await db.collection('admin_audit_logs').add({
      action: 'service_pricing_update',
      serviceId,
      markupPercent,
      fixedUnitRateVnd,
      enabled,
      adminUid: req.user.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    await servicesModule.syncServices(db, true);
    res.json({ ok: true, serviceId, markupPercent, fixedUnitRateVnd, enabled });
  } catch (error) {
    console.error('admin pricing:', error);
    res.status(500).json({ ok: false, error: 'Không thể cập nhật giá dịch vụ.' });
  }
});

app.delete('/api/admin/services/:serviceId/pricing', verifyToken, requireAdmin, async (req, res) => {
  try {
    const serviceId = Number.parseInt(req.params.serviceId, 10);
    if (!Number.isSafeInteger(serviceId)) return res.status(400).json({ ok: false, error: 'Service ID không hợp lệ.' });
    await db.collection('service_pricing').doc(String(serviceId)).delete();
    await db.collection('admin_audit_logs').add({ action: 'service_pricing_reset', serviceId, adminUid: req.user.uid, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    await servicesModule.syncServices(db, true);
    res.json({ ok: true, serviceId });
  } catch (error) {
    console.error('admin pricing reset:', error);
    res.status(500).json({ ok: false, error: 'Không thể đặt lại giá dịch vụ.' });
  }
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
    console.error('public stats:', error);
    res.status(500).json({ error: 'Không lấy được thống kê' });
  }
});

app.get('/api/config/public', (req, res) => {
  res.json({
    telegram: process.env.ADMIN_TELEGRAM_HANDLE || '',
    email: process.env.ADMIN_EMAIL || '',
    bank: {
      bankBin: process.env.BANK_BIN || '',
      accountNumber: process.env.BANK_ACCOUNT_NUMBER || '',
      accountName: process.env.BANK_ACCOUNT_NAME || '',
      qrTemplate: process.env.BANK_QR_TEMPLATE || 'compact2'
    },
    currency: process.env.CURRENCY || 'VND',
    cardTypes: String(process.env.CARD_TYPES || 'Viettel,Vinaphone,Mobifone,Vietnamobile,Zing,Gate,Garena').split(',').map(v => v.trim()).filter(Boolean),
    cardDenominations: String(process.env.CARD_DENOMINATIONS || '10000,20000,30000,50000,100000,200000,300000,500000,1000000').split(',').map(v => Number.parseInt(v.trim(), 10)).filter(v => Number.isInteger(v) && v > 0),
    cardDiscountPercent: Number(process.env.CARD_DISCOUNT_PERCENT || 30),
    bankCreditPercent: 100,
    pricing: { providerRateMode: process.env.PROVIDER_RATE_MODE || 'USD_PER_1000', displayUnit: 'VND/1', defaultMarkupPercent: Number(process.env.SERVICE_MARKUP_PERCENT || 0) }, adminTelegramBot: Boolean(String(process.env.ADMIN_TELEGRAM_BOT_TOKEN || '').trim())
  });
});

app.use('/api/services', servicesRouter);
app.use('/api/orders', orderRouter);
app.use('/api/cron', cronModule);
app.use('/api/deposits', depositRouter);

app.post('/api/account/profile', verifyToken, async (req, res) => {
  const uid = req.user.uid;
  const username = String(req.body?.username || '').trim();
  if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
    return res.status(400).json({ error: 'Username phải 3-24 ký tự, chỉ gồm chữ, số và dấu gạch dưới' });
  }
  const key = username.toLowerCase();
  try {
    await db.runTransaction(async tx => {
      const userRef = db.collection('users').doc(uid);
      const usernameRef = db.collection('usernames').doc(key);
      const userSnap = await tx.get(userRef);
      const usernameSnap = await tx.get(usernameRef);
      if (usernameSnap.exists && String(usernameSnap.data()?.uid || '') !== uid) {
        throw Object.assign(new Error('Username đã được sử dụng'), { code: 'USERNAME_TAKEN' });
      }
      const oldUsername = String(userSnap.data()?.username || '').trim();
      if (oldUsername && oldUsername.toLowerCase() !== key) {
        const oldRef = db.collection('usernames').doc(oldUsername.toLowerCase());
        const oldSnap = await tx.get(oldRef);
        if (oldSnap.exists && String(oldSnap.data()?.uid || '') === uid) tx.delete(oldRef);
      }
      tx.set(usernameRef, { uid, username, email: req.user.email || '', updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      tx.set(userRef, { uid, email: req.user.email || '', username, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    });
    res.json({ ok: true, username });
  } catch (error) {
    if (error.code === 'USERNAME_TAKEN') return res.status(409).json({ error: error.message });
    console.error('profile:', error);
    res.status(500).json({ error: 'Không thể lưu username' });
  }
});


// Compatibility aliases: some older frontend deployments requested /account/profile
// directly. Keep them available while the canonical API remains /api/account/profile.
app.post('/account/profile', verifyToken, async (req, res) => {
  const uid = req.user.uid;
  const username = String(req.body?.username || '').trim();
  if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
    return res.status(400).json({ error: 'Username phải 3-24 ký tự, chỉ gồm chữ, số và dấu gạch dưới' });
  }
  const key = username.toLowerCase();
  try {
    await db.runTransaction(async tx => {
      const userRef = db.collection('users').doc(uid);
      const usernameRef = db.collection('usernames').doc(key);
      const userSnap = await tx.get(userRef);
      const usernameSnap = await tx.get(usernameRef);
      if (usernameSnap.exists && String(usernameSnap.data()?.uid || '') !== uid) {
        throw Object.assign(new Error('Username đã được sử dụng'), { code: 'USERNAME_TAKEN' });
      }
      const oldUsername = String(userSnap.data()?.username || '').trim();
      if (oldUsername && oldUsername.toLowerCase() !== key) {
        const oldRef = db.collection('usernames').doc(oldUsername.toLowerCase());
        const oldSnap = await tx.get(oldRef);
        if (oldSnap.exists && String(oldSnap.data()?.uid || '') === uid) tx.delete(oldRef);
      }
      tx.set(usernameRef, { uid, username, email: req.user.email || '', updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      tx.set(userRef, { uid, email: req.user.email || '', username, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    });
    res.json({ ok: true, username });
  } catch (error) {
    if (error.code === 'USERNAME_TAKEN') return res.status(409).json({ error: error.message });
    console.error('profile alias:', error);
    res.status(500).json({ error: 'Không thể lưu username' });
  }
});

app.get('/account/profile', verifyToken, async (req, res) => {
  try {
    const snap = await db.collection('users').doc(req.user.uid).get();
    const user = snap.exists ? snap.data() : { uid: req.user.uid, email: req.user.email || '', balance: 0 };
    res.json({ uid: req.user.uid, user });
  } catch (error) {
    console.error('profile alias get:', error);
    res.status(500).json({ error: 'Không thể lấy thông tin tài khoản' });
  }
});

app.get('/api/account/profile', verifyToken, async (req, res) => {
  try {
    const snap = await db.collection('users').doc(req.user.uid).get();
    const user = snap.exists ? snap.data() : { uid: req.user.uid, email: req.user.email || '', balance: 0 };
    res.json({ uid: req.user.uid, user });
  } catch (error) {
    console.error('profile get:', error);
    res.status(500).json({ error: 'Không thể lấy thông tin tài khoản' });
  }
});

app.get('/api/balance-logs', verifyToken, async (req, res) => {
  try {
    const snap = await db.collection('balance_logs').where('uid', '==', req.user.uid).limit(100).get();
    const logs = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => {
      const ta = a.createdAt?.toMillis ? a.createdAt.toMillis() : new Date(a.createdAt || 0).getTime();
      const tb = b.createdAt?.toMillis ? b.createdAt.toMillis() : new Date(b.createdAt || 0).getTime();
      return tb - ta;
    });
    res.json({ logs });
  } catch (error) {
    console.error('balance logs:', error);
    res.status(500).json({ error: 'Không thể lấy biến động số dư' });
  }
});

app.get('/api/me', verifyToken, async (req, res) => {
  try {
    const snap = await db.collection('users').doc(req.user.uid).get();
    if (!snap.exists) return res.status(404).json({ error: 'Tài khoản chưa được khởi tạo' });
    res.json({ uid: req.user.uid, user: snap.data() });
  } catch (error) {
    console.error('me:', error);
    res.status(500).json({ error: 'Không thể lấy thông tin tài khoản' });
  }
});

// This backend is API-only. Do NOT call express.static() or sendFile() here.
// The frontend is hosted independently by Vercel.
app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found', path: req.path }));
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.use((error, req, res, next) => {
  console.error('Unhandled server error:', error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'Internal server error' });
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ ok:false, error:'API endpoint không tồn tại', path:req.path });
  return res.status(404).json({ ok:false, error:'Not found' });
});

app.use((error, req, res, next) => {
  console.error('unhandled express error:', errorInfo(error));
  if (res.headersSent) return next(error);
  return res.status(500).json({ ok:false, error:'Internal server error' });
});

if (require.main === module) {
  app.listen(PORT, async () => {
    console.log(`TDMS1VN API server listening on ${PORT}`);
    try {
      const owner = await ensureOwnerAdmin(db, admin);
      console.log(`Admin owner bootstrap ready: ${owner}`);
    } catch (error) {
      console.error('Admin bootstrap:', error.message);
    }
    startAdminBot(db, admin).catch(error => console.error('Admin Telegram bot startup:', error));
    const orderInterval = Number(process.env.ORDER_SYNC_INTERVAL_MS || 300000);
    if (Number.isFinite(orderInterval) && orderInterval >= 60000) {
      setInterval(() => {
        cronModule.runScheduledSync(db, admin).catch(error => console.error('scheduled order sync:', error));
      }, orderInterval).unref();
    }
    const serviceInterval = Number(process.env.SERVICE_AUTO_SYNC_INTERVAL_MS || 900000);
    if (Number.isFinite(serviceInterval) && serviceInterval >= 60000) {
      setInterval(() => {
        cronModule.runScheduledServiceSync(db, admin).catch(error => console.error('scheduled service sync:', error));
      }, serviceInterval).unref();
    }
    setTimeout(() => {
      cronModule.runScheduledServiceSync(db, admin).catch(error => console.error('initial service sync:', error));
    }, 5000).unref();
  });
}


module.exports = app;
