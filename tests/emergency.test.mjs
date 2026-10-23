import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error('Sirf emulator');
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
Object.assign(process.env, { FIREBASE_PROJECT_ID: 'demo-gas-test', GCLOUD_PROJECT: 'demo-gas-test', FIREBASE_CLIENT_EMAIL: 'tester@demo-gas-test.iam.gserviceaccount.com', FIREBASE_PRIVATE_KEY: privateKey });
const require = createRequire(import.meta.url);
const admin = require('../api/_lib/firebase');
const { Timestamp } = require('firebase-admin/firestore');
const ops = require('../api/ops.js');
const delivery = require('../api/delivery.js');
const { runSettlements } = require('../api/_lib/emergency.js');
const db = admin.firestore();
const DAY = 86400e3;
const ago = (d) => Timestamp.fromMillis(Date.now() - d * DAY);
const tok = {};
async function signIn(email) {
  const r = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'pass-1234', returnSecureToken: true }) });
  return (await r.json()).idToken;
}
const mk = (h) => async (who, body) => {
  const res = { code: 0, body: null, setHeader() { return this; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
  await h({ method: 'POST', headers: who ? { authorization: `Bearer ${tok[who]}` } : {}, body, query: {} }, res);
  return res;
};
const call = mk(ops); const dcall = mk(delivery);
let EB;
before(async () => {
  for (const u of ['eown', 'eown2', 'eag1']) await admin.auth().createUser({ uid: u, email: `${u}@test.local`, password: 'pass-1234' });
  await admin.auth().setCustomUserClaims('eag1', { role: 'delivery_agent', agencyId: 'agE', agentId: 'EA1' });
  await db.doc('admins/eown').set({ status: 'ACTIVE', role: 'owner', agencyId: 'agE' });
  await db.doc('admins/eown2').set({ status: 'ACTIVE', role: 'owner', agencyId: 'agE2' });
  const cust = (id, extra) => db.doc(`customers/${id}`).set({ agencyId: 'agE', name: id, mobile: '9200000000', verificationStatus: 'verified', active: true, assignedCylinderType: '14 KG', ...extra });
  await cust('ec1', { lastBookingAt: ago(10), lastBookingId: 'eb1' });
  await cust('ec2', { lastBookingAt: ago(50), lastBookingId: 'eb2' });
  await db.doc('bookings/eb1').set({ customerId: 'ec1', agencyId: 'agE', status: 'Delivered', orderStatus: 'DELIVERED', createdAt: ago(10) });
  await db.doc('bookings/eb2').set({ customerId: 'ec2', agencyId: 'agE', status: 'Delivered', orderStatus: 'DELIVERED', createdAt: ago(50) });
  await db.doc('settings/agE__prices').set({ prices: { '14 KG': 900 } });
  await db.doc('inventory/agE__cylinder').set({ filled14: 5, empty14: 0 });
  for (const u of ['eown', 'eown2', 'eag1']) tok[u] = await signIn(`${u}@test.local`);
});
test('E1 emergency bina wajah -> 400', async () => {
  assert.equal((await call('eown', { action: 'owner-booking', customerId: 'ec1', emergency: true })).code, 400);
});
test('E2 45 din poore -> emergency nahi (409)', async () => {
  assert.equal((await call('eown', { action: 'owner-booking', customerId: 'ec2', emergency: true, reason: 'cylinder khatam' })).code, 409);
});
test('E3 emergency booking bani, 45-din ginti nahi badli', async () => {
  const r = await call('eown', { action: 'owner-booking', customerId: 'ec1', emergency: true, reason: 'ghar me khana nahi ban raha' });
  assert.equal(r.code, 200, r.body.message); EB = r.body.bookingId;
  const b = (await db.doc(`bookings/${EB}`).get()).data();
  assert.equal(b.isEmergency, true); assert.equal(b.status, 'Pending'); assert.equal(b.totalAmount, 900);
  const c = (await db.doc('customers/ec1').get()).data();
  assert.equal(c.lastBookingId, 'eb1');
  assert.equal(b.emergencyDueAtMs - c.lastBookingAt.toMillis(), 45 * DAY);
});
test('E4 Arrived se pehle handover -> 409', async () => {
  assert.equal((await call('eown', { action: 'emergency-handover', bookingId: EB, cashAmount: 900 })).code, 409);
});
test('E5 agent emergency order par OTP nahi bhej / complete nahi kar sakta', async () => {
  await db.doc(`bookings/${EB}`).update({ status: 'Approved', orderStatus: 'ARRIVED', agentUid: 'eag1', agentId: 'EA1' });
  assert.equal((await dcall('eag1', { action: 'send-otp', bookingId: EB })).code, 409);
  assert.equal((await dcall('eag1', { action: 'complete', bookingId: EB, otp: '1234', cashAmount: 900 })).code, 409);
});
test('E6 doosri agency 404, galat amount 400', async () => {
  assert.equal((await call('eown2', { action: 'emergency-handover', bookingId: EB, cashAmount: 900 })).code, 404);
  assert.equal((await call('eown', { action: 'emergency-handover', bookingId: EB, cashAmount: 100 })).code, 400);
});
test('E7 bina OTP handover -> Delivered + Pending OTP WAITING', async () => {
  const r = await call('eown', { action: 'emergency-handover', bookingId: EB, cashAmount: 900 }); assert.equal(r.code, 200, r.body.message);
  const b = (await db.doc(`bookings/${EB}`).get()).data();
  assert.equal(b.orderStatus, 'DELIVERED'); assert.equal(b.verificationMethod, 'OWNER_EMERGENCY');
  assert.equal((await db.doc(`pendingOtps/${EB}`).get()).get('status'), 'WAITING');
  assert.equal((await db.doc('customers/ec1').get()).get('emergencyPendingId'), EB);
  assert.equal((await db.doc('inventory/agE__cylinder').get()).get('filled14'), 4);
  assert.equal((await db.doc(`payments/pay_${EB}`).get()).get('amount'), 900);
  const l = await call('eown', { action: 'pending-otp-list' }); assert.equal(l.code, 200); assert.equal(l.body.items.length, 1);
});
test('E8 hisaab baaki rehte doosri emergency nahi (409)', async () => {
  assert.equal((await call('eown', { action: 'owner-booking', customerId: 'ec1', emergency: true, reason: 'phir se chahiye' })).code, 409);
});
test('E9 OTP banne se pehle settle -> 409', async () => {
  assert.equal((await call('eown', { action: 'pending-otp-settle', pendingId: EB, otp: '1234' })).code, 409);
});
test('E10 cron: due se pehle kuch nahi, due par auto booking + OTP', async () => {
  const p = (await db.doc(`pendingOtps/${EB}`).get()).data();
  await runSettlements({ now: p.dueAtMs - DAY });
  assert.equal((await db.doc(`pendingOtps/${EB}`).get()).get('status'), 'WAITING');
  const r = await runSettlements({ now: p.dueAtMs + 1000 }); assert.equal(r.created, 1);
  const p2 = (await db.doc(`pendingOtps/${EB}`).get()).data(); assert.equal(p2.status, 'OTP_PENDING');
  const s = (await db.doc(`bookings/${p2.settlementBookingId}`).get()).data();
  assert.equal(s.isSettlement, true); assert.equal(s.totalAmount, 0);
  assert.equal((await db.doc('customers/ec1').get()).get('lastBookingId'), p2.settlementBookingId);
  assert.equal((await db.doc(`deliveryOtps/${p2.settlementBookingId}`).get()).exists, true);
});
test('E11 settle: galat OTP 400, sahi OTP -> SETTLED', async () => {
  const p = (await db.doc(`pendingOtps/${EB}`).get()).data();
  const otp = (await db.doc(`deliveryOtps/${p.settlementBookingId}`).get()).get('otp');
  const wrong = otp === '0000' ? '1111' : '0000';
  assert.equal((await call('eown', { action: 'pending-otp-settle', pendingId: EB, otp: wrong })).code, 400);
  const r = await call('eown', { action: 'pending-otp-settle', pendingId: EB, otp }); assert.equal(r.code, 200, r.body.message);
  assert.equal((await db.doc(`pendingOtps/${EB}`).get()).get('status'), 'SETTLED');
  assert.equal((await db.doc(`bookings/${p.settlementBookingId}`).get()).get('orderStatus'), 'DELIVERED');
  assert.equal((await db.doc('customers/ec1').get()).get('emergencyPendingId'), undefined);
});
