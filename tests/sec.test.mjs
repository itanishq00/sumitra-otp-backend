import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error('Sirf emulator');
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
Object.assign(process.env, { FIREBASE_PROJECT_ID: 'demo-gas-test', GCLOUD_PROJECT: 'demo-gas-test', FIREBASE_CLIENT_EMAIL: 'tester@demo-gas-test.iam.gserviceaccount.com', FIREBASE_PRIVATE_KEY: privateKey });
const require = createRequire(import.meta.url);
const admin = require('../api/_lib/firebase');
const cfg = require('../api/app-config.js');
const HAS_OPS = fs.existsSync(new URL('../api/ops.js', import.meta.url)) && fs.readFileSync(new URL('../api/ops.js', import.meta.url), 'utf8').includes('delete-account');
const db = admin.firestore();
const mk = () => ({ code: 0, body: null, setHeader() { return this; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
async function signIn(email) {
  const r = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'pass-1234', returnSecureToken: true }) });
  return (await r.json()).idToken;
}
const tok = {};
before(async () => {
  if (!HAS_OPS) return;
  for (const u of ['sdel1', 'sdel2']) await admin.auth().createUser({ uid: u, email: `${u}@test.local`, password: 'pass-1234' });
  await db.doc('customers/sdel1').set({ agencyId: 'agS', name: 'Del One', mobile: '9200000001' });
  await db.doc('customers/sdel2').set({ agencyId: 'agS', name: 'Del Two', mobile: '9200000002' });
  await db.doc('bookings/sdb2').set({ customerId: 'sdel2', agencyId: 'agS', status: 'Pending' });
  for (const u of ['sdel1', 'sdel2']) tok[u] = await signIn(`${u}@test.local`);
});
test('A1 app-config default (koi block nahi)', async () => {
  const r = mk(); await cfg({ method: 'GET', headers: {}, query: {} }, r);
  assert.equal(r.code, 200); assert.equal(r.body.success, true); assert.equal(r.body.flags.onlinePayment, false);
});
test('D1 chalti booking ho to delete mana', { skip: !HAS_OPS }, async () => {
  const h = require('../api/ops.js'); const r = mk();
  await h({ method: 'POST', headers: { authorization: `Bearer ${tok.sdel2}` }, body: { action: 'delete-account' }, query: {} }, r);
  assert.equal(r.code, 409);
});
test('D2 account delete: login hata, profile anonymous', { skip: !HAS_OPS }, async () => {
  const h = require('../api/ops.js'); const r = mk();
  await h({ method: 'POST', headers: { authorization: `Bearer ${tok.sdel1}` }, body: { action: 'delete-account' }, query: {} }, r);
  assert.equal(r.code, 200, r.body && r.body.message);
  await assert.rejects(admin.auth().getUser('sdel1'));
  const c = (await db.doc('customers/sdel1').get()).data(); assert.equal(c.deleted, true); assert.equal(c.mobile, undefined);
});
