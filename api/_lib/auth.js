const admin = require('./firebase');

const AGENCY_ID = 'sumitra-rasalpur';

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// CORS (owner web app ke liye). OPTIONS request par true return karta hai.
function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

// Owner = admins/{uid} doc (status ACTIVE) YA purana 'owner' claim (bina admins doc).
// Agency hamesha admins doc se aati hai (warna claim se). Claim ko doc ke saath sync rakhta hai.
async function requireOwner(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer (.+)$/);
  if (!match) throw httpError(401, 'Login required.');

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(match[1], true);
  } catch (_) {
    throw httpError(401, 'Session expire ho gaya. Dobara login karo.');
  }

  const adminDoc = await admin.firestore().collection('admins').doc(decoded.uid).get();

  if (!adminDoc.exists) {
    if (decoded.role === 'owner') {
      return { ...decoded, agencyId: decoded.agencyId || AGENCY_ID };
    }
    throw httpError(403, 'Sirf owner ye kaam kar sakta hai.');
  }

  const data = adminDoc.data() || {};
  const status = String(data.status || 'ACTIVE').trim().toUpperCase();
  if (status !== 'ACTIVE') {
    throw httpError(403, `Owner access abhi ${status} hai.`);
  }

  const agencyId = String(data.agencyId || decoded.agencyId || AGENCY_ID).trim();

  if (decoded.role !== 'owner' || decoded.agencyId !== agencyId) {
    const user = await admin.auth().getUser(decoded.uid);
    await admin.auth().setCustomUserClaims(decoded.uid, {
      ...(user.customClaims || {}),
      role: 'owner',
      agencyId,
    });
  }
  return { ...decoded, agencyId };
}

function auditLog(actor, action, targetId, oldValue, newValue) {
  return {
    agencyId: actor.agencyId || AGENCY_ID,
    actorId: actor.uid,
    actorEmail: actor.email || '',
    actorRole: 'owner',
    action,
    targetType: 'deliveryAgent',
    targetId,
    oldValue: oldValue || null,
    newValue: newValue || null,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  };
}

module.exports = { AGENCY_ID, cors, requireOwner, httpError, auditLog };
