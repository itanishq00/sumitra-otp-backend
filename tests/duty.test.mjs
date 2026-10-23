import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error('Sirf emulator');
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
Object.assign(process.env, { FIREBASE_PROJECT_ID: 'demo-gas-test', GCLOUD_PROJECT: 'demo-gas-test', FIREBASE_CLIENT_EMAIL: 'tester@demo-gas-test.iam.gserviceaccount.com', FIREBASE_PRIVATE_KEY: privateKey });
const require = createRequire(import.meta.url);
const admin = require('../api/_lib/firebase');
const ops = require('../api/ops.js');
const delivery = require('../api/delivery.js');
const { runDutyCleanup } = require('../api/_lib/duty.js');
const db = admin.firestore();
const DAY = 86400e3;
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
before(async () => {
  for (const u of ['down', 'down2', 'dag1']) await admin.auth().createUser({ uid: u, email: `${u}@test.local`, password: 'pass-1234' });
  await admin.auth().setCustomUserClaims('dag1', { role: 'delivery_agent', agentId: 'DA1' });
  await db.doc('admins/down').set({ status: 'ACTIVE', role: 'owner', agencyId: 'agD' });
  await db.doc('admins/down2').set({ status: 'ACTIVE', role: 'owner', agencyId: 'agX' });
  await db.doc('deliveryAgents/DA1').set({ agencyId: 'agD', name: 'Ramesh' });
  await db.doc('pendingOtps/hnew').set({ agencyId: 'agD', customerName: 'C1', status: 'WAITING', handoverByEmail: 'owner1@test.local', handoverAtMs: Date.now(), agentName: 'Ramesh', requestedAtMs: Date.now() - 60000 });
  await db.doc('pendingOtps/hold').set({ agencyId: 'agD', customerName: 'C0', status: 'SETTLED', handoverAtMs: Date.now() - 200 * DAY });
  for (const u of ['down', 'down2', 'dag1']) tok[u] = await signIn(`${u}@test.local`);
});
test('D1 duty ON -> log + agentLocations onDuty', async () => {
  const r = await dcall('dag1', { action: 'duty', on: true, lat: 25.6, lng: 85.1 }); assert.equal(r.code, 200, r.body.message);
  const a = (await db.doc('agentLocations/dag1').get()).data();
  assert.equal(a.onDuty, true); assert.equal(a.agencyId, 'agD'); assert.equal(a.agentName, 'Ramesh'); assert.equal(a.lat, 25.6);
});
test('D2 duty-status -> ON', async () => {
  const r = await dcall('dag1', { action: 'duty-status' }); assert.equal(r.code, 200); assert.equal(r.body.onDuty, true);
});
test('D3 duty OFF', async () => {
  assert.equal((await dcall('dag1', { action: 'duty', on: false })).code, 200);
  assert.equal((await db.doc('agentLocations/dag1').get()).get('onDuty'), false);
});
test('D4 owner duty-logs: 2 records, naya pehle', async () => {
  const r = await call('down', { action: 'duty-logs' }); assert.equal(r.code, 200, r.body.message);
  assert.equal(r.body.logs.length, 2); assert.equal(r.body.logs[0].on, false); assert.equal(r.body.logs[1].agentName, 'Ramesh');
});
test('D5 doosri agency ko record nahi dikhte', async () => {
  const r = await call('down2', { action: 'duty-logs' }); assert.equal(r.code, 200); assert.equal(r.body.logs.length, 0);
});
test('D6 6 mahine se purane duty logs cron se hatte', async () => {
  const ref = await db.collection('dutyLogs').add({ agencyId: 'agD', agentUid: 'dag1', on: true, atMs: Date.now() - 200 * DAY });
  const r = await runDutyCleanup(); assert.ok(r.old >= 1);
  assert.equal((await ref.get()).exists, false);
});
test('H1 emergency-history: sirf 6 mahine, email ke saath', async () => {
  const r = await call('down', { action: 'emergency-history' }); assert.equal(r.code, 200, r.body.message);
  assert.equal(r.body.items.length, 1); assert.equal(r.body.items[0].handoverByEmail, 'owner1@test.local'); assert.equal(r.body.items[0].agentName, 'Ramesh');
});
