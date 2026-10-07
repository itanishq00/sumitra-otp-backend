const admin = require('./_lib/firebase');
const { AGENCY_ID, cors, requireOwner, auditLog } = require('./_lib/auth');

const AGENT_DOMAIN = 'agent.sumitra.local';
const ACTIVE_ORDER_STATUSES = ['ASSIGNED', 'ACCEPTED', 'OUT_FOR_DELIVERY', 'ARRIVED'];
const LOGIN_ALLOWED_STATUSES = ['ACTIVE', 'ON_LEAVE'];

function send(res, status, success, message, extra = {}) {
  return res.status(status).json({ success, message, ...extra });
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (_) { return {}; }
  }
  return req.body;
}

function validPassword(p) {
  return typeof p === 'string' && p.length >= 6 && p.length <= 64;
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method === 'GET') {
    try {
      admin.ensureApp();
      return send(res, 200, true, 'agent-login ready');
    } catch (e) {
      return send(res, 500, false, `Init error: ${e.message}`);
    }
  }
  if (req.method !== 'POST') return send(res, 405, false, 'Method not allowed');

  let owner;
  try {
    owner = await requireOwner(req);
  } catch (e) {
    return send(res, e.status || 401, false, e.message);
  }

  const { action, agentId, password } = parseBody(req);
  if (!agentId || typeof agentId !== 'string') return send(res, 400, false, 'agentId required.');

  const db = admin.firestore();
  const FieldValue = admin.firestore.FieldValue;
  const agentRef = db.collection('deliveryAgents').doc(agentId);

  try {
    const snap = await agentRef.get();
    if (!snap.exists) return send(res, 404, false, 'Agent nahi mila.');

    const agent = snap.data();
    const mobile = String(agent.mobile || '').replace(/\D/g, '');
    if (mobile.length !== 10) return send(res, 400, false, 'Agent ka mobile number sahi nahi hai.');

    const email = `${mobile}@${AGENT_DOMAIN}`;
    const disabled = !LOGIN_ALLOWED_STATUSES.includes(agent.status);
    const claims = { role: 'delivery_agent', agencyId: AGENCY_ID, agentId };

    // ---------- CREATE ----------
    if (action === 'create') {
      if (agent.authUid) return send(res, 400, false, 'Is agent ka login pehle se bana hua hai.');
      if (!validPassword(password)) {
        return send(res, 400, false, 'Password kam se kam 6 characters ka hona chahiye.');
      }

      let user;
      try {
        user = await admin.auth().createUser({
          email,
          password,
          displayName: agent.name || 'Agent',
          disabled,
        });
      } catch (e) {
        if (e.code !== 'auth/email-already-exists') throw e;
        // Pichhli baar aadha bana ho to wahi account reuse karo (retry-safe).
        const existing = await admin.auth().getUserByEmail(email);
        const c = existing.customClaims || {};
        if (c.role && c.agentId !== agentId) {
          return send(res, 400, false, 'Is mobile number se kisi aur ka login bana hua hai.');
        }
        user = await admin.auth().updateUser(existing.uid, {
          password,
          displayName: agent.name || 'Agent',
          disabled,
        });
      }

      await admin.auth().setCustomUserClaims(user.uid, claims);

      const batch = db.batch();
      batch.update(agentRef, {
        authUid: user.uid,
        loginEmail: email,
        loginCreatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      // Pehle se assigned chal rahe orders me agentUid bhar do.
      const assigned = await db.collection('bookings').where('agentId', '==', agentId).get();
      assigned.docs
        .filter((d) => ACTIVE_ORDER_STATUSES.includes(d.data().orderStatus))
        .forEach((d) => batch.update(d.ref, { agentUid: user.uid }));

      batch.set(db.collection('auditLogs').doc(),
        auditLog(owner, 'AGENT_LOGIN_CREATED', agentId, null, { loginEmail: email }));
      await batch.commit();

      return send(res, 200, true, 'Login ban gaya.', { mobile });
    }

    // ---------- RESET PASSWORD ----------
    if (action === 'reset-password') {
      if (!agent.authUid) return send(res, 400, false, 'Is agent ka login abhi bana hi nahi hai.');
      if (!validPassword(password)) {
        return send(res, 400, false, 'Password kam se kam 6 characters ka hona chahiye.');
      }
      await admin.auth().updateUser(agent.authUid, { password });
      await admin.auth().revokeRefreshTokens(agent.authUid);
      await db.collection('auditLogs').add(
        auditLog(owner, 'AGENT_PASSWORD_RESET', agentId, null, null));
      return send(res, 200, true, 'Password badal gaya.');
    }

    // ---------- SYNC (status / mobile / name) ----------
    if (action === 'sync') {
      if (!agent.authUid) return send(res, 200, true, 'Login nahi hai, sync ki zarurat nahi.');

      await admin.auth().updateUser(agent.authUid, {
        email,
        displayName: agent.name || 'Agent',
        disabled,
      });
      await admin.auth().setCustomUserClaims(agent.authUid, claims);
      if (disabled) await admin.auth().revokeRefreshTokens(agent.authUid);

      if (agent.loginEmail !== email) {
        await agentRef.update({ loginEmail: email, updatedAt: FieldValue.serverTimestamp() });
      }
      return send(res, 200, true, disabled ? 'Agent ka login band kar diya.' : 'Agent login updated.');
    }

    return send(res, 400, false, 'Unknown action.');
  } catch (e) {
    console.error('agent-login error:', e);
    if (e.code === 'auth/email-already-exists') {
      return send(res, 400, false, 'Is mobile number se pehle se koi login bana hua hai.');
    }
    return send(res, 500, false, `Server error: ${e.message || e}`);
  }
};
