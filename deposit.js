const express = require('express');
const axios = require('axios');
const router = express.Router();

const DEFAULT_CARD_TYPES = ['Viettel','Vinaphone','Mobifone','Vietnamobile','Zing','Gate','Garena','Vcoin','Funtap'];
const DEFAULT_AMOUNTS = [10000,20000,30000,50000,100000,200000,300000,500000,1000000];

function configuredCardTypes() {
  const raw = String(process.env.CARD_TYPES || '').trim();
  return new Set((raw ? raw.split(',') : DEFAULT_CARD_TYPES).map(v => v.trim()).filter(Boolean));
}
function configuredAmounts() {
  const raw = String(process.env.CARD_DENOMINATIONS || '').trim();
  return new Set((raw ? raw.split(',') : DEFAULT_AMOUNTS.map(String)).map(v => Number.parseInt(v.trim(), 10)).filter(v => Number.isSafeInteger(v) && v > 0));
}
function requireUser(req, res, next) { return req.app.locals.verifyToken(req, res, next); }
function telegramClient() {
  const botToken = String(process.env.ADMIN_TELEGRAM_BOT_TOKEN || '').trim();
  if (!botToken) throw new Error('ADMIN_TELEGRAM_BOT_TOKEN is not configured');
  return axios.create({ baseURL: `https://api.telegram.org/bot${botToken}`, timeout: 15000 });
}
function esc(value) { return String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function cardCredit(faceValue) { const discount = Number(process.env.CARD_DISCOUNT_PERCENT || 30); return Math.round(Number(faceValue) * (1 - discount / 100)); }
function bankCredit(amount) { return Number(amount); }
async function telegram(method, payload) {
  const response = await telegramClient().post(`/${method}`, payload);
  if (!response.data?.ok) throw new Error(response.data?.description || `Telegram ${method} failed`);
  return response.data.result;
}
async function notifyAdminTelegram(text) {
  const chatId = String(process.env.ADMIN_TELEGRAM_CHAT_ID || '').trim();
  if (!chatId) throw new Error('ADMIN_TELEGRAM_CHAT_ID is not configured');
  return telegram('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' });
}
async function getProfile(db, uid) {
  const snap = await db.collection('users').doc(uid).get();
  const data = snap.exists ? (snap.data() || {}) : {};
  return { email:String(data.email||''), username:String(data.username||''), name:String(data.name||'') };
}
async function createDepositAndNotify({db,admin,uid,type,amount,extra}) {
  const profile = await getProfile(db, uid);
  const depositRef = db.collection('deposits').doc();
  const faceValue = Number(amount);
  const creditPreview = type === 'card' ? cardCredit(faceValue) : bankCredit(faceValue);
  const base = {
    uid, type, amount:faceValue, creditedAmount:creditPreview, status:'Chờ duyệt',
    email:profile.email, username:profile.username, name:profile.name, ...extra,
    adminNotified:false, createdAt:admin.firestore.FieldValue.serverTimestamp(), updatedAt:admin.firestore.FieldValue.serverTimestamp()
  };
  await depositRef.create(base);
  const lines = [
    '<b>TDMS1VN — YÊU CẦU NẠP TIỀN</b>',
    `ID: <code>${esc(depositRef.id)}</code>`,
    `Gmail: <code>${esc(profile.email || '—')}</code>`,
    `Username: <code>${esc(profile.username || '—')}</code>`,
    `Mệnh giá: <b>${faceValue.toLocaleString('vi-VN')}đ</b>`,
    type === 'card' ? `Loại thẻ: <b>${esc(extra.cardType)}</b>` : 'Phương thức: <b>Chuyển khoản ngân hàng</b>',
    type === 'card' ? `Số Seri: <code>${esc(extra.serial)}</code>` : '',
    type === 'card' ? `Mã thẻ: <code>${esc(extra.code)}</code>` : '',
    type === 'card' ? `Thực nhận sau CK 30%: <b>${creditPreview.toLocaleString('vi-VN')}đ</b>` : `Thực nhận 100%: <b>${creditPreview.toLocaleString('vi-VN')}đ</b>`,
    '',
    'Duyệt thủ công bằng Admin Bot: /pay username số_tiền'
  ].filter(Boolean).join('\n');
  let notified = false, lastError = '';
  for (let attempt=1; attempt<=3; attempt++) {
    try { await notifyAdminTelegram(lines); notified=true; break; }
    catch(error) { lastError=error.message; console.error(`Telegram notification attempt ${attempt}:`, error.message); if(attempt<3) await new Promise(r=>setTimeout(r,1000*attempt)); }
  }
  await depositRef.update({ adminNotified:notified, adminNotificationError:notified?admin.firestore.FieldValue.delete():lastError, updatedAt:admin.firestore.FieldValue.serverTimestamp() });
  return { id:depositRef.id, adminNotified:notified };
}

