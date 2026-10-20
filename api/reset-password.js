// Customer password reset: OTP (same send-otp/verify-otp as signup) -> naya password.
// Sirf customer accounts. Owner / agent / HP admin ka password yahan se nahi badlega.
const admin = require('./_lib/firebase');
const verifyOtp = require('./verify-otp');

const BLOCKED_ROLES = ['owner', 'hp_admin', 'delivery_agent', 'agent'];

function callHandler(handler, body) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      setHeader() { return this; },
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ code: this.statusCode, body: b }); return this; },
      send(b) { let x = b; try { x = typeof b === 'string' ? JSON.parse(b) : b; } catch (_) {} resolve({ code: this.statusCode, body: x }); return this; },
      end(b) { this.send(b || '{}'); },
    };
    Promise.resolve(handler({ method: 'POST', headers: { 'content-type': 'application/json' }, body, query: {} }, res))
      .catch((e) => resolve({ code: 500, body: { success: false, message: e.message } }));
  });
}

function validate(mobile, newPassword) {
  if (!/^\d{10}$/.test(mobile)) return 'Sahi 10-digit mobile number daalo.';
  if (typeof newPassword !== 'string' || newPassword.length < 6 || newPassword.length > 64) return 'Password kam se kam 6 akshar ka hona chahiye.';
  return null;
}

async function resetPasswordCore({ mobile, newPassword }) {
  const bad = validate(mobile, newPassword);
  if (bad) return { code: 400, message: bad };
  const db = admin.firestore();
  const snap = await db.collection('customers').where('mobile', '==', mobile).limit(5).get();
  const uids = [...new Set(snap.docs.map((d) => d.id))];
  if (uids.length === 0) return { code: 404, message: 'Is mobile number par koi customer account nahi mila.' };
  if (uids.length > 1) return { code: 409, message: 'Is number par ek se zyada account hain. Agency se sampark karo.' };
  let user;
  try { user = await admin.auth().getUser(uids[0]); } catch (_) { return { code: 404, message: 'Is mobile number par koi customer account nahi mila.' }; }
  const role = (user.customClaims || {}).role;
  if (role && BLOCKED_ROLES.includes(role)) return { code: 403, message: 'Ye customer account nahi hai.' };
  await admin.auth().updateUser(user.uid, { password: newPassword });
  try { await admin.auth().revokeRefreshTokens(user.uid); } catch (_) {}
  try {
    await db.collection('auditLogs').add({
      agencyId: snap.docs[0].get('agencyId') || 'platform', actorId: user.uid, actorEmail: '', actorRole: 'customer',
      action: 'CUSTOMER_PASSWORD_RESET', targetType: 'customer', targetId: user.uid,
      oldValue: null, newValue: { via: 'otp' }, timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (_) {}
  return { code: 200, message: 'Password badal gaya. Ab naye password se login karo.' };
}

module.exports = async (req, res) => {
  if (req.method === 'GET') return res.status(200).json({ success: true, message: 'reset-password ready' });
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method not allowed' });
  try {
    const b = req.body || {};
    const mobile = String(b.mobileNumber || '').replace(/\D/g, '').slice(-10);
    const bad = validate(mobile, b.newPassword);
    if (bad) return res.status(400).json({ success: false, message: bad });
    if (!b.otp || !b.verificationId) return res.status(400).json({ success: false, message: 'OTP daalo.' });
    const v = await callHandler(verifyOtp, { mobileNumber: mobile, otp: String(b.otp), verificationId: String(b.verificationId) });
    if (v.code !== 200 || !v.body || v.body.success !== true) {
      return res.status(400).json({ success: false, message: (v.body && v.body.message) || 'OTP galat ya expire ho gaya.' });
    }
    const r = await resetPasswordCore({ mobile, newPassword: b.newPassword });
    return res.status(r.code).json({ success: r.code === 200, message: r.message });
  } catch (e) {
    console.error('reset-password error:', e);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};
module.exports.resetPasswordCore = resetPasswordCore;
