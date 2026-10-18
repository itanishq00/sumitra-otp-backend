// Roz Vercel cron se: 48 ghante+ khuli complaints -> escalate + owner ko notification.
const admin = require('./_lib/firebase');
const { sendToUsers, ownerUids } = require('./_lib/notify');

const HOURS = 48;
const ACTIVE = ['Open', 'In Progress'];

function authorized(req) {
  const secret = process.env.CRON_SECRET || '';
  const h = String(req.headers.authorization || req.headers.Authorization || '');
  return secret.length >= 16 && h === `Bearer ${secret}`;
}

async function runEscalation({ dry = false, now = Date.now() } = {}) {
  const db = admin.firestore();
  const FV = admin.firestore.FieldValue;
  const snap = await db.collection('issues').where('status', 'in', ACTIVE).get();
  const cutoff = now - HOURS * 3600 * 1000;
  const due = snap.docs.filter((d) => {
    const c = d.get('createdAt');
    return c && typeof c.toMillis === 'function' && c.toMillis() <= cutoff && !d.get('escalatedAt');
  });
  let notified = 0;
  if (!dry) {
    for (const d of due) {
      const x = d.data();
      const agencyId = x.agencyId || null;
      await d.ref.update({ escalatedAt: FV.serverTimestamp(), escalationLevel: 1 });
      try {
        await sendToUsers(await ownerUids(agencyId), {
          type: 'COMPLAINT_ESCALATED',
          agencyId,
          complaintId: d.id,
          dedupeKey: `COMPLAINT_ESCALATED_${d.id}`,
          title: '⏰ Complaint 48 ghante se khuli',
          body: `${x.customerName || 'Customer'}: ${x.title || 'Complaint'}. Jaldi resolve karo.`,
        });
        notified++;
      } catch (e) {
        console.error('escalate notify:', e.message);
      }
      try {
        await db.collection('auditLogs').add({
          agencyId: agencyId || 'platform', actorId: 'cron', actorEmail: '', actorRole: 'system',
          action: 'COMPLAINT_ESCALATED', targetType: 'complaint', targetId: d.id,
          oldValue: null, newValue: { hours: HOURS }, timestamp: FV.serverTimestamp(),
        });
      } catch (_) {}
    }
  }
  return { open: snap.size, due: due.length, notified, dry };
}

module.exports = async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ success: false, message: 'Unauthorized' });
  try {
    const dry = String((req.query && req.query.dry) || '') === '1';
    return res.status(200).json({ success: true, ...(await runEscalation({ dry })) });
  } catch (e) {
    console.error('escalate error:', e);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};
module.exports.runEscalation = runEscalation;
