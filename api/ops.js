// Agency operations (sab auth ke saath, admin SDK se; Firestore rules nahi badle).
// Actions: cancel-booking, set-slot, service-request (customer) | owner-booking, cash-add, cash-list (owner)
const admin = require('./_lib/firebase');
const { sendToUsers, ownerUids } = require('./_lib/notify');
const { otpDoc } = require('./_lib/emergency');

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
  const emergency = b.emergency === true;
  const reason = String(b.reason || '').trim().slice(0, 200);
  if (emergency) {
    if (reason.length < 5) throw new HttpError(400, 'Emergency ki wajah likho (kam se kam 5 akshar).');
    if (c.get('emergencyPendingId')) throw new HttpError(409, 'Is customer ka pichhla emergency cylinder ka hisaab (Pending OTP) abhi baaki hai.');
    if (days === null || days >= GAP_DAYS) throw new HttpError(409, `${GAP_DAYS} din poore hain. Emergency ki zaroorat nahi, normal booking karo.`);
  }
  if (days !== null && days < GAP_DAYS && b.force !== true && !emergency) {
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
    ...(emergency ? { isEmergency: true, emergencyReason: reason, emergencyDueAtMs: last + GAP_DAYS * 86400e3, prevLastBookingId: c.get('lastBookingId') || null } : {}),
    bookingDate: FV().serverTimestamp(), createdAt: FV().serverTimestamp(), updatedAt: FV().serverTimestamp(),
  });
  if (!emergency) batch.update(cref, { lastBookingAt: FV().serverTimestamp(), lastBookingId: ref.id, updatedAt: FV().serverTimestamp() });
  await batch.commit();
  await audit(agencyId, dec.uid, 'owner', emergency ? 'EMERGENCY_BOOKING' : 'OWNER_BOOKING_FOR_CUSTOMER', 'booking', ref.id, { customerId: c.id, force: b.force === true, emergency, reason: emergency ? reason : null });
  if (!emergency) await safe(() => ROUTE.assignRoute(ref.id));
  await safe(() => sendToUsers([c.id], { type: 'BOOKING_CREATED', agencyId, bookingId: ref.id, dedupeKey: `OWNER_BOOKING_${ref.id}`,
    title: 'Aapki booking ho gayi', body: `Agency ne aapke liye 1 × ${type} cylinder book kiya hai.` }));
  return { message: emergency ? 'Emergency booking ho gayi. Approve karke agent assign karo; agent ke pahunchne par "Bina OTP handover" karo.' : 'Booking ho gayi (Pending).', bookingId: ref.id };
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

// ---------- Emergency cylinder (bina OTP, owner handover) + Pending OTP ----------
const PENDING = 'pendingOtps';
const MAX_TRIES = 5;
const sizeKey = (t) => { t = String(t || ''); if (t.includes('14')) return '14'; if (t.includes('19')) return '19'; if (t.includes('5')) return '5'; return null; };
const prevDeducted = (x) => ((x.inventoryDeductedQty !== undefined && x.inventoryDeductedQty !== null) ? (Number(x.inventoryDeductedQty) || 0)
  : ((x.status === 'Confirmed' || x.status === 'Partially Confirmed') ? (Number(x.confirmedQuantity) || 0) : 0));

