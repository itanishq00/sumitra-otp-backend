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
const h = require('../api/ops.js');
const db = admin.firestore();
const ago = (d) => Timestamp.fromMillis(Date.now() - d * 86400e3);
const tok = {};
async function signIn(email) {
  const r = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'pass-1234', returnSecureToken: true }) });
  return (await r.json()).idToken;
}
const call = async (who, body, method = 'POST') => {
  const res = { code: 0, body: null, setHeader() { return this; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await h({ method, headers: who ? { authorization: `Bearer ${tok[who]}` } : {}, body, query: {} }, res);
  return res;
};
before(async () => {
  for (const u of ['oc1', 'oc4', 'oown']) await admin.auth().createUser({ uid: u, email: `${u}@test.local`, password: 'pass-1234' });
  await db.doc('admins/oown').set({ status: 'ACTIVE', role: 'owner', agencyId: 'agO' });
  const cust = (id, extra) => db.doc(`customers/${id}`).set({ agencyId: 'agO', name: id, mobile: '9100000000', verificationStatus: 'verified', active: true, assignedCylinderType: '14 KG', ...extra });
  await cust('oc1', { lastBookingAt: ago(1), lastBookingId: 'op1' });
  await cust('oc4', {}); await cust('oc6', {}); await cust('oc3', { lastBookingAt: ago(10), lastBookingId: 'od3' });
  await db.doc('customers/oc2').set({ agencyId: 'agOther', name: 'oc2', verificationStatus: 'verified', assignedCylinderType: '14 KG' });
  await db.doc('bookings/op1').set({ customerId: 'oc1', agencyId: 'agO', status: 'Pending', createdAt: ago(1) });
  await db.doc('bookings/od1').set({ customerId: 'oc1', agencyId: 'agO', status: 'Delivered', orderStatus: 'DELIVERED', createdAt: ago(60) });
  await db.doc('bookings/os1').set({ customerId: 'oc4', agencyId: 'agO', status: 'Pending', createdAt: ago(1) });
  await db.doc('bookings/oa1').set({ customerId: 'oc4', agencyId: 'agO', status: 'Approved', createdAt: ago(2) });
  await db.doc('bookings/od3').set({ customerId: 'oc3', agencyId: 'agO', status: 'Delivered', orderStatus: 'DELIVERED', createdAt: ago(10) });
  await db.doc('deliveryAgents/oag1').set({ agencyId: 'agO', name: 'Raju' });
  await db.doc('deliveryAgents/oag2').set({ agencyId: 'agOther', name: 'Other' });
  for (const u of ['oc1', 'oc4', 'oown']) tok[u] = await signIn(`${u}@test.local`);
});
test('O1 GET ready', async () => { assert.equal((await call(null, {}, 'GET')).code, 200); });
test('O2 bina login -> 401', async () => { assert.equal((await call(null, { action: 'cancel-booking', bookingId: 'op1' })).code, 401); });
test('O3 doosre ki booking cancel -> 404', async () => { assert.equal((await call('oc4', { action: 'cancel-booking', bookingId: 'op1' })).code, 404); });
test('O4 approved booking cancel -> 409', async () => { assert.equal((await call('oc4', { action: 'cancel-booking', bookingId: 'oa1' })).code, 409); });
test('O5 apni pending cancel -> Rejected + 45-din reset', async () => {
  const r = await call('oc1', { action: 'cancel-booking', bookingId: 'op1' }); assert.equal(r.code, 200, r.body.message);
  const b = (await db.doc('bookings/op1').get()).data(); assert.equal(b.status, 'Rejected'); assert.equal(b.cancelledByCustomer, true);
  assert.equal((await db.doc('customers/oc1').get()).get('lastBookingId'), 'od1');
});
test('O6 slot save + galat slot 400', async () => {
  assert.equal((await call('oc4', { action: 'set-slot', bookingId: 'os1', slot: 'Shaam (4-8)' })).code, 200);
  assert.equal((await db.doc('bookings/os1').get()).get('preferredSlot'), 'Shaam (4-8)');
  assert.equal((await call('oc4', { action: 'set-slot', bookingId: 'os1', slot: 'Raat' })).code, 400);
});
test('O7 service request -> issue Open', async () => {
  const r = await call('oc1', { action: 'service-request', kind: 'Mechanic visit', note: 'chulha' }); assert.equal(r.code, 200);
  const i = (await db.doc(`issues/${r.body.complaintId}`).get()).data(); assert.equal(i.agencyId, 'agO'); assert.equal(i.status, 'Open');
});
test('O8 owner booking -> Pending ownerApp', async () => {
  const r = await call('oown', { action: 'owner-booking', customerId: 'oc6' }); assert.equal(r.code, 200, r.body.message);
  const b = (await db.doc(`bookings/${r.body.bookingId}`).get()).data(); assert.equal(b.status, 'Pending'); assert.equal(b.source, 'ownerApp');
});
test('O9 owner booking dobara (active) -> 409', async () => { assert.equal((await call('oown', { action: 'owner-booking', customerId: 'oc6' })).code, 409); });
test('O10 45-din ke andar -> 412, force -> 200', async () => {
  const r = await call('oown', { action: 'owner-booking', customerId: 'oc3' }); assert.equal(r.code, 412); assert.equal(r.body.needsForce, true);
  assert.equal((await call('oown', { action: 'owner-booking', customerId: 'oc3', force: true })).code, 200);
});
test('O11 doosri agency ka customer -> 404', async () => { assert.equal((await call('oown', { action: 'owner-booking', customerId: 'oc2' })).code, 404); });
test('O12 customer owner-booking nahi kar sakta -> 403', async () => { assert.equal((await call('oc1', { action: 'owner-booking', customerId: 'oc6' })).code, 403); });
test('O13 cash jama + list', async () => {
  assert.equal((await call('oown', { action: 'cash-add', agentId: 'oag1', amount: 2050, date: '2026-10-21' })).code, 200);
  const l = await call('oown', { action: 'cash-list', date: '2026-10-21' }); assert.equal(l.code, 200); assert.equal(l.body.deposits[0].amount, 2050);
});
test('O14 doosri agency ka agent -> 404', async () => { assert.equal((await call('oown', { action: 'cash-add', agentId: 'oag2', amount: 10 })).code, 404); });
