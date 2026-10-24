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
const call = async (who, body) => {
  const res = { code: 0, body: null, setHeader() { return this; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await h({ method: 'POST', headers: who ? { authorization: `Bearer ${tok[who]}` } : {}, body, query: {} }, res);
  return res;
};
const getB = async (id) => (await db.doc(`bookings/${id}`).get()).data();
const ym = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
const AG = 'agCB';
let AREA = '';

before(async () => {
  const callers = ['cb1', 'cb2', 'cb3', 'cb4', 'cb5', 'cb6', 'cb7', 'cb8', 'cb9', 'cbx', 'cbown'];
  for (const u of callers) await admin.auth().createUser({ uid: u, email: `${u}@test.local`, password: 'pass-1234' });
  await db.doc('admins/cbown').set({ status: 'ACTIVE', role: 'owner', agencyId: AG });
  for (const u of callers) tok[u] = await signIn(`${u}@test.local`);

  await db.doc('deliveryAgents/cbagA').set({ agencyId: AG, name: 'Driver CB', status: 'ACTIVE', authUid: 'cbagU', mobile: '9000000001' });
  await db.doc(`inventory/${AG}__cylinder`).set({ filled14: 10, empty14: 0 });
  await db.doc(`settings/${AG}__prices`).set({ prices: { '14 KG': 900 } });

  // Route setup (owner) : 1 area + plan current & next month (aaj ki date par kaam kare)
  const rs = await call('cbown', { action: 'route-settings-save', areas: [{ name: 'Zone CB' }] });
  assert.equal(rs.code, 200, rs.body && rs.body.message);
  AREA = rs.body.areas[0].id;
  const ist = new Date(Date.now() + 330 * 60000);
  const months = [ym(ist), ym(new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() + 1, 1)))];
  const days = { mon: [AREA], tue: [AREA], wed: [AREA], thu: [AREA], fri: [AREA], sat: [AREA] };
  for (const month of months) {
    const r = await call('cbown', { action: 'route-plan-save', month, agents: { cbagA: days }, publish: true });
    assert.equal(r.code, 200, r.body && r.body.message);
  }

  const cust = (id, extra) => db.doc(`customers/${id}`).set({ agencyId: AG, name: id, mobile: '9100000000', verificationStatus: 'verified', active: true, assignedCylinderType: '14 KG', areaId: AREA, ...extra });
  for (const id of ['cb1', 'cb2', 'cb3', 'cb5', 'cb9', 'cm1']) await cust(id, id === 'cb5' ? { emergencyPendingId: 'em1' } : {});
  await cust('cb4', { lastBookingAt: ago(10), lastBookingId: 'cbd4' });
  await cust('cb6', { verificationStatus: 'pending' });
  await cust('cb7', { assignedCylinderType: '' });
  await cust('cb8', { areaId: '' });
  await db.doc('customers/cbx').set({ agencyId: 'agCBX', name: 'cbx', mobile: '9100000009', verificationStatus: 'verified', active: true, assignedCylinderType: '14 KG' });

  await db.doc('bookings/cbd4').set({ customerId: 'cb4', agencyId: AG, status: 'Delivered', orderStatus: 'DELIVERED', createdAt: ago(10) });
  // cancel tests ke liye seeded bookings (cb9)
  await db.doc('bookings/cbA').set({ customerId: 'cb9', agencyId: AG, status: 'Approved', orderStatus: 'CONFIRMED', createdAt: ago(1) });
  await db.doc('bookings/cbB').set({ customerId: 'cb9', agencyId: AG, status: 'Approved', orderStatus: 'ACCEPTED', autoConfirmed: true, agentUid: 'x', createdAt: ago(1) });
  // manual assign + accepted route-block tests
  await db.doc('bookings/cbM').set({ customerId: 'cm1', customerName: 'cm1', agencyId: AG, status: 'Approved', orderStatus: 'ASSIGNED', autoConfirmed: true,
    agentUid: 'manualUid', agentId: 'manualAg', agentName: 'Manual Guy', createdAt: ago(0) });
  await db.doc('bookings/cbR').set({ customerId: 'cm1', customerName: 'cm1', agencyId: AG, status: 'Approved', orderStatus: 'ACCEPTED', agentUid: 'x', createdAt: ago(0) });
});

test('CB1 bina login -> 401', async () => { assert.equal((await call(null, { action: 'customer-booking' })).code, 401); });

test('CB2 auto-confirm + route agent assign (ASSIGNED, agent fields, stock nahi ghata)', async () => {
  const r = await call('cb1', { action: 'customer-booking', slot: 'Shaam (4-8)' });
  assert.equal(r.code, 200, r.body && r.body.message);
  assert.equal(r.body.confirmed, true); assert.equal(r.body.route.assigned, true);
  const b = await getB(r.body.bookingId);
  assert.equal(b.status, 'Approved'); assert.equal(b.autoConfirmed, true); assert.equal(b.approvedBy, 'auto'); assert.equal(b.source, 'customerApp');
  assert.equal(b.orderStatus, 'ASSIGNED'); assert.equal(b.agentUid, 'cbagU'); assert.equal(b.agentName, 'Driver CB'); assert.equal(b.assignedBy, 'auto-route');
  assert.equal(b.routeStatus, 'PLANNED'); assert.ok(b.expectedDeliveryDate);
  assert.equal(b.preferredSlot, 'Shaam (4-8)'); assert.equal(b.unitPrice, 900); assert.equal(b.totalAmount, 900);
  assert.equal(b.inventoryDeductedQty, undefined);
  assert.equal((await db.doc(`inventory/${AG}__cylinder`).get()).get('filled14'), 10);
  assert.equal((await db.doc('customers/cb1').get()).get('lastBookingId'), r.body.bookingId);
  globalThis.__cb1 = r.body.bookingId;
});

