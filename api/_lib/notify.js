const admin = require('./firebase');
const { AGENCY_ID } = require('./auth');

// Sirf ye notifications bheje jaate hain. Aur chahiye to yahan naam jodo,
// jaise 'AGENT_ASSIGNED', 'OUT_FOR_DELIVERY', 'DELIVERED'.
const ENABLED_TYPES = new Set(['COMPLAINT_CREATED']);

async function ownerUids() {
  const snap = await admin.firestore().collection('admins').get();
  return snap.docs.map((d) => d.id);
}

// Har recipient ke liye notifications/{dedupeKey}_{uid} banata hai.
// Doc pehle se ho (retry) to dobara push nahi bhejta.
async function sendToUsers(uids, { type, title, body, bookingId = null, complaintId = null, dedupeKey }) {
  const db = admin.firestore();
  const FieldValue = admin.firestore.FieldValue;
  if (!ENABLED_TYPES.has(type)) return { sent: 0, disabled: true };
  const unique = [...new Set((uids || []).filter(Boolean))];
  if (!unique.length) return { sent: 0 };

  const fresh = [];
  for (const uid of unique) {
    const id = `${dedupeKey}_${uid}`.replace(/\//g, '_').slice(0, 1000);
    const ref = db.collection('notifications').doc(id);
    try {
      await ref.create({
        notificationId: id,
        recipientId: uid,
        agencyId: AGENCY_ID,
        type,
        title,
        body,
        relatedOrderId: bookingId,
        relatedComplaintId: complaintId,
        createdAt: FieldValue.serverTimestamp(),
        readAt: null,
      });
      fresh.push(uid);
    } catch (e) {
      if (e.code === 6 || /already exists/i.test(e.message || '')) continue;
      throw e;
    }
  }
  if (!fresh.length) return { sent: 0, duplicate: true };

  const tokens = [];
  for (let i = 0; i < fresh.length; i += 30) {
    const snap = await db.collection('fcmTokens').where('uid', 'in', fresh.slice(i, i + 30)).get();
    snap.docs.forEach((d) => tokens.push(d.id));
  }
  if (!tokens.length) return { sent: 0 };

  const res = await admin.messaging().sendEachForMulticast({
    tokens,
    notification: { title, body },
    data: { type: String(type), bookingId: bookingId || '', complaintId: complaintId || '' },
    android: { priority: 'high' },
    apns: { payload: { aps: { sound: 'default' } } },
  });

  // Purane / band tokens hata do
  const dead = [];
  res.responses.forEach((r, i) => {
    const code = r.error && r.error.code;
    if (!r.success && (code === 'messaging/registration-token-not-registered'
      || code === 'messaging/invalid-registration-token')) {
      dead.push(tokens[i]);
    }
  });
  await Promise.all(dead.map((t) => db.collection('fcmTokens').doc(t).delete().catch(() => {})));

  return { sent: res.successCount };
}

// Notification fail hone se asli kaam (delivery wagairah) fail na ho.
async function safe(fn) {
  try {
    return await fn();
  } catch (e) {
    console.error('notify error:', e);
    return null;
  }
}

module.exports = { ownerUids, sendToUsers, safe };
