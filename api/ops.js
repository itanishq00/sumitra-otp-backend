// Agency operations (sab auth ke saath, admin SDK se; Firestore rules nahi badle).
// Actions: cancel-booking, set-slot, service-request (customer) | owner-booking, cash-add, cash-list (owner)
const admin = require('./_lib/firebase');
const { sendToUsers, ownerUids } = require('./_lib/notify');

const GAP_DAYS = 45;
const SLOTS = ['Kabhi bhi', 'Subah (8-12)', 'Dopahar (12-4)', 'Shaam (4-8)'];
const KINDS = ['Mechanic visit', 'Safety check', 'Rubber pipe / regulator'];

class HttpError extends Error { constructor(code, msg, extra) { super(msg); this.code = code; this.extra = extra || {}; } }
const db = () => admin.firestore();
const FV = () => admin.firestore.FieldValue;
const ms = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : 0);
const istDate = (now = Date.now()) => new Date(now + 5.5 * 3600e3).toISOString().slice(0, 10);
const isActive = (d) => !['Rejected', 'Delivered', 'Cancelled'].includes(String(d.get('status') || '')) && !['DELIVERED', 'CANCELLED'].includes(String(d.get('orderStatus') || ''));
const safe = async (fn) => { try { await fn(); } catch (e) { console.error('ops side-effect:', e.message); } };
const audit = (agencyId, uid, role, action, targetType, targetId, newValue) => safe(() => db().collection('auditLogs').add({
  agencyId: agencyId || 'platform', actorId: uid, actorEmail: '', actorRole: role, action, targetType, targetId,
  oldValue: null, newValue: newValue || null, timestamp: FV().serverTimestamp(),
}));

async function caller(req) {
  const h = String(req.headers.authorization || req.headers.Authorization || '');
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!tok) throw new HttpError(401, 'Login zaroori hai.');
  try { return await admin.auth().verifyIdToken(tok); } catch (_) { throw new HttpError(401, 'Login expire ho gaya. Dobara login karo.'); }
}
async function ownerAgency(dec) {
  const a = await db().doc(`admins/${dec.uid}`).get();
  if (a.exists && a.get('status') === 'ACTIVE' && a.get('agencyId')) return a.get('agencyId');
  if (dec.role === 'owner' && dec.agencyId) return dec.agencyId;
  throw new HttpError(403, 'Sirf agency owner ye kar sakta hai.');
}

async function cancelBooking(dec, b) {
  const ref = db().doc(`bookings/${String(b.bookingId || '')}`); const s = await ref.get();
  if (!b.bookingId || !s.exists || s.get('customerId') !== dec.uid) throw new HttpError(404, 'Booking nahi mili.');
  if (s.get('status') !== 'Pending' || s.get('agentUid')) throw new HttpError(409, 'Sirf pending booking (approve hone se pehle) cancel ho sakti hai.');
  await ref.update({ status: 'Rejected', cancelledByCustomer: true, cancelReason: 'Customer ne khud cancel kiya', cancelledAt: FV().serverTimestamp(), updatedAt: FV().serverTimestamp() });
  const all = await db().collection('bookings').where('customerId', '==', dec.uid).get();
  let prev = null;
  for (const d of all.docs) { if (d.id === s.id || d.get('status') === 'Rejected') continue; if (!prev || ms(d.get('createdAt')) > ms(prev.get('createdAt'))) prev = d; }
  await db().doc(`customers/${dec.uid}`).set(prev
    ? { lastBookingAt: prev.get('createdAt'), lastBookingId: prev.id, updatedAt: FV().serverTimestamp() }
    : { lastBookingAt: FV().delete(), lastBookingId: FV().delete(), updatedAt: FV().serverTimestamp() }, { merge: true });
  const agencyId = s.get('agencyId');
  await audit(agencyId, dec.uid, 'customer', 'BOOKING_CANCELLED_BY_CUSTOMER', 'booking', s.id);
  await safe(async () => sendToUsers(await ownerUids(agencyId), { type: 'BOOKING_CANCELLED', agencyId, bookingId: s.id, dedupeKey: `BOOKING_CANCELLED_${s.id}`,
    title: 'Booking cancel hui', body: `${s.get('customerName') || 'Customer'} ne apni booking cancel ki.` }));
  return { message: 'Booking cancel ho gayi.' };
}