async function emergencyHandover(dec, b) {
  const agencyId = await ownerAgency(dec);
  const id = String(b.bookingId || '');
  if (!id) throw new HttpError(400, 'bookingId chahiye.');
  const bref = db().doc(`bookings/${id}`);
  const adm = await db().doc(`admins/${dec.uid}`).get();
  const byName = String((adm.exists && (adm.get('name') || adm.get('ownerName'))) || dec.name || '').trim();
  const byEmail = String(dec.email || dec.phone_number || '').trim();
  const out = await db().runTransaction(async (tx) => {
    const s = await tx.get(bref);
    if (!s.exists || s.get('agencyId') !== agencyId) throw new HttpError(404, 'Booking aapki agency me nahi mili.');
    const x = s.data();
    if (x.isEmergency !== true) throw new HttpError(409, 'Ye emergency booking nahi hai. Normal delivery OTP se hogi.');
    if (x.orderStatus === 'DELIVERED') throw new HttpError(409, 'Ye booking pehle hi deliver ho chuki hai.');
    if (x.orderStatus !== 'ARRIVED' || !x.agentUid) throw new HttpError(409, 'Agent ne abhi "Arrived" mark nahi kiya. Agent ke pahunchne ke baad handover karo.');
    const cref = db().doc(`customers/${x.customerId}`);
    const cylRef = db().doc(`inventory/${agencyId}__cylinder`);
    const c = await tx.get(cref);
    const cyl = await tx.get(cylRef);
    if (c.exists && c.get('emergencyPendingId') && c.get('emergencyPendingId') !== id) throw new HttpError(409, 'Is customer ka ek aur emergency hisaab pending hai.');
    const qty = Math.max(1, parseInt(x.quantity, 10) || 1);
    const amount = Number(x.totalAmount) > 0 ? Number(x.totalAmount) : (Number(x.unitPrice) || 0) * qty;
    const paid = ['CASH_COLLECTED', 'ONLINE_PAID'].includes(x.paymentStatus);
    const needCash = (x.paymentMethod || 'COD') === 'COD' && !paid;
    if (needCash) {
      if (!(amount > 0)) throw new HttpError(400, 'Is booking ka amount set nahi hai. Cylinder Prices check karo.');
      if (Number(b.cashAmount) !== amount) throw new HttpError(400, `Amount match nahi hua. Is booking ka amount ₹${amount} hai.`, { amount });
    }
    const size = sizeKey(x.cylinderType);
    const upd = {};
    if (!(prevDeducted(x) > 0) && size) {
      const inv = cyl.data() || {};
      const filled = Number(inv[`filled${size}`]) || 0; const empty = Number(inv[`empty${size}`]) || 0;
      if (filled < qty) throw new HttpError(400, `Inventory me sirf ${filled} filled ${size} kg cylinder hain.`);
      tx.set(cylRef, { [`filled${size}`]: filled - qty, [`empty${size}`]: empty + qty, updatedAt: FV().serverTimestamp() }, { merge: true });
      Object.assign(upd, { inventoryDeductedQty: qty, inventoryDeductedType: x.cylinderType || '', confirmedQuantity: qty });
    }
    if (needCash) Object.assign(upd, { unitPrice: Number(x.unitPrice) || amount / qty, totalAmount: amount, paymentMethod: 'COD', paymentStatus: 'CASH_COLLECTED',
      paidAmount: amount, paymentCollectedAt: FV().serverTimestamp(), paymentCollectedBy: x.agentId || '' });
    const dueAtMs = Number(x.emergencyDueAtMs) || Date.now() + GAP_DAYS * 86400e3;
    tx.update(bref, { orderStatus: 'DELIVERED', status: 'Delivered', pendingQuantity: 0, deliveredAt: FV().serverTimestamp(), deliveredBy: x.agentId || '',
      verificationMethod: 'OWNER_EMERGENCY', verificationStatus: 'PENDING_OTP', handoverBy: dec.uid, handoverByName: byName, handoverByEmail: byEmail,
      statusChangedAt: FV().serverTimestamp(), updatedAt: FV().serverTimestamp(), ...upd });
    tx.delete(db().doc(`deliveryOtps/${id}`));
    if (needCash) tx.set(db().doc(`payments/pay_${id}`), { paymentId: `pay_${id}`, orderId: id, customerName: String(x.customerName || '').trim(), settled: false,
      customerId: x.customerId || '', agencyId, agentId: x.agentId || '', agentUid: x.agentUid, amount, paymentMethod: 'COD', paymentStatus: 'CASH_COLLECTED',
      transactionId: null, collectedAt: FV().serverTimestamp(), createdAt: FV().serverTimestamp(), updatedAt: FV().serverTimestamp() });
    tx.set(db().doc(`${PENDING}/${id}`), { agencyId, customerId: x.customerId, customerName: x.customerName || 'Customer', customerMobile: x.customerMobile || '',
      consumerNumber: x.consumerNumber || null, cylinderType: x.cylinderType || '', emergencyBookingId: id, reason: x.emergencyReason || '',
      amount: needCash ? amount : 0, agentUid: x.agentUid, status: 'WAITING', dueAtMs, deliveredAtMs: Date.now(), handoverBy: dec.uid,
      handoverByName: byName, handoverByEmail: byEmail, handoverAtMs: Date.now(), requestedAtMs: Number(x.handoverRequestedAtMs) || null,
      requestedByName: x.handoverRequestedByName || null, agentName: x.agentName || x.handoverRequestedByName || null,
      createdAt: FV().serverTimestamp(), updatedAt: FV().serverTimestamp() });
    tx.set(cref, { emergencyPendingId: id, updatedAt: FV().serverTimestamp() }, { merge: true });
    tx.set(db().collection('inventoryActivity').doc(), { agencyId, action: 'Emergency Cylinder Delivered', section: 'Cylinder', item: `${size || ''} kg Cylinder`,
      summary: `${qty} filled ${x.cylinderType || ''} cylinder ${x.customerName || 'Customer'} ko emergency me diya (bina OTP, owner handover).`, direction: 'out',
      customerName: x.customerName || '', consumerNumber: x.consumerNumber || '', customerId: x.customerId || '', bookingId: id,
      changedByUid: dec.uid, changedByName: 'Owner', changedByEmail: dec.email || '', source: 'emergency', changedAt: FV().serverTimestamp() });
    return { customerId: x.customerId, dueAtMs, amount: needCash ? amount : 0 };
  });
  await audit(agencyId, dec.uid, 'owner', 'EMERGENCY_HANDOVER_NO_OTP', 'booking', id, { dueAtMs: out.dueAtMs, amount: out.amount });
  await safe(() => sendToUsers([out.customerId], { type: 'DELIVERED', agencyId, bookingId: id, dedupeKey: `EMERGENCY_${id}`,
    title: 'Emergency cylinder diya gaya', body: `Agency ne aapko emergency cylinder diya hai. ${istDate(out.dueAtMs)} ko agli booking apne aap banegi, uska OTP agency ko batana hoga.` }));
  return { message: 'Emergency cylinder de diya gaya. Customer "Pending OTP" me hai.', dueDate: istDate(out.dueAtMs) };
}

