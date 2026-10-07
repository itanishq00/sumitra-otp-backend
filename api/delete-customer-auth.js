const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}

const CUSTOMER_EMAIL_DOMAIN = '@customer.sumitra.local';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed.' });
  }

  try {
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!idToken) {
      return res.status(401).json({ success: false, message: 'Owner login required.' });
    }

    const decoded = await admin.auth().verifyIdToken(idToken);
    const ownerDoc = await admin.firestore().collection('admins').doc(decoded.uid).get();
    if (!ownerDoc.exists) {
      return res.status(403).json({ success: false, message: 'Owner access required.' });
    }

    const { customerId } = req.body || {};
    if (!customerId || typeof customerId !== 'string') {
      return res.status(400).json({ success: false, message: 'customerId missing hai.' });
    }

    let target;
    try {
      target = await admin.auth().getUser(customerId);
    } catch (e) {
      if (e.code === 'auth/user-not-found') {
        return res.status(200).json({ success: true, deleted: false });
      }
      throw e;
    }

    if (!(target.email || '').endsWith(CUSTOMER_EMAIL_DOMAIN)) {
      return res.status(400).json({ success: false, message: 'Ye customer account nahi hai.' });
    }

    await admin.auth().deleteUser(customerId);
    return res.status(200).json({ success: true, deleted: true });
  } catch (e) {
    console.error('delete-customer-auth error:', e);
    return res.status(500).json({ success: false, message: 'Login account delete nahi ho paaya.' });
  }
};