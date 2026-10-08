const admin = require('./_lib/firebase');
const { cors, httpError } = require('./_lib/auth');
const { ownerUids, sendToUsers } = require('./_lib/notify');

const FAIL = ['CUSTOMER_NOT_AVAILABLE', 'WRONG_ADDRESS', 'DELIVERY_FAILED', 'PAYMENT_FAILED'];
const BOOKING_EVENTS = [
  'BOOKING_CREATED', 'BOOKING_APPROVED', 'BOOKING_REJECTED', 'AGENT_ASSIGNED',
  'AGENT_ACCEPTED', 'AGENT_REJECTED', 'OUT_FOR_DELIVERY', 'ARRIVED', 'DELIVERY_FAILED',
];

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

async function verify(req) {
  const m = (req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (!m) throw httpError(401, 'Login required.');
  try {
    return await admin.auth().verifyIdToken(m[1]);
  } catch (_) {
    throw httpError(401, 'Session expire ho gaya.');
  }
}

const mark = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : Date.now());
const label = (b) => `${b.quantity || 1} × ${b.cylinderType || 'Cylinder'}`;

module.exports = async (req, res) => {
  if (cors(req, res)) return;

  if (req.method === 'GET') {
    try {
      admin.ensureApp();
      return send(res, 200, true, 'notify ready');
    } catch (e) {
      return send(res, 500, false, `Init error: ${e.message}`);
    }
  }
  if (req.method !== 'POST') return send(res, 405, false, 'Method not allowed');

  let user;
  try {
    user = await verify(req);
  } catch (e) {
    return send(res, e.status || 401, false, e.message);
  }

  const { event, refId } = parseBody(req);
  if (!event || !refId || typeof refId !== 'string') {
    return send(res, 400, false, 'event aur refId zaroori hain.');
  }

  const db = admin.firestore();
  const isOwner = async () => user.role === 'owner'
    || (await db.collection('admins').doc(user.uid).get()).exists;
  const isAgent = user.role === 'delivery_agent';
  const deny = () => send(res, 403, false, 'Not allowed.');
  const done = (r) => send(res, 200, true, 'ok', { sent: r ? r.sent : 0 });

  try {
    // ---------------- BOOKING EVENTS ----------------
    if (BOOKING_EVENTS.includes(event)) {
      const snap = await db.collection('bookings').doc(refId).get();
      if (!snap.exists) return send(res, 404, false, 'Booking nahi mili.');
      const b = snap.data();
      const key = `${event}_${refId}_${mark(b.updatedAt)}`;
      const base = { type: event, bookingId: refId, dedupeKey: key };
      const cname = b.customerName || 'Customer';

      if (event === 'BOOKING_CREATED') {
        if (b.customerId !== user.uid) return deny();
        return done(await sendToUsers(await ownerUids(), {
          ...base, dedupeKey: `${event}_${refId}`,
          title: 'Nayi booking 🔔', body: `${cname}: ${label(b)}`,
        }));
      }

      if (event === 'BOOKING_APPROVED') {
        if (!(await isOwner())) return deny();
        return done(await sendToUsers([b.customerId], {
          ...base, title: 'Booking confirmed ✅',
          body: `Your ${b.cylinderType || ''} cylinder booking is confirmed.`,
        }));
      }

      if (event === 'BOOKING_REJECTED') {
        if (!(await isOwner())) return deny();
        return done(await sendToUsers([b.customerId], {
          ...base, title: 'Booking cancelled',
          body: b.ownerNote ? `Reason: ${b.ownerNote}` : 'Your booking was cancelled by the agency.',
        }));
      }

      if (event === 'AGENT_ASSIGNED') {
        if (!(await isOwner())) return deny();
        await sendToUsers([b.agentUid], {
          ...base, dedupeKey: `${key}_agent`,
          title: 'Nayi delivery assign hui 🚚', body: `${cname} • ${label(b)}`,
        });
        return done(await sendToUsers([b.customerId], {
          ...base, title: 'Delivery agent assigned',
          body: `${b.agentName || 'A delivery agent'} will deliver your cylinder.`,
        }));
      }

      // ----- Agent events -----
      if (!isAgent) return deny();

      if (event === 'AGENT_REJECTED') {
        if (b.orderStatus !== 'CONFIRMED' || b.agentRejectedBy !== user.agentId) return deny();
        return done(await sendToUsers(await ownerUids(), {
          ...base, title: 'Agent ne delivery reject ki ⚠️',
          body: `${cname} • Reason: ${b.agentRejectReason || '-'}. Dobara assign karo.`,
        }));
      }

      if (b.agentUid !== user.uid) return deny();
      const agentName = b.agentName || 'Agent';

      if (event === 'AGENT_ACCEPTED' && b.orderStatus === 'ACCEPTED') {
        return done(await sendToUsers(await ownerUids(), {
          ...base, title: 'Delivery accepted',
          body: `${agentName} ne ${cname} ki delivery accept ki.`,
        }));
      }

      if (event === 'OUT_FOR_DELIVERY' && b.orderStatus === 'OUT_FOR_DELIVERY') {
        await sendToUsers(await ownerUids(), {
          ...base, dedupeKey: `${key}_owner`,
          title: 'Delivery shuru', body: `${agentName} → ${cname}`,
        });
        return done(await sendToUsers([b.customerId], {
          ...base, title: 'Out for delivery 🚚', body: 'Your cylinder is out for delivery.',
        }));
      }

      if (event === 'ARRIVED' && b.orderStatus === 'ARRIVED') {
        return done(await sendToUsers([b.customerId], {
          ...base, title: 'Delivery agent has arrived',
          body: `${agentName} is at your location.`,
        }));
      }

      if (event === 'DELIVERY_FAILED' && FAIL.includes(b.orderStatus)) {
        await sendToUsers(await ownerUids(), {
          ...base, dedupeKey: `${key}_owner`,
          title: 'Delivery fail ⚠️',
          body: `${cname}: ${b.failureReason || b.orderStatus}. Dobara assign karo.`,
        });
        return done(await sendToUsers([b.customerId], {
          ...base, title: 'Delivery not completed',
          body: 'We could not deliver your cylinder. The agency will contact you.',
        }));
      }

      return deny();
    }

    // ---------------- CUSTOMER ACCOUNT ----------------
    if (event === 'CUSTOMER_APPROVED') {
      if (!(await isOwner())) return deny();
      const c = await db.collection('customers').doc(refId).get();
      if (!c.exists || c.data().verificationStatus !== 'verified') return deny();
      return done(await sendToUsers([refId], {
        type: event, dedupeKey: `${event}_${refId}`,
        title: 'Account approved ✅',
        body: `Your consumer number is ${c.data().consumerNumber || ''}. You can now book your cylinder.`,
      }));
    }

    // ---------------- COMPLAINTS ----------------
    if (event === 'COMPLAINT_CREATED' || event === 'COMPLAINT_RESOLVED') {
      const i = await db.collection('issues').doc(refId).get();
      if (!i.exists) return send(res, 404, false, 'Complaint nahi mili.');
      const d = i.data();

      if (event === 'COMPLAINT_CREATED') {
        if (d.customerId !== user.uid) return deny();
        return done(await sendToUsers(await ownerUids(), {
          type: event, complaintId: refId, dedupeKey: `${event}_${refId}`,
          title: d.priority === 'Urgent' ? '🚨 Urgent complaint' : 'Nayi complaint',
          body: `${d.customerName || 'Customer'}: ${d.title || ''}`,
        }));
      }

      if (!(await isOwner())) return deny();
      if (d.status !== 'Resolved') return deny();
      return done(await sendToUsers([d.customerId], {
        type: event, complaintId: refId, dedupeKey: `${event}_${refId}_${mark(d.resolvedAt)}`,
        title: 'Complaint resolved ✅', body: `"${d.title || 'Your complaint'}" has been resolved.`,
      }));
    }

    return send(res, 400, false, 'Unknown event.');
  } catch (e) {
    console.error('notify error:', e);
    return send(res, 500, false, `Server error: ${e.message || e}`);
  }
};
