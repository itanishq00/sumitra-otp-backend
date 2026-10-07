// firebase-admin v14 modular API.
// Purane jaisa shape export karte hain: admin.auth(), admin.firestore(),
// admin.firestore.FieldValue — taaki baaki files na badalni padein.
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}

const firestore = () => getFirestore();
firestore.FieldValue = FieldValue;

module.exports = {
  auth: () => getAuth(),
  firestore,
};
