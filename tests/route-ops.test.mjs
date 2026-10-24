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
const ist = (y, mo, d, hh, mi) => Date.UTC(y, mo - 1, d, hh, mi) - 330 * 60000;
const SUN = ist(2026, 11, 1, 10, 0);
const AREAS = ['Patna', 'Boring Road', 'Raza Bazar', 'Gola Road', 'Exhibition Road', 'Patna City'];
let A = {};
const P = (...n) => n.map((x) => A[x]);
const plan = () => ({
  rpdA: { mon: P('Patna'), tue: P('Boring Road'), wed: P('Raza Bazar'), thu: P('Gola Road'), fri: P('Exhibition Road'), sat: P('Patna City') },
  rpdB: { mon: P('Gola Road'), tue: P('Boring Road'), wed: P('Patna'), thu: P('Raza Bazar'), fri: P('Exhibition Road', 'Patna City'), sat: P('Exhibition Road') },
});

before(async () => {
  const users = ['rpown', 'rpown2', 'rpc1', 'rpc2', 'rpc3', 'rpagA'];
  for (const u of users) await admin.auth().createUser({ uid: u, email: `${u}@test.local`, password: 'pass-1234' });
  await admin.auth().setCustomUserClaims('rpagA', { role: 'delivery_agent', agencyId: 'agRP', agentId: 'rpdA' });
  await db.doc('admins/rpown').set({ status: 'ACTIVE', role: 'owner', agencyId: 'agRP' });
  await db.doc('admins/rpown2').set({ status: 'ACTIVE', role: 'owner', agencyId: 'agRPX' });
  for (const c of ['rpc1', 'rpc2', 'rpc3']) await db.doc(`customers/${c}`).set({ agencyId: 'agRP', name: c, verificationStatus: 'verified', active: true });
  await db.doc('deliveryAgents/rpdA').set({ agencyId: 'agRP', name: 'Driver A', status: 'ACTIVE' });
  await db.doc('deliveryAgents/rpdB').set({ agencyId: 'agRP', name: 'Driver B', status: 'ACTIVE' });
  await db.doc('deliveryAgents/rpdX').set({ agencyId: 'agRPX', name: 'Other', status: 'ACTIVE' });
  const t = Timestamp.fromMillis(SUN);
  for (const [b, c] of [['rpb1', 'rpc1'], ['rpb2', 'rpc2'], ['rpb3', 'rpc3']]) await db.doc(`bookings/${b}`).set({ customerId: c, customerName: c, agencyId: 'agRP', status: 'Pending', createdAt: t });
  for (const u of users) tok[u] = await signIn(`${u}@test.local`);
});

