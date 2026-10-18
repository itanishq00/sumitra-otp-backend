const admin = require('./_lib/firebase');
const { AGENCY_ID, cors, requireOwner } = require('./_lib/auth');

const CUSTOMER_DOMAIN = '@customer.sumitra.local';

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (_) { return {}; }
  }
  return req.body;
}

function send(res, status, success, message) {
  return res.status(status).json({ success, message });
}

// Owner sirf APNI agency ke CUSTOMER ka login hata sakta hai.
// Owner / delivery agent / HP admin ka account is endpoint se kabhi delete nahi hoga.
module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return send(res, 405, false, 'Method not allowed');

  let owner;
  try {
    owner = await requireOwner(req);
  } catch (e) {
    return send(res, e.status || 401, false, e.status === 403 ? e.message : 'Owner login required.');
  }

  const customerId = String(parseBody(req).customerId || '').trim();
  if (!customerId || customerId.length > 128) return send(res, 400, false, 'customerId required.');
  const ownerAgency = owner.agencyId || AGENCY_ID;

  try {
    const db = admin.firestore();

    // 1. Customer record hona zaroori hai, aur owner ki agency ka.
    const snap = await db.collection('customers').doc(customerId).get();
    if (!snap.exists) return send(res, 404, false, 'Customer record nahi mila.');
    if ((snap.data().agencyId || AGENCY_ID) !== ownerAgency) {
      return send(res, 403, false, 'Ye customer aapki agency ka nahi hai.');
    }

    // 2. Login account (agar hai) sach me customer ka hona chahiye.
    let user = null;
    try {
      user = await admin.auth().getUser(customerId);
    } catch (e) {
      if (e.code !== 'auth/user-not-found') throw e;
    }

    if (user) {
      const claims = user.customClaims || {};
      const customerEmail = String(user.email || '').toLowerCase().endsWith(CUSTOMER_DOMAIN);
      if ((claims.role && claims.role !== 'customer') || !customerEmail) {
        console.warn('delete-customer-auth BLOCKED', { by: owner.uid, target: customerId });
        return send(res, 403, false, 'Ye account customer ka nahi hai. Delete nahi kiya gaya.');
      }
      if (claims.agencyId && claims.agencyId !== ownerAgency) {
        return send(res, 403, false, 'Ye customer aapki agency ka nahi hai.');
      }
      await admin.auth().deleteUser(customerId);
    }

    // 3. Audit log (fail ho to bhi delete ka result wahi rahe).
    try {
      await db.collection('auditLogs').add({
        agencyId: ownerAgency,
        actorId: owner.uid,
        actorEmail: owner.email || '',
        actorRole: 'owner',
        action: 'CUSTOMER_LOGIN_DELETED',
        targetType: 'customer',
        targetId: customerId,
        oldValue: null,
        newValue: { hadLogin: !!user },
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (e) {
      console.error('audit log failed:', e.message);
    }

    return send(res, 200, true, user ? 'Customer login deleted.' : 'Customer ka login pehle se nahi tha.');
  } catch (e) {
    console.error('delete-customer-auth error:', e);
    return send(res, 500, false, `Server error: ${e.message || e}`);
  }
};
