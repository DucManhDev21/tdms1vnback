'use strict';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function validateEmail(email) {
  const value = normalizeEmail(email);
  if (!value || value.length > 320 || !EMAIL_RE.test(value)) {
    throw new Error('Gmail/email không hợp lệ. Ví dụ: admin@gmail.com');
  }
  return value;
}

function ownerEmail() {
  return normalizeEmail(process.env.ADMIN_EMAIL || '');
}

async function ensureOwnerAdmin(db, admin) {
  const email = ownerEmail();
  if (!email) {
    throw new Error('ADMIN_EMAIL chưa được cấu hình. Đây là tài khoản chủ hệ thống dùng để bootstrap Admin.');
  }
  validateEmail(email);
  const ref = db.collection('admins').doc(email);
  const snap = await ref.get();
  const base = {
    email,
    active: true,
    owner: true,
    source: 'env_bootstrap',
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };
  if (!snap.exists) {
    await ref.set({
      ...base,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } else if (snap.data()?.active !== true || snap.data()?.owner !== true) {
    await ref.set(base, { merge: true });
  }
  return email;
}

async function getAdmin(db, email) {
  const normalized = validateEmail(email);
  const snap = await db.collection('admins').doc(normalized).get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  if (data.active !== true) return null;
  return { id: snap.id, ...data, email: normalized };
}

async function isAdmin(db, email) {
  return Boolean(await getAdmin(db, email));
}

async function addAdmin(db, admin, email, actor = {}) {
  const normalized = validateEmail(email);
  const ref = db.collection('admins').doc(normalized);
  const snap = await ref.get();
  if (snap.exists) {
    const current = snap.data() || {};
    if (current.active === true) throw new Error(`Email ${normalized} đã là Admin.`);
    await ref.set({
      email: normalized,
      active: true,
      owner: current.owner === true,
      source: current.source || 'telegram',
      reactivatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  } else {
    await ref.set({
      email: normalized,
      active: true,
      owner: normalized === ownerEmail(),
      source: 'telegram',
      addedBy: actor.email || actor.telegramUserId || 'telegram',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  }
  await db.collection('admin_audit_logs').add({
    action: 'add_admin',
    targetEmail: normalized,
    actor: actor.email || actor.telegramUserId || 'telegram',
    source: actor.source || 'telegram',
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  return getAdmin(db, normalized);
}

async function deleteAdmin(db, admin, email, actor = {}) {
  const normalized = validateEmail(email);
  if (normalized === ownerEmail()) {
    throw new Error('Không thể xóa Admin chủ hệ thống trong ADMIN_EMAIL.');
  }
  const ref = db.collection('admins').doc(normalized);
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`Không tìm thấy Admin ${normalized}.`);
  const data = snap.data() || {};
  if (data.active === false) throw new Error(`Admin ${normalized} đã được xóa trước đó.`);
  await ref.set({
    active: false,
    deletedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  await db.collection('admin_audit_logs').add({
    action: 'delete_admin',
    targetEmail: normalized,
    actor: actor.email || actor.telegramUserId || 'telegram',
    source: actor.source || 'telegram',
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  return normalized;
}

async function listAdmins(db) {
  const snap = await db.collection('admins').get();
  return snap.docs
    .map(doc => ({ id: doc.id, ...(doc.data() || {}) }))
    .filter(item => item.active === true)
    .sort((a, b) => String(a.email || '').localeCompare(String(b.email || '')));
}

module.exports = {
  normalizeEmail,
  validateEmail,
  ownerEmail,
  ensureOwnerAdmin,
  getAdmin,
  isAdmin,
  addAdmin,
  deleteAdmin,
  listAdmins
};
