const crypto = require('crypto');
const admin = require('./_lib/firebase');
const { AGENCY_ID, cors, httpError } = require('./_lib/auth');

const OTP_TTL_MS = 30 * 60 * 1000; // 30 minute
const MAX_ATTEMPTS = 5;

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

async function requireAgent(req) {
  const m = (req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (!m) throw httpError(401, 'Login required.');
  let d;
  try {
    d = await admin.auth().verifyIdToken(m[1], true);
  } catch (_) {
    throw httpError(401, 'Session expire ho gaya. Dobara login karo.');
  }
  if (d.role !== 'delivery_agent') {
    throw httpError(403, 'Sirf delivery agent ye kaam kar sakta hai.');
  }
  return d;
}

function sizeKey(type) {
  const t = String(type || '');
  if (t.includes('14')) return '14';
  if (t.includes('19')) return '19';
  if (t.includes('5')) return '5';
  return null;
}

// Owner app ke _previouslyDeductedQty jaisa hi.
function previouslyDeducted(b) {
  if (b.inventoryDeductedQty !== undefined && b.inventoryDeductedQty !== null) {
    return Number(b.inventoryDeductedQty) || 0;
  }
  if (b.status === 'Confirmed' || b.status === 'Partially Confirmed') {
    return Number(b.confirmedQuantity) || 0;
  }
  return 0;
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;

  if (req.method === 'GET') {
    try {
      admin.ensureApp();
      return send(res, 200, true, 'delivery ready');
    } catch (e) {
      return send(res, 500, false, `Init error: ${e.message}`);
    }
  }
  if (req.method !== 'POST') return send(res, 405, false, 'Method not allowed');

  let agent;
  try {
    agent = await requireAgent(req);
  } catch (e) {
    return send(res, e.status || 401, false, e.message);
  }

  const { action, bookingId, otp } = parseBody(req);
  if (!bookingId || typeof bookingId !== 'string') {
    return send(res, 400, false, 'bookingId required.');
  }

  const db = admin.firestore();
  const FieldValue = admin.firestore.FieldValue;
  const bookingRef = db.collection('bookings').doc(bookingId);
  const otpRef = db.collection('deliveryOtps').doc(bookingId);

  try {
    // ---------- SEND OTP ----------
    if (action === 'send-otp') {
      const snap = await bookingRef.get();
      if (!snap.exists) return send(res, 404, false, 'Order nahi mila.');
      const b = snap.data();
      if (b.agentUid !== agent.uid) return send(res, 403, false, 'Ye order aapka nahi hai.');
      if (b.orderStatus === 'DELIVERED') return send(res, 200, true, 'Order pehle hi deliver ho chuka hai.');
      if (b.orderStatus !== 'ARRIVED') return send(res, 400, false, 'Pehle "Mark Arrived" karo.');

      // Valid OTP pehle se hai to wahi rakho (retry-safe).
      const existing = await otpRef.get();
      if (existing.exists) {
        const e = existing.data();
        if ((e.expiresAtMs || 0) > Date.now() && (e.attempts || 0) < MAX_ATTEMPTS) {
          return send(res, 200, true, 'OTP customer ke app me dikh raha hai. Customer se poochho.');
        }
      }

      const code = String(crypto.randomInt(0, 10000)).padStart(4, '0');
      await otpRef.set({
        agencyId: AGENCY_ID,
        bookingId,
        customerId: b.customerId || '',
        agentUid: agent.uid,
        otp: code,
        attempts: 0,
        expiresAtMs: Date.now() + OTP_TTL_MS,
        createdAt: FieldValue.serverTimestamp(),
      });
      return send(res, 200, true, 'OTP bhej diya. Customer apne app me OTP dekhega.');
    }

    // ---------- COMPLETE DELIVERY ----------
    if (action === 'complete') {
      const entered = String(otp || '');
      if (!/^\d{4}$/.test(entered)) return send(res, 400, false, '4-digit OTP daalo.');

      const cylRef = db.collection('inventory').doc('cylinder');

      const result = await db.runTransaction(async (tx) => {
        // Saare reads pehle
        const bSnap = await tx.get(bookingRef);
        const oSnap = await tx.get(otpRef);
        const cSnap = await tx.get(cylRef);

        if (!bSnap.exists) throw httpError(404, 'Order nahi mila.');
        const b = bSnap.data();

        if (b.orderStatus === 'DELIVERED') return { already: true };
        if (b.agentUid !== agent.uid) throw httpError(403, 'Ye order aapka nahi hai.');
        if (b.orderStatus !== 'ARRIVED') throw httpError(400, 'Order abhi "Arrived" status me nahi hai.');
        if (!oSnap.exists) throw httpError(400, 'Pehle "SEND OTP TO CUSTOMER" dabao.');

        const o = oSnap.data();
        const attempts = o.attempts || 0;
        if ((o.expiresAtMs || 0) < Date.now()) {
          throw httpError(400, 'OTP expire ho gaya. Dobara "Send OTP" dabao.');
        }
        if (attempts >= MAX_ATTEMPTS) {
          throw httpError(400, 'Bahut baar galat OTP. Dobara "Send OTP" dabao.');
        }
        if (o.otp !== entered) {
          tx.update(otpRef, { attempts: attempts + 1 });
          return { wrong: true, left: MAX_ATTEMPTS - attempts - 1 };
        }

        // ---- Inventory (sirf agar approve par nahi kata tha) ----
        const qty = Math.max(1, parseInt(b.quantity, 10) || 1);
        const size = sizeKey(b.cylinderType);
        const deductedBefore = previouslyDeducted(b) > 0;
        let changes = { Status: 'Arrived → Delivered', Quantity: `${qty} × ${b.cylinderType || ''}` };
        const bookingExtra = {};

        if (!deductedBefore && size) {
          const inv = cSnap.data() || {};
          const filled = Number(inv[`filled${size}`]) || 0;
          const empty = Number(inv[`empty${size}`]) || 0;
          if (filled < qty) {
            throw httpError(400, `Inventory me sirf ${filled} filled ${size} kg cylinder hain. Owner se baat karo.`);
          }
          tx.set(cylRef, {
            [`filled${size}`]: filled - qty,
            [`empty${size}`]: empty + qty,
            updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
          changes = {
            'Filled Cylinder': `${filled} → ${filled - qty}`,
            'Empty Cylinder': `${empty} → ${empty + qty}`,
            Status: 'Arrived → Delivered',
          };
          bookingExtra.inventoryDeductedQty = qty;
          bookingExtra.inventoryDeductedType = b.cylinderType || '';
          bookingExtra.confirmedQuantity = qty;
        }

        tx.update(bookingRef, {
          orderStatus: 'DELIVERED',
          status: 'Delivered',
          pendingQuantity: 0,
          deliveredAt: FieldValue.serverTimestamp(),
          deliveredBy: agent.agentId || '',
          verificationMethod: 'OTP',
          verificationStatus: 'VERIFIED',
          verifiedAt: FieldValue.serverTimestamp(),
          statusChangedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
          ...bookingExtra,
        });

        tx.delete(otpRef);

        const customerName = String(b.customerName || 'Customer').trim();
        const consumerNo = String(b.consumerNumber || '').trim();
        const label = consumerNo ? `${customerName} (Consumer No. ${consumerNo})` : customerName;

        tx.set(db.collection('inventoryActivity').doc(), {
          action: 'Customer Booking Delivered',
          section: 'Cylinder',
          item: `${size || ''} kg Cylinder`,
          summary: `${qty} filled ${b.cylinderType || ''} cylinder ${label} ko deliver kiya gaya (OTP verified).`,
          direction: 'out',
          customerName,
          consumerNumber: consumerNo,
          customerId: b.customerId || '',
          bookingId,
          changes,
          changedByUid: agent.uid,
          changedByName: agent.name || 'Delivery Agent',
          changedByEmail: agent.email || '',
          source: 'booking',
          changedAt: FieldValue.serverTimestamp(),
        });

        tx.set(db.collection('auditLogs').doc(), {
          agencyId: AGENCY_ID,
          actorId: agent.uid,
          actorEmail: agent.email || '',
          actorRole: 'delivery_agent',
          action: 'DELIVERY_COMPLETED',
          targetType: 'booking',
          targetId: bookingId,
          oldValue: { orderStatus: 'ARRIVED' },
          newValue: { orderStatus: 'DELIVERED', verificationMethod: 'OTP' },
          timestamp: FieldValue.serverTimestamp(),
        });

        return { done: true };
      });

      if (result.wrong) {
        return send(res, 400, false, `OTP galat hai. ${result.left} try baaki.`);
      }
      return send(res, 200, true,
        result.already ? 'Order pehle hi deliver ho chuka hai.' : 'Delivery complete! ✅');
    }

    return send(res, 400, false, 'Unknown action.');
  } catch (e) {
    if (e.status) return send(res, e.status, false, e.message);
    console.error('delivery error:', e);
    return send(res, 500, false, `Server error: ${e.message || e}`);
  }
};
