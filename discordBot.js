const crypto = require('crypto');
const axios = require('axios');

const DC = axios.create({ baseURL: 'https://discord.com/api/v10', timeout: 10000 });
const KEY_RE = /^TDMS-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/;

function sha256(v) { return crypto.createHash('sha256').update(v).digest('hex'); }
function vnd(n) { return `${Math.round(Number(n || 0)).toLocaleString('vi-VN')}đ`; }
function toMs(v) {
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v._seconds != null) return v._seconds * 1000;
  return new Date(v).getTime() || 0;
}

// Discord ký mỗi request bằng Ed25519: kiểm tra chữ ký trước khi xử lý
function verifySignature(req) {
  const pub = process.env.DISCORD_PUBLIC_KEY;
  const sig = req.get('X-Signature-Ed25519');
  const ts = req.get('X-Signature-Timestamp');
  if (!pub || !sig || !ts || !req.rawBody) return false;
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pub, 'hex')]),
      format: 'der', type: 'spki'
    });
    return crypto.verify(null, Buffer.concat([Buffer.from(ts), req.rawBody]), key, Buffer.from(sig, 'hex'));
  } catch (e) {
    return false;
  }
}

function reply(content) { return { type: 4, data: { content, flags: 64 } }; }

async function sendDiscordDM(userId, content) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token || !userId) return;
  const headers = { Authorization: `Bot ${token}` };
  try {
    const ch = await DC.post('/users/@me/channels', { recipient_id: String(userId) }, { headers });
    await DC.post(`/channels/${ch.data.id}/messages`, { content }, { headers });
  } catch (e) {
    console.error('Discord DM:', e.response?.status || e.message);
  }
}

const MENU_TEXT_DC = [
  '**🏪 TDMS1VN · Trợ lý tài khoản**',
  '💰 **/sodu**: xem số dư hiện tại',
  '🧾 **/donhang**: 5 đơn gần nhất',
  '🔍 **/check ma_don**: chi tiết một đơn',
  '🔗 **/xacthuc key**: liên kết tài khoản',
  '🚫 **/huyxacthuc**: gỡ liên kết',
  '',
  '*Các lệnh chỉ dùng trong tin nhắn riêng với bot.*'
].join('\n');

async function findUidByDiscord(db, discordId) {
  const snap = await db.collection('users').where('discordUserId', '==', discordId).limit(1).get();
  return snap.empty ? null : snap.docs[0].id;
}

// Xử lý slash command. Trả lời ephemeral (chỉ người gửi thấy).
async function handleInteraction(body, db, admin) {
  if (body?.type === 1) return { type: 1 };
  if (body?.type !== 2) return reply('Lệnh không được hỗ trợ.');

  const discordId = String(body.member?.user?.id || body.user?.id || '');
  const name = body.data?.name;
  if (name === 'xacthuc' && body.guild_id) return reply('⚠️ Lệnh này chỉ dùng trong tin nhắn riêng với bot để bảo vệ mã liên kết.');
  if (name === 'menu') return reply(MENU_TEXT_DC);
  const opt = n => (body.data?.options || []).find(o => o.name === n)?.value;

  if (name === 'xacthuc') {
    const key = String(opt('key') || '').trim().toUpperCase();
    if (!KEY_RE.test(key)) return reply('Cú pháp: /xacthuc key:TDMS-XXXX-XXXX-XXXX');
    const snap = await db.collection('users').where('tgKeyHash', '==', sha256(key)).limit(1).get();
    if (snap.empty) return reply('Mã không đúng hoặc đã bị tạo lại. Kiểm tra mã trên trang Tài khoản.');
    const uid = snap.docs[0].id;
    const others = await db.collection('users').where('discordUserId', '==', discordId).get();
    const batch = db.batch();
    others.docs.filter(d => d.id !== uid).forEach(d => batch.update(d.ref, {
      discordUserId: admin.firestore.FieldValue.delete(),
      discordLinkedAt: admin.firestore.FieldValue.delete()
    }));
    batch.set(db.collection('users').doc(uid), {
      discordUserId: discordId,
      discordLinkedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    await batch.commit();
    return reply('✅ Đã liên kết tài khoản Discord. Bạn sẽ nhận thông báo tại đây.');
  }

  const uid = await findUidByDiscord(db, discordId);
  if (!uid) return reply('Tài khoản chưa liên kết. Dùng /xacthuc key:MÃ với mã lấy từ trang Tài khoản.');

  if (name === 'sodu') {
    const u = (await db.collection('users').doc(uid).get()).data() || {};
    return reply(`**💰 Số dư hiện tại**\n${vnd(u.balance)}`);
  }
  if (name === 'donhang') {
    const snap = await db.collection('orders').where('uid', '==', uid).limit(20).get();
    const list = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt)).slice(0, 5);
    if (!list.length) return reply('Bạn chưa có đơn hàng nào.');
    const lines = list.map(o => `• ${o.id} · ${o.serviceName || 'Dịch vụ'} · SL ${o.quantity || 0} · ${o.status || '—'}`);
    return reply(`**🧾 5 đơn gần nhất**\n${lines.join('\n')}\n\nXem chi tiết: /check ma_don`);
  }
  if (name === 'check') {
    const id = String(opt('ma_don') || '').trim();
    const snap = id ? await db.collection('orders').doc(id).get() : null;
    if (!snap || !snap.exists || snap.data().uid !== uid) return reply('Không tìm thấy đơn này trong tài khoản của bạn.');
    const o = snap.data();
    return reply([
      `🧾 Đơn ${id}`,
      `Dịch vụ: ${o.serviceName || '—'}`,
      `Số lượng: ${o.quantity || 0}`,
      `Số tiền: ${vnd(o.totalPrice)}`,
      `Trạng thái: ${o.status || '—'}`,
      `Còn lại: ${o.remains ?? '—'}`
    ].join('\n'));
  }
  if (name === 'huyxacthuc') {
    await db.collection('users').doc(uid).set({
      discordUserId: admin.firestore.FieldValue.delete(),
      discordLinkedAt: admin.firestore.FieldValue.delete()
    }, { merge: true });
    return reply('Đã gỡ liên kết Discord.');
  }
  return reply('Lệnh không được hỗ trợ.');
}

module.exports = { verifySignature, handleInteraction, sendDiscordDM, reply };