async function setSlot(dec, b) {
  if (!SLOTS.includes(b.slot)) throw new HttpError(400, 'Galat time slot.');
  const ref = db().doc(`bookings/${String(b.bookingId || '')}`); const s = await ref.get();
  if (!b.bookingId || !s.exists || s.get('customerId') !== dec.uid) throw new HttpError(404, 'Booking nahi mili.');
  if (s.get('status') !== 'Pending') throw new HttpError(409, 'Slot sirf pending booking me badal sakte hain.');
  await ref.update({ preferredSlot: b.slot, updatedAt: FV().serverTimestamp() });
  return { message: 'Slot save ho gaya.' };
}

async function serviceRequest(dec, b) {
  if (!KINDS.includes(b.kind)) throw new HttpError(400, 'Galat request type.');
  const c = await db().doc(`customers/${dec.uid}`).get();
  if (!c.exists || !c.get('agencyId')) throw new HttpError(404, 'Customer account nahi mila.');
  const agencyId = c.get('agencyId');
  const ref = await db().collection('issues').add({
    agencyId, customerId: dec.uid, customerName: c.get('name') || 'Customer', customerMobile: c.get('mobile') || '',
    consumerNumber: c.get('consumerNumber') || '', title: b.kind, description: String(b.note || '').slice(0, 500),
    category: 'Mechanic / Safety', status: 'Open', priority: 'Normal', isSafety: false, source: 'customerApp-service',
    createdAt: FV().serverTimestamp(), updatedAt: FV().serverTimestamp(),
  });
  await audit(agencyId, dec.uid, 'customer', 'SERVICE_REQUEST', 'complaint', ref.id, { kind: b.kind });
  await safe(async () => sendToUsers(await ownerUids(agencyId), { type: 'COMPLAINT_CREATED', agencyId, complaintId: ref.id, dedupeKey: `SERVICE_${ref.id}`,
    title: '🔧 Naya service request', body: `${c.get('name') || 'Customer'}: ${b.kind}` }));
  return { message: 'Request bhej di gayi. Agency aapse sampark karegi.', complaintId: ref.id };
}

async function ownerBooking(dec, b) {
  const agencyId = await ownerAgency(dec);
  const cref = db().doc(`customers/${String(b.customerId || '')}`); const c = await cref.get();
  if (!b.customerId || !c.exists || c.get('agencyId') !== agencyId) throw new HttpError(404, 'Customer aapki agency me nahi mila.');
  if ((c.get('verificationStatus') || 'verified') !== 'verified' || c.get('active') === false) throw new HttpError(409, 'Customer verified / active nahi hai.');
  const type = String(c.get('assignedCylinderType') || '');
  if (!type) throw new HttpError(409, 'Pehle is customer ko cylinder assign karo.');
  const hist = await db().collection('bookings').where('customerId', '==', c.id).get();
  if (hist.docs.some(isActive)) throw new HttpError(409, 'Is customer ki ek booking pehle se chal rahi hai.');
  const last = ms(c.get('lastBookingAt'));
  const days = last ? Math.floor((Date.now() - last) / 86400e3) : null;
  if (days !== null && days < GAP_DAYS && b.force !== true) {
    throw new HttpError(412, `Pichhli booking ${days} din pehle hui thi (${GAP_DAYS} din ka niyam).`, { needsForce: true });
  }
  let unitPrice = null;
  for (const id of [`${agencyId}__prices`, 'prices']) {
    const p = await db().doc(`settings/${id}`).get();
    const v = p.exists ? (p.get('prices') || {})[type] : undefined;
    if (typeof v === 'number') { unitPrice = Math.round(v); break; }
  }
  const ref = db().collection('bookings').doc();
  const batch = db().batch();
  batch.set(ref, {
    agencyId, customerId: c.id, customerName: c.get('name') || 'Customer', customerMobile: c.get('mobile') || '',
    consumerNumber: c.get('consumerNumber') || null, cylinderType: type, quantity: 1, status: 'Pending',
    ...(unitPrice !== null ? { unitPrice, totalAmount: unitPrice, paymentMethod: 'COD', paymentStatus: 'CASH_PENDING' } : {}),
    source: 'ownerApp', bookedByOwner: dec.uid, gapOverride: days !== null && days < GAP_DAYS,
    bookingDate: FV().serverTimestamp(), createdAt: FV().serverTimestamp(), updatedAt: FV().serverTimestamp(),
  });
  batch.update(cref, { lastBookingAt: FV().serverTimestamp(), lastBookingId: ref.id, updatedAt: FV().serverTimestamp() });
  await batch.commit();
  await audit(agencyId, dec.uid, 'owner', 'OWNER_BOOKING_FOR_CUSTOMER', 'booking', ref.id, { customerId: c.id, force: b.force === true });
  await safe(() => sendToUsers([c.id], { type: 'BOOKING_CREATED', agencyId, bookingId: ref.id, dedupeKey: `OWNER_BOOKING_${ref.id}`,
    title: 'Aapki booking ho gayi', body: `Agency ne aapke liye 1 × ${type} cylinder book kiya hai.` }));
  return { message: 'Booking ho gayi (Pending).', bookingId: ref.id };
}