test('RT1 customer settings save nahi kar sakta -> 403', async () => {
  assert.equal((await call('rpc1', { action: 'route-settings-save', areas: [{ name: 'X' }] })).code, 403);
});
test('RT2 owner areas save (duplicate naam 400)', async () => {
  assert.equal((await call('rpown', { action: 'route-settings-save', areas: [{ name: 'Patna' }, { name: 'patna' }] })).code, 400);
  const r = await call('rpown', { action: 'route-settings-save', areas: AREAS.map((name) => ({ name })) });
  assert.equal(r.code, 200, r.body.message);
  A = Object.fromEntries(r.body.areas.map((a) => [a.name, a.id]));
  assert.equal(Object.keys(A).length, 6);
  assert.notEqual(A['Patna'], A['Patna City']);
});
test('RT3 plan validation (anjaan area, doosri agency ka agent, Sunday, galat month)', async () => {
  const bad = async (agents) => (await call('rpown', { action: 'route-plan-save', month: '2026-11', agents })).code;
  assert.equal(await bad({ rpdA: { mon: ['nope'] } }), 400);
  assert.equal(await bad({ rpdX: { mon: P('Patna') } }), 400);
  assert.equal(await bad({ rpdA: { sun: P('Patna') } }), 400);
  assert.equal((await call('rpown', { action: 'route-plan-save', month: '2026-13', agents: {} })).code, 400);
});
test('RT4 plan publish, koi area chhoota nahi', async () => {
  const r = await call('rpown', { action: 'route-plan-save', month: '2026-11', agents: plan(), publish: true });
  assert.equal(r.code, 200, r.body.message); assert.deepEqual(r.body.uncovered, []); assert.equal(r.body.published, true);
  const g = await call('rpown', { action: 'route-plan-get', month: '2026-11' });
  assert.equal(g.code, 200); assert.ok(g.body.plan.publishedAtMs > 0);
  assert.deepEqual(g.body.plan.agents.rpdB.fri, P('Exhibition Road', 'Patna City'));
});
test('RT5 set-area: customer khud, owner, doosri agency 404', async () => {
  assert.equal((await call('rpc1', { action: 'set-area', areaId: A['Patna City'] })).code, 200);
  assert.equal((await db.doc('customers/rpc1').get()).get('areaId'), A['Patna City']);
  assert.equal((await call('rpc1', { action: 'set-area', areaId: 'nope' })).code, 400);
  assert.equal((await call('rpown', { action: 'set-area', customerId: 'rpc3', areaId: A['Patna City'] })).code, 200);
  assert.equal((await call('rpown2', { action: 'set-area', customerId: 'rpc3', areaId: A['Patna'] })).code, 404);
});
test('RT6 Patna City, Sunday booking -> Driver B Friday', async () => {
  const r = await call('rpc1', { action: 'route-assign', bookingId: 'rpb1', nowMs: SUN });
  assert.equal(r.code, 200, r.body.message);
  assert.equal(r.body.route.agentId, 'rpdB'); assert.equal(r.body.route.date, '2026-11-06');
  const b = (await db.doc('bookings/rpb1').get()).data();
  assert.equal(b.routeStatus, 'PLANNED'); assert.equal(b.routeAgentName, 'Driver B'); assert.equal(b.expectedDeliveryDate, '2026-11-06');
  assert.equal(b.agentUid, undefined);
});
test('RT7 customer dobara call -> wahi result (reshuffle nahi)', async () => {
  const r = await call('rpc1', { action: 'route-assign', bookingId: 'rpb1', nowMs: ist(2026, 11, 7, 10, 0), force: true });
  assert.equal(r.body.route.date, '2026-11-06');
});
test('RT8 area nahi -> NO_AREA', async () => {
  const r = await call('rpc2', { action: 'route-assign', bookingId: 'rpb2', nowMs: SUN });
  assert.equal(r.code, 200); assert.equal(r.body.route.status, 'NO_AREA');
});
test('RT9 capacity full -> agla driver/din', async () => {
  await db.doc('deliveryAgents/rpdB').update({ dailyCapacity: 1 });
  const r = await call('rpc3', { action: 'route-assign', bookingId: 'rpb3', nowMs: SUN });
  assert.equal(r.body.route.agentId, 'rpdA'); assert.equal(r.body.route.date, '2026-11-07');
});
test('RT10 chhutti + owner force reassign', async () => {
  assert.equal((await call('rpown', { action: 'route-leave', agentId: 'rpdA', date: '2026-11-07' })).code, 200);
  const r = await call('rpown', { action: 'route-assign', bookingId: 'rpb3', nowMs: SUN, force: true });
  assert.equal(r.code, 200, r.body.message);
  assert.equal(r.body.route.agentId, 'rpdB'); assert.equal(r.body.route.date, '2026-11-13');
});
test('RT11 doosre ki booking -> 404', async () => {
  assert.equal((await call('rpc1', { action: 'route-assign', bookingId: 'rpb3' })).code, 404);
  assert.equal((await call('rpown2', { action: 'route-assign', bookingId: 'rpb1' })).code, 404);
});
test('RT12 driver: aaj ka route + chhutti dikhe', async () => {
  const r = await call('rpagA', { action: 'my-route', nowMs: ist(2026, 11, 2, 8, 0) });
  assert.equal(r.code, 200, r.body.message);
  assert.equal(r.body.days[0].date, '2026-11-02'); assert.deepEqual(r.body.days[0].areas, ['Patna']);
  assert.equal(r.body.days.find((d) => d.date === '2026-11-07').leave, true);
});
test('RT13 driver plan/assign nahi kar sakta -> 403', async () => {
  assert.equal((await call('rpagA', { action: 'route-plan-save', month: '2026-11', agents: {} })).code, 403);
  assert.equal((await call('rpagA', { action: 'route-assign', bookingId: 'rpb1' })).code, 403);
});
test('RT14 customer ko area list + apna area', async () => {
  const r = await call('rpc1', { action: 'route-settings-get' });
  assert.equal(r.code, 200); assert.equal(r.body.areas.length, 6); assert.equal(r.body.myAreaId, A['Patna City']);
});
