const admin = require('./_lib/firebase');
const { verifyRegistration } = require('./_lib/regToken');

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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    try {
      admin.ensureApp();
      return send(res, 200, true, 'register ready');
    } catch (e) {
      return send(res, 500, false, `Init error: ${e.message}`);
    }
  }
  if (req.method !== 'POST') return send(res, 405, false, 'Method not allowed');

  const { registrationToken, name, password } = parseBody(req);

  let mobile;
  try {
    mobile = verifyRegistration(registrationToken);
  } catch (e) {
    console.error('register token check error:', e);
    return send(res, 500, false, 'Server error. Please try again.');
  }
  if (!mobile) {
    return send(res, 400, false, 'OTP verification expired. Please sign up again.');
  }

  const cleanName = String(name || '').trim();
  if (!cleanName || cleanName.length > 80) {
    return send(res, 400, false, 'Please enter your full name.');
  }
  if (typeof password !== 'string' || password.length < 6 || password.length > 64) {
    return send(res, 400, false, 'Password must contain at least 6 characters.');
  }

  try {
    let user;
    try {
      user = await admin.auth().createUser({
        email: `${mobile}@customer.sumitra.local`,
        password,
        displayName: cleanName,
      });
    } catch (e) {
      if (e.code === 'auth/email-already-exists') {
        return send(res, 409, false, 'An account already exists with this mobile number. Please login.');
      }
      throw e;
    }

    await admin.auth().setCustomUserClaims(user.uid, { role: 'customer' });

    const FieldValue = admin.firestore.FieldValue;
    await admin.firestore().collection('customers').doc(user.uid).set({
      uid: user.uid,
      name: cleanName,
      mobile,
      verificationStatus: 'pending',
      consumerNumber: null,
      active: true,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return send(res, 200, true, 'Account created.');
  } catch (e) {
    console.error('register-customer error:', e);
    return send(res, 500, false, 'Account creation failed. Please try again.');
  }
};
