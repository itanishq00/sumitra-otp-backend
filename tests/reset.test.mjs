import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error('Sirf emulator par chalao');
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
Object.assign(process.env, { FIREBASE_PROJECT_ID: 'demo-gas-test', GCLOUD_PROJECT: 'demo-gas-test', FIREBASE_CLIENT_EMAIL: 'tester@demo-gas-test.iam.gserviceaccount.com', FIREBASE_PRIVATE_KEY: privateKey });
const require = createRequire(import.meta.url);
const admin = require('../api/_lib/firebase');
const h = require('../api/reset-password.js');
const core = h.resetPasswordCore;
const db = admin.firestore();
const call = async (method, body) => {
  const res = { code: 0, body: null, setHeader() { return this; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await h({ method, headers: {}, body, query: {} }, res); return res;
};
const signIn = (email, password) => fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }),
});
before(async () => {
  await admin.auth().createUser({ uid: 'rcust1', email: 'rcust1@test.local', password: 'old-pass-1' });
  await db.doc('customers/rcust1').set({ mobile: '9000000001', agencyId: 'agR', name: 'R1' });
  await admin.auth().createUser({ uid: 'rown1', email: 'rown1@test.local', password: 'old-pass-1' });
  await admin.auth().setCustomUserClaims('rown1', { role: 'owner', agencyId: 'agR' });
  await db.doc('customers/rown1').set({ mobile: '9000000002', agencyId: 'agR' });
  await admin.auth().createUser({ uid: 'ragent1', email: 'ragent1@test.local', password: 'old-pass-1' });
  await admin.auth().setCustomUserClaims('ragent1', { role: 'delivery_agent', agencyId: 'agR' });
  await db.doc('deliveryAgents/ra1').set({ mobile: '9000000003', authUid: 'ragent1', agencyId: 'agR', name: 'Agent R' });
});
test('R1 GET -> ready', async () => { const r = await call('GET'); assert.equal(r.code, 200); assert.equal(r.body.success, true); });
test('R2 bina OTP -> 400', async () => { assert.equal((await call('POST', { mobileNumber: '9000000001', newPassword: 'abcdef1' })).code, 400); });
test('R3 galat mobile -> 400', async () => { assert.equal((await core({ mobile: '123', newPassword: 'abcdef1' })).code, 400); });
test('R4 chhota password -> 400', async () => { assert.equal((await core({ mobile: '9000000001', newPassword: '123' })).code, 400); });
test('R5 anjaan number -> 404', async () => { assert.equal((await core({ mobile: '9000000099', newPassword: 'abcdef1' })).code, 404); });
test('R6 owner account -> 403', async () => { assert.equal((await core({ mobile: '9000000002', newPassword: 'abcdef1' })).code, 403); });
test('R7 customer reset -> login', async () => {
  assert.equal((await core({ mobile: '9000000001', newPassword: 'new-pass-77' })).code, 200);
  assert.equal((await signIn('rcust1@test.local', 'new-pass-77')).status, 200);
});
test('R8 agent reset -> login', async () => {
  assert.equal((await core({ mobile: '9000000003', newPassword: 'agent-new-9', accountType: 'agent' })).code, 200);
  assert.equal((await signIn('ragent1@test.local', 'agent-new-9')).status, 200);
});
test('R9 customer number agent raaste se -> 404', async () => {
  assert.equal((await core({ mobile: '9000000001', newPassword: 'abcdef1', accountType: 'agent' })).code, 404);
});