async function pendingOtpList(dec) {
  const agencyId = await ownerAgency(dec);
  const s = await db().collection(PENDING).where('agencyId', '==', agencyId).get();
  const items = s.docs.filter((d) => !['SETTLED', 'REMOVED'].includes(d.get('status'))).map((d) => ({
    id: d.id, customerId: d.get('customerId'), customerName: d.get('customerName') || 'Customer', customerMobile: d.get('customerMobile') || '',
    consumerNumber: d.get('consumerNumber') || '', cylinderType: d.get('cylinderType') || '', reason: d.get('reason') || '', amount: d.get('amount') || 0,
    status: d.get('status'), dueAtMs: d.get('dueAtMs') || 0, dueDate: istDate(d.get('dueAtMs') || 0), deliveredAtMs: d.get('deliveredAtMs') || 0,
    settlementBookingId: d.get('settlementBookingId') || null, locked: d.get('locked') === true, escalated: !!d.get('escalatedAt'),
  })).sort((a, z) => a.dueAtMs - z.dueAtMs);
  return { items };
}

async function pendingOtpSettle(dec, b) {
  const agencyId = await ownerAgency(dec);
  const id = String(b.pendingId || ''); const entered = String(b.otp || '');
  if (!id) throw new HttpError(400, 'pendingId chahiye.');
  if (!/^\d{4}$/.test(entered)) throw new HttpError(400, '4-digit OTP daalo.');
  const pref = db().doc(`${PENDING}/${id}`);
  const r = await db().runTransaction(async (tx) => {
    const p = await tx.get(pref);
    if (!p.exists || p.get('agencyId') !== agencyId) throw new HttpError(404, 'Pending entry nahi mili.');
    if (p.get('status') === 'SETTLED') return { already: true };
    if (p.get('status') !== 'OTP_PENDING') throw new HttpError(409, `Abhi OTP nahi bana. ${istDate(p.get('dueAtMs') || Date.now())} ko customer ki booking apne aap banegi.`);
    const sid = p.get('settlementBookingId');
    const oref = db().doc(`deliveryOtps/${sid}`);
    const o = await tx.get(oref);
    const eb = await tx.get(db().doc(`bookings/${id}`));
    if (!o.exists) throw new HttpError(409, 'OTP nahi mila. "Naya OTP" bhejo.');
    const att = o.get('attempts') || 0;
    if ((o.get('expiresAtMs') || 0) < Date.now()) throw new HttpError(409, 'OTP expire ho gaya. "Naya OTP" bhejo.', { expired: true });
    if (att >= MAX_TRIES) throw new HttpError(429, 'Bahut baar galat OTP. "Naya OTP" bhejo (24 ghante me ek baar).', { locked: true });
    if (o.get('otp') !== entered) {
      tx.update(oref, { attempts: att + 1 });
      if (att + 1 >= MAX_TRIES) tx.update(pref, { locked: true, updatedAt: FV().serverTimestamp() });
      return { wrong: true, left: MAX_TRIES - att - 1 };
    }
    tx.update(db().doc(`bookings/${sid}`), { status: 'Delivered', orderStatus: 'DELIVERED', verificationMethod: 'OTP_SETTLEMENT', verificationStatus: 'VERIFIED',
      verifiedAt: FV().serverTimestamp(), deliveredAt: FV().serverTimestamp(), statusChangedAt: FV().serverTimestamp(), updatedAt: FV().serverTimestamp() });
    if (eb.exists) tx.update(db().doc(`bookings/${id}`), { verificationStatus: 'VERIFIED', settledBy: sid, verifiedAt: FV().serverTimestamp(), updatedAt: FV().serverTimestamp() });
    tx.delete(oref);
    tx.update(pref, { status: 'SETTLED', locked: false, settledAt: FV().serverTimestamp(), settledAtMs: Date.now(), settledBy: dec.uid, settledByEmail: String(dec.email || dec.phone_number || ''), updatedAt: FV().serverTimestamp() });
    tx.set(db().doc(`customers/${p.get('customerId')}`), { emergencyPendingId: FV().delete(), updatedAt: FV().serverTimestamp() }, { merge: true });
    return { done: true, customerId: p.get('customerId') };
  });
  if (r.wrong) throw new HttpError(400, `OTP galat hai. ${r.left} try baaki.`, { left: r.left });
  if (r.already) return { message: 'Ye hisaab pehle hi poora ho chuka hai.' };
  await audit(agencyId, dec.uid, 'owner', 'PENDING_OTP_SETTLED', 'booking', id);
  await safe(() => sendToUsers([r.customerId], { type: 'DELIVERED', agencyId, bookingId: id, dedupeKey: `SETTLED_${id}`,
    title: 'Emergency cylinder ka hisaab poora ✅', body: `Dhanyavaad! Agli booking ${GAP_DAYS} din baad kar sakte ho.` }));
  return { message: 'OTP sahi. Emergency cylinder ka hisaab poora ho gaya ✅' };
}

