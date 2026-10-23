// Duty logs: 6 mahine se purane records roz cron me mitao.
const admin = require('./firebase');

async function runDutyCleanup({ dry = false, now = Date.now() } = {}) {
  const db = admin.firestore();
  const cutoff = now - 190 * 86400e3;
  const s = await db.collection('dutyLogs').where('atMs', '<', cutoff).limit(400).get();
  if (!dry && s.size) {
    const b = db.batch();
    s.docs.forEach((d) => b.delete(d.ref));
    await b.commit();
  }
  return { old: s.size };
}

module.exports = { runDutyCleanup };
