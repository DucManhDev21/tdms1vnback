const axios = require('axios');
const crypto = require('crypto');
const { sendDiscordDM } = require('./discordBot');

const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const KEY_RE = /^TDMS-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

// Bộ đếm nhập sai lưu trong bộ nhớ: không tốn lượt ghi Firestore
const attempts = new Map();

function api() {
  const token = process.env.ADMIN_TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  return axios.create({ baseURL: `https://api.telegram.org/bot${token}`, timeout: 10000 });
}

async function sendToChat(chatId, text) {
  const c = api();
  if (!c || !chatId) return;
  await c.post('/sendMessage', { chat_id: String(chatId), text }).catch(e => console.error('Telegram send:', e.message));
}

function sha256(v) { return crypto.createHash('sha256').update(v).digest('hex'); }

function toMs(v) {
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v._seconds != null) return v._seconds * 1000;
  return new Date(v).getTime() || 0;
}

function vnd(n) { return `${Math.round(Number(n || 0)).toLocaleString('vi-VN')}đ`; }

function randomKey() {
  const part = () => Array.from({ length: 4 }, () => KEY_ALPHABET[crypto.randomInt(KEY_ALPHABET.length)]).join('');
  return `TDMS-${part()}-${part()}-${part()}`;
}

// Mỗi tài khoản một mã, không hết hạn. Tạo mã mới thì mã cũ bị vô hiệu.
// Firestore chỉ lưu hash của mã, mã gốc chỉ hiện một lần.
async function createLinkKey(db, admin, uid) {
  const key = randomKey();
  await db.collection('users').doc(uid).set({
    tgKeyHash: sha256(key),
    tgKeyCreatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  return key;
}

async function getLinkStatus(db, uid) {
  const user = (await db.collection('users').doc(uid).get()).data() || {};
  return {
    linked: Boolean(user.telegramChatId),
    linkedAt: user.telegramLinkedAt ? new Date(toMs(user.telegramLinkedAt)).toISOString() : null,
    discordLinked: Boolean(user.discordUserId),
    hasKey: Boolean(user.tgKeyHash)
  };
}

async function unlinkAccount(db, admin, uid) {
  await db.collection('users').doc(uid).set({
    telegramChatId: admin.firestore.FieldValue.delete(),
    telegramLinkedAt: admin.firestore.FieldValue.delete(),
    discordUserId: admin.firestore.FieldValue.delete(),
    discordLinkedAt: admin.firestore.FieldValue.delete()
  }, { merge: true });
}

async function findUid(db, chatId) {
  const snap = await db.collection('users').where('telegramChatId', '==', String(chatId)).limit(1).get();
  return snap.empty ? null : snap.docs[0].id;
}

const NOT_LINKED = 'Tài khoản chưa được liên kết. Dùng /xacthuc TDMS-XXXX-XXXX-XXXX với mã lấy từ trang Tài khoản.';

async function xacthuc(db, admin, chatId, rawKey) {
  const key = String(rawKey || '').trim().toUpperCase();
  if (!KEY_RE.test(key)) return sendToChat(chatId, 'Cú pháp: /xacthuc TDMS-XXXX-XXXX-XXXX');

  const now = Date.now();
  const a = attempts.get(String(chatId)) || { fails: 0, lockedUntil: 0 };
  if (a.lockedUntil > now) return sendToChat(chatId, 'Bạn nhập sai quá nhiều lần. Thử lại sau 15 phút.');

  const snap = await db.collection('users').where('tgKeyHash', '==', sha256(key)).limit(1).get();
  if (snap.empty) {
    const fails = a.fails + 1;
    const locked = fails >= MAX_FAILS;
    attempts.set(String(chatId), { fails: locked ? 0 : fails, lockedUntil: locked ? now + LOCK_MS : 0 });
    return sendToChat(chatId, 'Mã không đúng hoặc đã bị tạo lại. Kiểm tra mã trên trang Tài khoản.');
  }
  attempts.delete(String(chatId));

  const uid = snap.docs[0].id;
  // Gỡ chat này khỏi các tài khoản khác (nếu có) để mỗi chat chỉ gắn với một tài khoản
  const others = await db.collection('users').where('telegramChatId', '==', String(chatId)).get();
  const batch = db.batch();
  others.docs.filter(d => d.id !== uid).forEach(d => batch.update(d.ref, {
    telegramChatId: admin.firestore.FieldValue.delete(),
    telegramLinkedAt: admin.firestore.FieldValue.delete()
  }));
  batch.set(db.collection('users').doc(uid), {
    telegramChatId: String(chatId),
    telegramLinkedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  await batch.commit();

  return sendToChat(chatId, '✅ Đã liên kết tài khoản. Bạn sẽ nhận thông báo đơn hàng và nạp tiền tại đây.\nDùng /sodu, /donhang, /check MÃ_ĐƠN.');
}

async function orderLine(o) {
  return `• ${o.id} · ${o.serviceName || 'Dịch vụ'} · SL ${o.quantity || 0} · ${o.status || '—'}`;
}

// Trả về true nếu tin nhắn là lệnh của khách (đã xử lý), false nếu không phải.
async function handleCustomerCommand(message, db, admin) {
  const chatId = String(message?.chat?.id || '');
  if (!chatId || message?.chat?.type !== 'private') return false;
  const parts = String(message.text || '').trim().split(/\s+/);
  const cmd = (parts[0] || '').split('@')[0].toLowerCase();
  const CMDS = ['/start', '/xacthuc', '/sodu', '/donhang', '/check', '/huyxacthuc'];
  if (!CMDS.includes(cmd)) return false;

  if (cmd === '/start') {
    await sendToChat(chatId, 'Chào bạn đến với TDMS1VN.\nLiên kết: /xacthuc TDMS-XXXX-XXXX-XXXX\nSau khi liên kết: /sodu, /donhang, /check MÃ_ĐƠN, /huyxacthuc');
    return true;
  }
  if (cmd === '/xacthuc') { await xacthuc(db, admin, chatId, parts[1]); return true; }

  const uid = await findUid(db, chatId);
  if (!uid) { await sendToChat(chatId, NOT_LINKED); return true; }

  if (cmd === '/sodu') {
    const u = (await db.collection('users').doc(uid).get()).data() || {};
    await sendToChat(chatId, `💰 Số dư hiện tại: ${vnd(u.balance)}`);
    return true;
  }
  if (cmd === '/donhang') {
    const snap = await db.collection('orders').where('uid', '==', uid).limit(20).get();
    const list = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt))
      .slice(0, 5);
    if (!list.length) { await sendToChat(chatId, 'Bạn chưa có đơn hàng nào.'); return true; }
    const lines = await Promise.all(list.map(orderLine));
    await sendToChat(chatId, `🧾 5 đơn gần nhất:\n${lines.join('\n')}\n\nXem chi tiết: /check MÃ_ĐƠN`);
    return true;
  }
  if (cmd === '/check') {
    const id = String(parts[1] || '').trim();
    if (!id) { await sendToChat(chatId, 'Cú pháp: /check MÃ_ĐƠN'); return true; }
    const snap = await db.collection('orders').doc(id).get();
    if (!snap.exists || snap.data().uid !== uid) { await sendToChat(chatId, 'Không tìm thấy đơn này trong tài khoản của bạn.'); return true; }
    const o = snap.data();
    await sendToChat(chatId, [
      `🧾 Đơn ${id}`,
      `Dịch vụ: ${o.serviceName || '—'}`,
      `Số lượng: ${o.quantity || 0}`,
      `Số tiền: ${vnd(o.totalPrice)}`,
      `Trạng thái: ${o.status || '—'}`,
      `Còn lại: ${o.remains ?? '—'}`,
      `Thời gian: ${o.createdAt ? new Date(toMs(o.createdAt)).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : '—'}`
    ].join('\n'));
    return true;
  }
  if (cmd === '/huyxacthuc') {
    await unlinkAccount(db, admin, uid);
    await sendToChat(chatId, 'Đã gỡ liên kết. Dùng /xacthuc với mã của bạn để liên kết lại.');
    return true;
  }
  return false;
}

async function notifyUser(db, uid, text) {
  if (!uid) return;
  const user = (await db.collection('users').doc(String(uid)).get()).data() || {};
  if (user.telegramChatId) await sendToChat(user.telegramChatId, text);
  if (user.discordUserId) await sendDiscordDM(user.discordUserId, text);
}

async function notifyOrderStatus(db, uid, orderId, serviceName, status, refund) {
  const name = serviceName || 'Dịch vụ';
  let text = null;
  if (status === 'Completed') text = `✅ Đơn ${orderId} (${name}) đã hoàn tất.`;
  if (status === 'Canceled') text = `❌ Đơn ${orderId} (${name}) đã bị hủy. Hoàn ${vnd(refund)} vào số dư.`;
  if (status === 'Partial') text = `⚠️ Đơn ${orderId} (${name}) hoàn một phần. Hoàn ${vnd(refund)} vào số dư.`;
  if (text) await notifyUser(db, uid, text);
}

async function notifyDepositApproved(db, uid, amount) {
  await notifyUser(db, uid, `✅ Nạp tiền thành công: +${vnd(amount)}. Dùng /sodu để xem số dư.`);
}


// ----- Phát hiện thiết bị lạ -----
function deviceHash(ua) { return sha256(String(ua || 'unknown')); }

function deviceLabel(ua) {
  const u = String(ua || '');
  const os = /Android/i.test(u) ? 'Android' : /iPhone|iPad/i.test(u) ? 'iOS' : /Windows/i.test(u) ? 'Windows'
    : /Macintosh|Mac OS/i.test(u) ? 'macOS' : /Linux/i.test(u) ? 'Linux' : 'Thiết bị';
  const br = /Edg\//.test(u) ? 'Edge' : /Chrome\//.test(u) ? 'Chrome' : /Firefox\//.test(u) ? 'Firefox' : /Safari\//.test(u) ? 'Safari' : 'Trình duyệt';
  return `${br} trên ${os}`;
}

async function sendWithKeyboard(chatId, text, rows) {
  const c = api();
  if (!c || !chatId) return;
  await c.post('/sendMessage', { chat_id: String(chatId), text, reply_markup: { inline_keyboard: rows } })
    .catch(e => console.error('Telegram send:', e.message));
}

// Gọi từ /api/me. Chỉ ghi Firestore khi gặp thiết bị mới.
async function checkDevice(db, admin, uid, ua, user) {
  const h = deviceHash(ua);
  const known = Array.isArray(user.knownDevices) ? user.knownDevices : [];
  const pending = Array.isArray(user.pendingDevices) ? user.pendingDevices : [];
  if (known.includes(h) || pending.some(p => p.h === h)) return;

  // Lần đăng nhập đầu tiên của tài khoản: coi là thiết bị tin cậy
  if (!known.length && !pending.length) {
    await db.collection('users').doc(uid).set({ knownDevices: [h] }, { merge: true });
    return;
  }

  const entry = { h, label: deviceLabel(ua), at: new Date().toISOString() };
  await db.collection('users').doc(uid).set({ pendingDevices: [...pending, entry].slice(-10) }, { merge: true });
  if (!user.telegramChatId) return;

  const time = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  await sendWithKeyboard(user.telegramChatId,
    `🔐 Có thiết bị mới đăng nhập vào tài khoản lúc ${time}\nThiết bị: ${entry.label}\n\nĐây có phải bạn không?`,
    [[
      { text: '✅ Đây là tôi', callback_data: `dev:y:${h.slice(0, 16)}` },
      { text: '🚫 Đây không phải tôi', callback_data: `dev:n:${h.slice(0, 16)}` }
    ]]);
}

// Danh sách thiết bị đang chờ, dùng cho web (không lộ hash đầy đủ)
function pendingView(user) {
  return (Array.isArray(user.pendingDevices) ? user.pendingDevices : [])
    .map(p => ({ id: p.h.slice(0, 16), label: p.label, at: p.at }));
}

// Tin cậy thiết bị đang chờ. Trả về nhãn thiết bị, hoặc null nếu không còn chờ.
async function trustDevice(db, uid, id) {
  const user = (await db.collection('users').doc(uid).get()).data() || {};
  const pending = Array.isArray(user.pendingDevices) ? user.pendingDevices : [];
  const entry = pending.find(p => p.h.startsWith(id));
  if (!entry) return null;
  const known = Array.isArray(user.knownDevices) ? user.knownDevices : [];
  await db.collection('users').doc(uid).set({
    pendingDevices: pending.filter(p => p !== entry),
    knownDevices: [...known, entry.h].slice(-20)
  }, { merge: true });
  return entry.label;
}

// Khóa tài khoản: đăng xuất mọi phiên, vô hiệu mã Telegram, trả về link đặt lại mật khẩu
async function lockAccount(db, admin, uid) {
  const user = (await db.collection('users').doc(uid).get()).data() || {};
  await admin.auth().revokeRefreshTokens(uid);
  await db.collection('users').doc(uid).set({
    pendingDevices: [],
    tgKeyHash: admin.firestore.FieldValue.delete(),
    telegramChatId: admin.firestore.FieldValue.delete(),
    telegramLinkedAt: admin.firestore.FieldValue.delete(),
    discordUserId: admin.firestore.FieldValue.delete(),
    discordLinkedAt: admin.firestore.FieldValue.delete(),
    securityLockedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  let resetLink = null;
  try {
    const authUser = await admin.auth().getUser(uid);
    if (authUser.email) resetLink = await admin.auth().generatePasswordResetLink(authUser.email);
  } catch (e) { console.error('Reset link:', e.message); }

  if (user.telegramChatId) {
    await sendToChat(user.telegramChatId,
      `🚫 Tài khoản đã được khóa: đăng xuất mọi thiết bị và vô hiệu mã liên kết Telegram.${resetLink ? `\n\nĐặt lại mật khẩu: ${resetLink}` : ''}\n\nSau khi đổi mật khẩu, tạo mã liên kết mới trên trang Tài khoản.`);
  }
  return { resetLink };
}

// Xử lý khi người dùng bấm nút dưới thông báo Telegram
async function handleDeviceCallback(cq, db, admin) {
  const chatId = String(cq.message?.chat?.id || cq.from?.id || '');
  const answer = text => api()?.post('/answerCallbackQuery', { callback_query_id: cq.id, text }).catch(() => {});
  const m = String(cq.data || '').match(/^dev:(y|n):([a-f0-9]{16})$/);
  if (!m) return answer('');

  const uid = await findUid(db, chatId);
  if (!uid) return answer('Tài khoản chưa liên kết.');

  if (m[1] === 'y') {
    const label = await trustDevice(db, uid, m[2]);
    await answer(label ? 'Đã xác nhận thiết bị' : 'Thiết bị này đã được xử lý.');
    if (label) await sendToChat(chatId, `✅ Đã ghi nhận ${label} là thiết bị của bạn.`);
    return;
  }
  await lockAccount(db, admin, uid);
  return answer('Đã khóa tài khoản');
}

// Gửi một thông báo tới mọi tài khoản đã liên kết Telegram hoặc Discord
async function broadcast(db, text) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const tg = await db.collection('users').where('telegramChatId', '>', '').get();
  for (const d of tg.docs) { await sendToChat(d.data().telegramChatId, text); await sleep(60); }
  const dc = await db.collection('users').where('discordUserId', '>', '').get();
  for (const d of dc.docs) { await sendDiscordDM(d.data().discordUserId, text); await sleep(200); }
  return { telegram: tg.size, discord: dc.size };
}

module.exports = {
  broadcast, checkDevice, handleDeviceCallback, pendingView, trustDevice, lockAccount, createLinkKey, getLinkStatus, unlinkAccount, handleCustomerCommand,
  notifyUser, notifyOrderStatus, notifyDepositApproved, KEY_RE
};
