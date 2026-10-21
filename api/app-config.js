// Public app config: force-update (minBuild) + feature flags. Firestore: config/app (sirf admin SDK padhta hai).
const admin = require('./_lib/firebase');
const DEFAULT_FLAGS = { onlinePayment: false, kyc: false };
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  try {
    const s = await admin.firestore().doc('config/app').get();
    const d = s.exists ? s.data() : {};
    return res.status(200).json({ success: true, apps: d.apps || {}, flags: { ...DEFAULT_FLAGS, ...(d.flags || {}) }, notice: String(d.notice || '') });
  } catch (e) {
    console.error('app-config:', e.message);
    return res.status(200).json({ success: true, apps: {}, flags: DEFAULT_FLAGS, notice: '' });
  }
};