async function pendingOtpResend(dec, b) {
  const agencyId = await ownerAgency(dec);
  const id = String(b.pendingId || '');
  if (!id) throw new HttpError(400, 'pendingId chahiye.');
  const pref = db().doc(`${PENDING}/${id}`); const p = await pref.get();
  if (!p.exists || p.get('agencyId') !== agencyId) throw new HttpError(404, 'Pending entry nahi mili.');
  if (p.get('status') !== 'OTP_PENDING') throw new HttpError(409, 'Is entry ka OTP abhi bana nahi, ya hisaab poora ho chuka hai.');
  const sid = p.get('settlementBookingId'); const oref = db().doc(`deliveryOtps/${sid}`); const o = await oref.get();
  const usable = o.exists && (o.get('attempts') || 0) < MAX_TRIES && (o.get('expiresAtMs') || 0) > Date.now();
  if (usable) throw new HttpError(409, 'Purana OTP abhi chal raha hai. Customer apne app me dekh sakta hai.');
  if (o.exists && Date.now() - (o.get('sentAtMs') || 0) < 86400e3) throw new HttpError(429, 'Naya OTP 24 ghante me ek hi baar bhej sakte hain.');
  const n = p.get('resendCount') || 0;
  if (n >= 3) throw new HttpError(429, 'Naye OTP ki limit (3) khatam. Support se baat karo.');
  await oref.set(otpDoc(p.data(), sid));
  await pref.update({ resendCount: n + 1, locked: false, otpSentAtMs: Date.now(), updatedAt: FV().serverTimestamp() });
  await audit(agencyId, dec.uid, 'owner', 'PENDING_OTP_RESENT', 'booking', id, { count: n + 1 });
  await safe(() => sendToUsers([p.get('customerId')], { type: 'BOOKING_REMINDER', agencyId, bookingId: sid, dedupeKey: `PENDING_OTP_NEW_${id}_${n + 1}`,
    title: 'Naya OTP', body: 'Emergency cylinder ke hisaab ka naya OTP app me hai. Agency ko batayein.' }));
  return { message: 'Customer ko naya OTP bhej diya.' };
}

// ---------- Emergency history + Duty logs (owner, 6 mahine) ----------
const SIX_MONTHS = 183 * 86400e3;

