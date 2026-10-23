// Emergency cylinder (bina OTP) ka hisaab: 45 din poore hone par auto booking + OTP, roz reminder, 7 din par alert.
const crypto = require('crypto');
const admin = require('./firebase');
const { Timestamp } = require('firebase-admin/firestore');
const { sendToUsers, ownerUids } = require('./notify');

const DAY = 86400e3;
const OTP_VALID_MS = 30 * DAY;
const ESCALATE_DAYS = 7;
const istDate = (ms) => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 10);
const quiet = async (fn) => { try { await fn(); } catch (e) { console.error('emergency side-effect:', e.message); } };

function otpDoc(p, bookingId, now = Date.now()) {
  return {
    agencyId: p.agencyId || null, bookingId, customerId: p.customerId || '', agentUid: '',
    otp: String(crypto.randomInt(0, 10000)).padStart(4, '0'), attempts: 0,
    expiresAtMs: now + OTP_VALID_MS, regenerateCount: 0, sentAtMs: now, purpose: 'EMERGENCY_SETTLEMENT',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

async function runSettlements({ dry = false, now = Date.now() } = {}) {
  const db = admin.firestore();
  const FV = admin.firestore.FieldValue;
  const snap = await db.collection('pendingOtps').where('status', '==', 'WAITING').get();
  const due = snap.docs.filter((d) => (Number(d.get('dueAtMs')) || 0) <= now);
  let created = 0;
  if (dry) return { due: due.length, created };
  for (const d of due) {
    try {
      const sref = db.collection('bookings').doc();
      const ok = await db.runTransaction(async (tx) => {
        const fresh = await tx.get(d.ref);
        if (!fresh.exists || fresh.get('status') !== 'WAITING') return false;
        const p = fresh.data();
        tx.set(sref, {
          agencyId: p.agencyId, customerId: p.customerId, customerName: p.customerName || 'Customer', customerMobile: p.customerMobile || '',
          consumerNumber: p.consumerNumber || null, cylinderType: p.cylinderType || '', quantity: 1,
          status: 'Approved', orderStatus: 'SETTLEMENT_PENDING', isSettlement: true, settlesBookingId: d.id,
          unitPrice: 0, totalAmount: 0, paymentMethod: 'PREPAID', paymentStatus: 'PAID_IN_EMERGENCY', inventoryDeductedQty: 0,
          source: 'autoSettlement', approvedAt: FV.serverTimestamp(), approvedBy: 'system',
          bookingDate: Timestamp.fromMillis(now), createdAt: Timestamp.fromMillis(now), updatedAt: FV.serverTimestamp(),
        });
        tx.set(db.collection('deliveryOtps').doc(sref.id), otpDoc(p, sref.id, now));
        tx.update(d.ref, { status: 'OTP_PENDING', settlementBookingId: sref.id, otpSentAtMs: now, updatedAt: FV.serverTimestamp() });
        tx.set(db.collection('customers').doc(String(p.customerId)), { lastBookingAt: Timestamp.fromMillis(now), lastBookingId: sref.id, updatedAt: FV.serverTimestamp() }, { merge: true });
        return true;
      });
      if (!ok) continue;
      created++;
      const p = d.data();
      await quiet(() => sendToUsers([p.customerId], { type: 'BOOKING_CREATED', agencyId: p.agencyId || null, bookingId: sref.id, dedupeKey: `SETTLEMENT_${sref.id}`,
        title: 'Emergency cylinder ka hisaab', body: 'Aapki agli booking apne aap ban gayi hai. App me OTP dekhkar agency ko batayein.' }));
      await quiet(async () => sendToUsers(await ownerUids(p.agencyId), { type: 'BOOKING_CREATED', agencyId: p.agencyId || null, bookingId: d.id, dedupeKey: `SETTLEMENT_OWNER_${sref.id}`,
        title: 'Pending OTP: OTP ban gaya', body: `${p.customerName || 'Customer'} se OTP lekar Pending OTP section me daalo.` }));
      await quiet(() => db.collection('auditLogs').add({ agencyId: p.agencyId || 'platform', actorId: 'cron', actorEmail: '', actorRole: 'system',
        action: 'EMERGENCY_SETTLEMENT_BOOKING', targetType: 'booking', targetId: sref.id, oldValue: null, newValue: { emergencyBookingId: d.id }, timestamp: FV.serverTimestamp() }));
    } catch (e) { console.error('settlement:', e.message); }
  }
  return { due: due.length, created };
}

async function runPendingReminders({ dry = false, now = Date.now() } = {}) {
  const db = admin.firestore();
  const FV = admin.firestore.FieldValue;
  const snap = await db.collection('pendingOtps').where('status', '==', 'OTP_PENDING').get();
  let reminded = 0; let escalated = 0;
  if (dry) return { pending: snap.size, reminded, escalated };
  for (const d of snap.docs) {
    const p = d.data();
    const sent = Number(p.otpSentAtMs) || now;
    if (now - sent < DAY) continue;
    await quiet(() => sendToUsers([p.customerId], { type: 'BOOKING_REMINDER', agencyId: p.agencyId || null, bookingId: p.settlementBookingId || d.id,
      dedupeKey: `PENDING_OTP_${d.id}_${istDate(now)}`, title: '🔔 Emergency cylinder ka OTP', body: 'App me OTP dekhkar agency ko batayein, taaki hisaab poora ho.' }));
    reminded++;
    if (now - sent >= ESCALATE_DAYS * DAY && !p.escalatedAt) {
      await quiet(() => d.ref.update({ escalatedAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp() }));
      await quiet(async () => sendToUsers(await ownerUids(p.agencyId), { type: 'OTP_LOCKED', agencyId: p.agencyId || null, bookingId: d.id,
        dedupeKey: `PENDING_OTP_ESC_${d.id}`, title: '⏰ Pending OTP 7 din se baaki', body: `${p.customerName || 'Customer'} ka emergency hisaab abhi tak poora nahi hua.` }));
      await quiet(() => db.collection('auditLogs').add({ agencyId: p.agencyId || 'platform', actorId: 'cron', actorEmail: '', actorRole: 'system',
        action: 'PENDING_OTP_ESCALATED', targetType: 'booking', targetId: d.id, oldValue: null, newValue: { days: ESCALATE_DAYS }, timestamp: FV.serverTimestamp() }));
      escalated++;
    }
  }
  return { pending: snap.size, reminded, escalated };
}

module.exports = { otpDoc, runSettlements, runPendingReminders, istDate };
