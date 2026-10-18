// C1: HP ke invite code se owner ko agency se jodna. Faisla sirf yahan (Admin SDK).
const admin = require('./_lib/firebase');
const { cors } = require('./_lib/auth');

const CODE_RE = /^[A-Z0-9]{8}$/;
const MAX_TRIES_PER_HOUR = 10;

class Fail extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (_) { return {}; } }
  return req.body;
}
const send = (res, status, success, message, extra = {}) => res.status(status).json({ success, message, ...extra });

async function allowTry(db, uid, now) {
  const ref = db.collection('otpLimits').doc('inv_' + uid);
  return db.runTransaction(async (tx) => {
    const d = (await tx.get(ref)).data() || {};
    let start = d.hStart || 0, count = d.hCount || 0;
    if (now - start >= 3600000) { start = now; count = 0; }
    if (count >= MAX_TRIES_PER_HOUR) return false;
    tx.set(ref, { hStart: start, hCount: count + 1, updatedAtMs: now });
    return true;
  });
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method === 'GET') return send(res, 200, true, 'claim-agency ready');
  if (req.method !== 'POST') return send(res, 405, false, 'Method not allowed');

  const m = String(req.headers.authorization || req.headers.Authorization || '').match(/^Bearer (.+)$/);
  if (!m) return send(res, 401, false, 'Login required.');
  let user;
  try { user = await admin.auth().verifyIdToken(m[1]); } catch (_) { return send(res, 401, false, 'Login required.'); }

  const body = parseBody(req);
  const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!CODE_RE.test(code)) return send(res, 400, false, 'Invite code 8 akshar ka hota hai.');

  const email = String(user.email || '').toLowerCase();
  if (['customer', 'delivery_agent', 'hp_admin'].includes(user.role) || email.endsWith('.sumitra.local')) {
    return send(res, 403, false, 'Ye account owner ke liye nahi hai. Alag email se login karo.');
  }

  const db = admin.firestore();
  const FV = admin.firestore.FieldValue;
  const now = Date.now();
  try {
    if (!(await allowTry(db, user.uid, now))) return send(res, 429, false, 'Bahut baar try hua. 1 ghante baad try karo.');
    if ((await db.doc('hpAdmins/' + user.uid).get()).exists) return send(res, 403, false, 'HP admin account owner nahi ban sakta.');

    const name = String(body.name || '').trim().slice(0, 80);
    const phone = String(body.phone || '').replace(/\D/g, '').slice(0, 10);

    const result = await db.runTransaction(async (tx) => {
      const invRef = db.doc('agencyInvites/' + code);
      const inv = await tx.get(invRef);
      if (!inv.exists) throw new Fail(404, 'Invite code galat hai.');
      const i = inv.data();
      if (i.usedBy) throw new Fail(409, 'Ye code pehle hi use ho chuka hai.');
      if ((i.expiresAtMs || 0) < now) throw new Fail(410, 'Code expire ho gaya. HP se naya code maango.');

      const agRef = db.doc('agencies/' + i.agencyId);
      const ag = await tx.get(agRef);
      if (!ag.exists || String(ag.get('status') || '').toUpperCase() === 'REJECTED') throw new Fail(409, 'Ye agency available nahi hai.');

      const adRef = db.doc('admins/' + user.uid);
      const ad = await tx.get(adRef);
      const prev = ad.exists ? ad.data() : null;
      if (prev && String(prev.status || 'ACTIVE').toUpperCase() !== 'PENDING') throw new Fail(409, 'Aap pehle se kisi agency ke owner ho.');

      tx.set(adRef, {
        agencyId: i.agencyId,
        name: name || (prev && prev.name) || '',
        phone: phone || (prev && prev.phone) || '',
        email: user.email || '',
        role: 'owner',
        status: 'ACTIVE',
        joinedVia: 'invite',
        inviteCode: code,
        previousPendingAgencyId: prev ? prev.agencyId || null : null,
        createdAt: prev && prev.createdAt ? prev.createdAt : FV.serverTimestamp(),
        updatedAt: FV.serverTimestamp(),
      });
      if (!ag.get('ownerUid')) tx.update(agRef, { ownerUid: user.uid, updatedAt: FV.serverTimestamp() });
      tx.update(invRef, { usedBy: user.uid, usedAt: FV.serverTimestamp() });
      return { agencyId: i.agencyId, agencyName: ag.get('name') || i.agencyId, prevPending: prev ? prev.agencyId || null : null };
    });

    const u = await admin.auth().getUser(user.uid);
    await admin.auth().setCustomUserClaims(user.uid, { ...(u.customClaims || {}), role: 'owner', agencyId: result.agencyId });
    try {
      await db.collection('auditLogs').add({
        agencyId: result.agencyId, actorId: user.uid, actorEmail: user.email || '', actorRole: 'owner',
        action: 'OWNER_JOINED_VIA_INVITE', targetType: 'agency', targetId: result.agencyId,
        oldValue: result.prevPending ? { pendingAgencyId: result.prevPending } : null,
        newValue: { inviteCode: code.slice(0, 2) + '******' }, timestamp: FV.serverTimestamp(),
      });
    } catch (e) { console.error('audit log failed:', e.message); }
    return send(res, 200, true, `Aap ${result.agencyName} ke owner ban gaye.`, { agencyId: result.agencyId });
  } catch (e) {
    if (e instanceof Fail) return send(res, e.status, false, e.message);
    console.error('claim-agency error:', e);
    return send(res, 500, false, 'Server error. Thodi der baad try karo.');
  }
};