async function emergencyHistory(dec) {
  const agencyId = await ownerAgency(dec);
  const cutoff = Date.now() - SIX_MONTHS;
  const s = await db().collection(PENDING).where('agencyId', '==', agencyId).get();
  const items = s.docs.map((d) => ({
    id: d.id, customerName: d.get('customerName') || 'Customer', customerMobile: d.get('customerMobile') || '',
    cylinderType: d.get('cylinderType') || '', reason: d.get('reason') || '', amount: d.get('amount') || 0, status: d.get('status') || '',
    agentName: d.get('agentName') || d.get('requestedByName') || '', requestedAtMs: d.get('requestedAtMs') || 0,
    handoverByName: d.get('handoverByName') || '', handoverByEmail: d.get('handoverByEmail') || '',
    handoverAtMs: d.get('handoverAtMs') || d.get('deliveredAtMs') || 0,
    settledByEmail: d.get('settledByEmail') || '', settledAtMs: d.get('settledAtMs') || ms(d.get('settledAt')) || 0,
    manual: d.get('manual') === true, removedReason: d.get('removedReason') || '', removedByName: d.get('removedByName') || '',
    removedByEmail: d.get('removedByEmail') || '', removedAtMs: d.get('removedAtMs') || 0,
  })).filter((x) => x.handoverAtMs >= cutoff).sort((a, z) => z.handoverAtMs - a.handoverAtMs);
  return { items };
}

async function dutyLogs(dec, b) {
  const agencyId = await ownerAgency(dec);
  const cutoff = Date.now() - SIX_MONTHS;
  const want = String(b.agentUid || '');
  const s = await db().collection('dutyLogs').where('agencyId', '==', agencyId).get();
  const logs = s.docs.map((d) => ({
    id: d.id, agentUid: d.get('agentUid') || '', agentId: d.get('agentId') || '', agentName: d.get('agentName') || 'Agent',
    on: d.get('on') === true, atMs: d.get('atMs') || ms(d.get('at')), lat: d.get('lat') ?? null, lng: d.get('lng') ?? null,
  })).filter((x) => x.atMs >= cutoff && (!want || x.agentUid === want)).sort((a, z) => z.atMs - a.atMs).slice(0, 3000);
  return { logs };
}

// ---------- Pending OTP: manually jodo / hatao (owner, audit ke saath) ----------
async function ownerWho(dec) {
  const adm = await db().doc(`admins/${dec.uid}`).get();
  return {
    name: String((adm.exists && (adm.get('name') || adm.get('ownerName'))) || dec.name || '').trim(),
    email: String(dec.email || dec.phone_number || '').trim(),
  };
}

async function pendingOtpAdd(dec, b) {
  const agencyId = await ownerAgency(dec);
  const q = String(b.customerQuery || '').trim();
  const reason = String(b.reason || '').trim().slice(0, 200);
  if (!q) throw new HttpError(400, 'Consumer number ya mobile daalo.');
  if (reason.length < 5) throw new HttpError(400, 'Wajah likho (kam se kam 5 akshar).');
  let s = await db().collection('customers').where('agencyId', '==', agencyId).where('consumerNumber', '==', q).limit(1).get();
  if (s.empty) s = await db().collection('customers').where('agencyId', '==', agencyId).where('mobile', '==', q).limit(1).get();
  if (s.empty) throw new HttpError(404, 'Is consumer number / mobile ka customer aapki agency me nahi mila.');
  const c = s.docs[0];
  if (c.get('deleted') === true || c.get('active') === false) throw new HttpError(409, 'Customer active nahi hai.');
  if (c.get('emergencyPendingId')) throw new HttpError(409, 'Is customer ki ek Pending OTP entry pehle se hai.');
  let dueAtMs = 0;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(b.dueDate || ''))) dueAtMs = Date.parse(`${b.dueDate}T09:00:00+05:30`) || 0;
  if (!dueAtMs) { const last = ms(c.get('lastBookingAt')); dueAtMs = (last || Date.now()) + GAP_DAYS * 86400e3; }
  const who = await ownerWho(dec);
  const ref = db().collection(PENDING).doc();
  const batch = db().batch();
  batch.set(ref, {
    agencyId, customerId: c.id, customerName: c.get('name') || 'Customer', customerMobile: c.get('mobile') || '',
    consumerNumber: c.get('consumerNumber') || null, cylinderType: c.get('assignedCylinderType') || '', emergencyBookingId: null,
    reason, amount: 0, status: 'WAITING', dueAtMs, manual: true,
    handoverBy: dec.uid, handoverByName: who.name, handoverByEmail: who.email, handoverAtMs: Date.now(), deliveredAtMs: Date.now(),
    createdAt: FV().serverTimestamp(), updatedAt: FV().serverTimestamp(),
  });
  batch.set(c.ref, { emergencyPendingId: ref.id, updatedAt: FV().serverTimestamp() }, { merge: true });
  await batch.commit();
  await audit(agencyId, dec.uid, 'owner', 'PENDING_OTP_MANUAL_ADD', 'customer', c.id, { pendingId: ref.id, reason, dueAtMs });
  return { message: `Entry jod di. Auto booking: ${istDate(dueAtMs)}.`, pendingId: ref.id, dueDate: istDate(dueAtMs) };
}

