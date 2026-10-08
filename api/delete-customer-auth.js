const admin = require('./_lib/firebase');
const { AGENCY_ID, cors, requireOwner } = require('./_lib/auth');

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (_) { return {}; }
  }
  return req.body;
}

// Owner sirf APNI agency ke customer ka login hata sakta hai.
module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  let owner;
  try {
    owner = await requireOwner(req);
  } catch (e) {
    return res.status(e.status || 401).json({
      success: false,
      message: e.status === 403 ? e.message : 'Owner login required.',
    });
  }

  const customerId = String(parseBody(req).customerId || '').trim();
  if (!customerId) {
    return res.status(400).json({ success: false, message: 'customerId required.' });
  }

  try {
    const snap = await admin.firestore().collection('customers').doc(customerId).get();
    if (snap.exists) {
      const custAgency = snap.data().agencyId || AGENCY_ID;
      if (custAgency !== (owner.agencyId || AGENCY_ID)) {
        return res.status(403).json({ success: false, message: 'Ye customer aapki agency ka nahi hai.' });
      }
    }

    try {
      await admin.auth().deleteUser(customerId);
    } catch (e) {
      // Owner ke haath se jode customer ka login hota hi nahi: ye success hai.
      if (e.code !== 'auth/user-not-found') throw e;
    }

    return res.status(200).json({ success: true, message: 'Customer login deleted.' });
  } catch (e) {
    console.error('delete-customer-auth error:', e);
    return res.status(500).json({ success: false, message: `Server error: ${e.message || e}` });
  }
};
