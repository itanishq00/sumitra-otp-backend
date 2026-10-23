// Roz Vercel cron se: 48 ghante+ khuli complaints -> escalate + owner ko notification.
const admin = require('./_lib/firebase');
const { sendToUsers, ownerUids } = require('./_lib/notify');
const { Timestamp } = require('firebase-admin/firestore');
const { runSettlements, runPendingReminders } = require('./_lib/emergency');
const { runDutyCleanup } = require('./_lib/duty');

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


const GAP_DAYS = 45;
// 45 din poore hone par customer ko "agli booking" reminder (ek booking par ek hi baar).
async function runReminders({ dry = false, now = Date.now() } = {}) {
  const db = admin.firestore();
  const FV = admin.firestore.FieldValue;
  const cutoff = Timestamp.fromMillis(now - GAP_DAYS * 86400e3);
  const snap = await db.collection('customers').where('lastBookingAt', '<=', cutoff).limit(500).get();
  const due = [];
  for (const d of snap.docs) {
    const bid = d.get('lastBookingId');
    if (!bid || d.get('reminderSentFor') === bid || d.get('verificationStatus') === 'rejected') continue;
    const bk = await db.doc(`bookings/${bid}`).get();
    if (bk.exists && ['Pending', 'Approved', 'Partially Confirmed'].includes(bk.get('status')) && bk.get('orderStatus') !== 'DELIVERED') continue;
    due.push(d);
  }
  let sent = 0;
  if (!dry) {
    for (const d of due) {
      try {
        await sendToUsers([d.id], {
          type: 'BOOKING_REMINDER', agencyId: d.get('agencyId') || null, dedupeKey: `BOOKING_REMINDER_${d.get('lastBookingId')}`,
          title: '🔔 Agli booking ka samay', body: `${GAP_DAYS} din poore ho gaye. Ab aap naya cylinder book kar sakte ho.`,
        });
        sent++;
      } catch (e) { console.error('reminder:', e.message); }
      await d.ref.update({ reminderSentFor: d.get('lastBookingId'), reminderSentAt: FV.serverTimestamp() });
    }
  }
  return { due: due.length, sent, ids: due.map((d) => d.id) };
}

module.exports = async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ success: false, message: 'Unauthorized' });
  try {
    const dry = String((req.query && req.query.dry) || '') === '1';
    const esc = await runEscalation({ dry });
    let emg = { due: 0, created: 0 }; let pend = { pending: 0, reminded: 0, escalated: 0 };
    try { emg = await runSettlements({ dry }); pend = await runPendingReminders({ dry }); } catch (e) { console.error('emergency cron:', e.message); }
    let duty = { old: 0 }; try { duty = await runDutyCleanup({ dry }); } catch (e) { console.error('duty cleanup:', e.message); }
    const rem = await runReminders({ dry });
    return res.status(200).json({ success: true, ...esc, reminders: { due: rem.due, sent: rem.sent }, emergency: { ...emg, ...pend }, duty });
  } catch (e) {
    console.error('escalate error:', e);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};
module.exports.runEscalation = runEscalation;
module.exports.runReminders = runReminders;