router.post('/cards', requireUser, async (req,res) => {
  const db=req.app.locals.db, admin=req.app.locals.admin, uid=req.user.uid;
  const {cardType,serial,code,amount}=req.body||{};
  const normalizedAmount=Number.parseInt(amount,10);
  const type=String(cardType||'').trim(), serialClean=String(serial||'').trim(), codeClean=String(code||'').trim();
  if(!configuredCardTypes().has(type)||!configuredAmounts().has(normalizedAmount)||!serialClean||!codeClean) return res.status(400).json({error:'Loại thẻ hoặc mệnh giá không hợp lệ'});
  if(serialClean.length>100||codeClean.length>100) return res.status(400).json({error:'Thông tin thẻ quá dài'});
  try {
    const result=await createDepositAndNotify({db,admin,uid,type:'card',amount:normalizedAmount,extra:{cardType:type,serial:serialClean,code:codeClean,discountPercent:Number(process.env.CARD_DISCOUNT_PERCENT || 30)}});
    res.status(201).json({ok:true,depositId:result.id,adminNotified:result.adminNotified,faceValue:normalizedAmount,creditedAmount:cardCredit(normalizedAmount),discountPercent:Number(process.env.CARD_DISCOUNT_PERCENT || 30)});
  } catch(error) { console.error('deposit card:',error); res.status(500).json({error:'Không thể gửi yêu cầu nạp thẻ'}); }
});

router.post('/bank', requireUser, async (req,res) => {
  const db=req.app.locals.db, admin=req.app.locals.admin, uid=req.user.uid;
  const amount=Number.parseInt(req.body?.amount,10);
  if(!Number.isSafeInteger(amount)||amount<1000||amount>100000000) return res.status(400).json({error:'Số tiền chuyển khoản không hợp lệ'});
  try {
    const result=await createDepositAndNotify({db,admin,uid,type:'bank',amount,extra:{paymentMethod:'bank_transfer',discountPercent:0,transferContent:String(uid)}});
    res.status(201).json({ok:true,depositId:result.id,adminNotified:result.adminNotified,faceValue:amount,creditedAmount:amount,discountPercent:0});
  } catch(error) { console.error('deposit bank:',error); res.status(500).json({error:'Không thể tạo yêu cầu nạp chuyển khoản'}); }
});

router.get('/', requireUser, async (req,res) => {
  try {
    const snap=await req.app.locals.db.collection('deposits').where('uid','==',req.user.uid).limit(100).get();
    const deposits=snap.docs.map(d=>{const x={...d.data()}; delete x.code; return {id:d.id,...x};}).sort((a,b)=>(b.createdAt?.toMillis?.()||0)-(a.createdAt?.toMillis?.()||0));
    res.json({deposits});
  } catch(error) { console.error('deposit list:',error); res.status(500).json({error:'Không thể lấy lịch sử nạp tiền'}); }
});

module.exports = router;
module.exports.cardCredit = cardCredit;
module.exports.bankCredit = bankCredit;