async function pendingOtpRemove(dec, b) {
  const agencyId = await ownerAgency(dec);
  const id = String(b.pendingId || '');
  const reason = String(b.reason || '').trim().slice(0, 200);
  if (!id) throw new HttpError(400, 'pendingId chahiye.');
  if (reason.length < 5) throw new HttpError(400, 'Hatane ki wajah likho (kam se kam 5 akshar).');
  const who = await ownerWho(dec);
  const pref = db().doc(`${PENDING}/${id}`);
  await db().runTransaction(async (tx) => {
    const p = await tx.get(pref);
    if (!p.exists || p.get('agencyId') !== agencyId) throw new HttpError(404, 'Pending entry nahi mili.');
    if (['SETTLED', 'REMOVED'].includes(p.get('status'))) throw new HttpError(409, 'Ye entry pehle hi band ho chuki hai.');
    const cref = db().doc(`customers/${p.get('customerId')}`);
    const c = await tx.get(cref);
    const sid = p.get('settlementBookingId');
    const sref = sid ? db().doc(`bookings/${sid}`) : null;
    const sb = sref ? await tx.get(sref) : null;
    tx.update(pref, { status: 'REMOVED', locked: false, removedReason: reason, removedBy: dec.uid, removedByName: who.name,
      removedByEmail: who.email, removedAtMs: Date.now(), updatedAt: FV().serverTimestamp() });
    if (c.exists && c.get('emergencyPendingId') === id) tx.set(cref, { emergencyPendingId: FV().delete(), updatedAt: FV().serverTimestamp() }, { merge: true });
    if (sb && sb.exists && sb.get('orderStatus') !== 'DELIVERED') {
      tx.update(sref, { status: 'Rejected', orderStatus: 'CANCELLED', cancelReason: `Pending OTP manually hataya: ${reason}`,
        cancelledAt: FV().serverTimestamp(), updatedAt: FV().serverTimestamp() });
      tx.delete(db().doc(`deliveryOtps/${sid}`));
    }
  });
  await audit(agencyId, dec.uid, 'owner', 'PENDING_OTP_MANUAL_REMOVE', 'booking', id, { reason });
  return { message: 'Entry hata di. Pending OTP count 1 kam ho gaya.' };
}

const ACTIONS = { 'delete-account': deleteAccount, 'cancel-booking': cancelBooking, 'set-slot': setSlot, 'service-request': serviceRequest, 'owner-booking': ownerBooking, 'cash-add': cashAdd, 'cash-list': cashList, 'emergency-handover': emergencyHandover, 'pending-otp-list': pendingOtpList, 'pending-otp-settle': pendingOtpSettle, 'pending-otp-resend': pendingOtpResend, 'emergency-history': emergencyHistory, 'duty-logs': dutyLogs, 'pending-otp-add': pendingOtpAdd, 'pending-otp-remove': pendingOtpRemove };
const ROUTE = require('./_lib/routeOps')({ db, FV, HttpError, ownerAgency, sendToUsers, ownerUids, audit, safe });
Object.assign(ACTIONS, ROUTE.actions);


const DEFAULT_FLAGS = { onlinePayment: false, kyc: false };
// Public app config (force-update minBuild + feature flags). Firestore doc: config/app
async function appConfig(res) {
  res.setHeader('Cache-Control', 'public, max-age=300');
  try {
    const s = await db().doc('config/app').get();
    const d = s.exists ? s.data() : {};
    return res.status(200).json({ success: true, apps: d.apps || {}, flags: { ...DEFAULT_FLAGS, ...(d.flags || {}) }, notice: String(d.notice || '') });
  } catch (e) {
    console.error('app-config:', e.message);
    return res.status(200).json({ success: true, apps: {}, flags: DEFAULT_FLAGS, notice: '' });
  }
}

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    if (req.query && String(req.query.config || '') === '1') return appConfig(res);
    return res.status(200).json({ success: true, message: 'ops ready' });
  }
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