async function cashAdd(dec, b) {
  const agencyId = await ownerAgency(dec);
  const amount = Math.round(Number(b.amount));
  if (!Number.isFinite(amount) || amount < 1 || amount > 500000) throw new HttpError(400, 'Sahi amount daalo.');
  const a = await db().doc(`deliveryAgents/${String(b.agentId || '')}`).get();
  if (!b.agentId || !a.exists || a.get('agencyId') !== agencyId) throw new HttpError(404, 'Agent aapki agency me nahi mila.');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(b.date || '')) ? b.date : istDate();
  const ref = await db().collection('cashDeposits').add({
    agencyId, agentId: a.id, agentName: a.get('name') || 'Agent', amount, note: String(b.note || '').slice(0, 200), date,
    by: dec.uid, createdAt: FV().serverTimestamp(),
  });
  await audit(agencyId, dec.uid, 'owner', 'AGENT_CASH_DEPOSIT', 'deliveryAgent', a.id, { amount, date });
  return { message: 'Jama likh diya.', id: ref.id };
}

async function cashList(dec, b) {
  const agencyId = await ownerAgency(dec);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(b.date || '')) ? b.date : istDate();
  const s = await db().collection('cashDeposits').where('agencyId', '==', agencyId).where('date', '==', date).get();
  return { date, deposits: s.docs.map((d) => ({ id: d.id, agentId: d.get('agentId'), agentName: d.get('agentName'), amount: d.get('amount'), note: d.get('note') || '', at: ms(d.get('createdAt')) })) };
}


async function deleteAccount(dec) {
  const cref = db().doc(`customers/${dec.uid}`); const c = await cref.get();
  if (!c.exists) throw new HttpError(404, 'Customer account nahi mila.');
  if (dec.role && dec.role !== 'customer') throw new HttpError(403, 'Ye customer account nahi hai.');
  const hist = await db().collection('bookings').where('customerId', '==', dec.uid).get();
  if (hist.docs.some(isActive)) throw new HttpError(409, 'Aapki ek booking chal rahi hai. Pehle use poora ya cancel karo.');
  await cref.set({
    deleted: true, deletedAt: FV().serverTimestamp(), active: false, verificationStatus: 'deleted', name: 'Deleted user',
    mobile: FV().delete(), email: FV().delete(), updatedAt: FV().serverTimestamp(),
  }, { merge: true });
  await safe(() => db().collection('fcmTokens').doc(dec.uid).delete());
  await audit(c.get('agencyId'), dec.uid, 'customer', 'ACCOUNT_DELETED', 'customer', dec.uid);
  await admin.auth().deleteUser(dec.uid);
  return { message: 'Account delete ho gaya.' };
}

const ACTIONS = { 'delete-account': deleteAccount, 'cancel-booking': cancelBooking, 'set-slot': setSlot, 'service-request': serviceRequest, 'owner-booking': ownerBooking, 'cash-add': cashAdd, 'cash-list': cashList };

module.exports = async (req, res) => {
  if (req.method === 'GET') return res.status(200).json({ success: true, message: 'ops ready' });
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method not allowed' });
  try {
    const b = req.body || {};
    const fn = ACTIONS[String(b.action || '')];
    if (!fn) throw new HttpError(400, 'Galat action.');
    const dec = await caller(req);
    const out = await fn(dec, b);
    return res.status(200).json({ success: true, ...out });
  } catch (e) {
    if (e instanceof HttpError) return res.status(e.code).json({ success: false, message: e.message, ...e.extra });
    console.error('ops error:', e);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};
module.exports.SLOTS = SLOTS;
