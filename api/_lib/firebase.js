// firebase-admin modular API, lazy load.
// File load hote waqt kuch nahi hota; pehli zarurat par init hota hai.
// Isse init fail ho to function crash nahi karta, error message milta hai.
let mods = null;

function load() {
  if (!mods) {
    mods = {
      app: require('firebase-admin/app'),
      auth: require('firebase-admin/auth'),
      fs: require('firebase-admin/firestore'),
    };
  }
  return mods;
}

function ensureApp() {
  const { app } = load();
  if (app.getApps().length) return;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '')
    .replace(/^"|"$/g, '')
    .replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      'Firebase env variables server par missing hain ' +
      '(FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY).'
    );
  }

  app.initializeApp({
    credential: app.cert({ projectId, clientEmail, privateKey }),
  });
}

const firestore = () => {
  ensureApp();
  return load().fs.getFirestore();
};
Object.defineProperty(firestore, 'FieldValue', {
  get: () => load().fs.FieldValue,
});

module.exports = {
  ensureApp,
  auth: () => {
    ensureApp();
    return load().auth.getAuth();
  },
  firestore,
};