test('CB3 ek active booking ke baad dusri -> 409', async () => {
  assert.equal((await call('cb1', { action: 'customer-booking' })).code, 409);
});

test('CB4 double-tap -> sirf ek booking', async () => {
  const [a, b] = await Promise.all([call('cb2', { action: 'customer-booking' }), call('cb2', { action: 'customer-booking' })]);
  const codes = [a.code, b.code].sort();
  assert.deepEqual(codes, [200, 409]);
  const s = await db.collection('bookings').where('customerId', '==', 'cb2').get();
  assert.equal(s.size, 1);
});

test('CB5 stock nahi -> Pending (lost nahi), agent assign nahi', async () => {
  const inv = db.doc(`inventory/${AG}__cylinder`);
  await inv.update({ filled14: 0 });
  try {
    const r = await call('cb3', { action: 'customer-booking' });
    assert.equal(r.code, 200, r.body && r.body.message); assert.equal(r.body.confirmed, false);
    const b = await getB(r.body.bookingId);
    assert.equal(b.status, 'Pending'); assert.equal(b.orderStatus, undefined); assert.equal(b.agentUid, undefined); assert.equal(b.autoConfirmed, undefined);
  } finally { await inv.update({ filled14: 10 }); }
});

test('CB6 45-din ke andar -> 409', async () => {
  const r = await call('cb4', { action: 'customer-booking' });
  assert.equal(r.code, 409); assert.match(r.body.message, /45/);
});

test('CB7 emergency pending -> 409', async () => { assert.equal((await call('cb5', { action: 'customer-booking' })).code, 409); });
test('CB8 unverified customer -> 409', async () => { assert.equal((await call('cb6', { action: 'customer-booking' })).code, 409); });
test('CB9 cylinder allot nahi -> 409', async () => { assert.equal((await call('cb7', { action: 'customer-booking' })).code, 409); });
test('CB10 owner (customer nahi) -> 403/404', async () => { assert.ok([403, 404].includes((await call('cbown', { action: 'customer-booking' })).code)); });

test('CB11 doosri agency ka customer: apni agency me hi booking, agCB stock safe', async () => {
  const r = await call('cbx', { action: 'customer-booking' });
  assert.equal(r.code, 200, r.body && r.body.message);
  const b = await getB(r.body.bookingId);
  assert.equal(b.agencyId, 'agCBX'); assert.equal(b.status, 'Pending'); assert.equal(b.agentUid, undefined);
  assert.equal((await db.doc(`inventory/${AG}__cylinder`).get()).get('filled14'), 10);
});

test('CB12 route fail (area nahi) -> CONFIRMED rahe, agent nahi', async () => {
  const r = await call('cb8', { action: 'customer-booking' });
  assert.equal(r.code, 200, r.body && r.body.message);
  assert.equal(r.body.confirmed, true); assert.equal(r.body.route.status, 'NO_AREA');
  const b = await getB(r.body.bookingId);
  assert.equal(b.status, 'Approved'); assert.equal(b.orderStatus, 'CONFIRMED'); assert.equal(b.agentUid, undefined);
});

test('CB13 owner-approved booking (autoConfirmed nahi) cancel -> 409', async () => {
  assert.equal((await call('cb9', { action: 'cancel-booking', bookingId: 'cbA' })).code, 409);
});
test('CB14 auto-confirmed par agent accept ho chuka -> cancel 409', async () => {
  assert.equal((await call('cb9', { action: 'cancel-booking', bookingId: 'cbB' })).code, 409);
});
test('CB15 auto-confirmed (ASSIGNED, accept se pehle) cancel -> 200, band', async () => {
  const r = await call('cb1', { action: 'cancel-booking', bookingId: globalThis.__cb1 });
  assert.equal(r.code, 200, r.body && r.body.message);
  const b = await getB(globalThis.__cb1);
  assert.ok(['Rejected', 'Cancelled'].includes(b.status)); assert.equal(b.orderStatus, 'CANCELLED');
});

test('CB16 manual agentUid overwrite nahi hota (force ke bina)', async () => {
  const r = await call('cbown', { action: 'route-assign', bookingId: 'cbM' });
  assert.equal(r.code, 200, r.body && r.body.message);
  const b = await getB('cbM');
  assert.equal(b.agentUid, 'manualUid'); assert.equal(b.agentName, 'Manual Guy'); assert.equal(b.orderStatus, 'ASSIGNED');
});

test('CB17 accepted booking ka route force se bhi nahi badalta -> 409', async () => {
  assert.equal((await call('cbown', { action: 'route-assign', bookingId: 'cbR', force: true })).code, 409);
});
