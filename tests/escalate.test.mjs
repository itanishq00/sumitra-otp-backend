// Escalation cron tests. SIRF emulator.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Sirf emulator par chalao');
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
Object.assign(process.env, { FIREBASE_PROJECT_ID: 'demo-gas-test', GCLOUD_PROJECT: 'demo-gas-test', FIREBASE_CLIENT_EMAIL: 'tester@demo-gas-test.iam.gserviceaccount.com', FIREBASE_PRIVATE_KEY: privateKey, CRON_SECRET: 'test-secret-1234567890' });
const require = createRequire(import.meta.url);
const admin = require('../api/_lib/firebase');
const { Timestamp } = require('firebase-admin/firestore');
const h = require('../api/escalate.js');
const db = admin.firestore();
const call = async (auth, query = {}) => {
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await h({ headers: auth ? { authorization: auth } : {}, query }, res);
  return res;
};
const AUTH = 'Bearer test-secret-1234567890';

before(async () => {
  const old = Timestamp.fromMillis(Date.now() - 50 * 3600e3), fresh = Timestamp.fromMillis(Date.now() - 2 * 3600e3);
  await db.doc('admins/ownerE').set({ agencyId: 'agE', status: 'ACTIVE', role: 'owner' });
  await db.doc('issues/e1').set({ agencyId: 'agE', status: 'Open', createdAt: old, title: 'Purani', customerName: 'C1' });
  await db.doc('issues/e2').set({ agencyId: 'agE', status: 'Open', createdAt: fresh, title: 'Nayi' });
  await db.doc('issues/e3').set({ agencyId: 'agE', status: 'Resolved', createdAt: old });
  await db.doc('issues/e4').set({ agencyId: 'agE', status: 'In Progress', createdAt: old, escalatedAt: old });
});

test('E1 bina / galat secret -> 401', async () => {
  assert.equal((await call(null)).code, 401);
  assert.equal((await call('Bearer galat')).code, 401);
});
test('E2 dry run sirf ginta hai, badalta nahi', async () => {
  const r = await call(AUTH, { dry: '1' });
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.due, 1); assert.equal(r.body.dry, true);
  assert.equal((await db.doc('issues/e1').get()).get('escalatedAt'), undefined);
});
test('E3 sirf purani khuli complaint escalate', async () => {
  const r = await call(AUTH);
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.due, 1);
  assert.ok((await db.doc('issues/e1').get()).get('escalatedAt'));
  assert.equal((await db.doc('issues/e2').get()).get('escalatedAt'), undefined);
  assert.equal((await db.doc('issues/e3').get()).get('escalatedAt'), undefined);
});
test('E4 dobara chalane par dobara nahi (idempotent)', async () => {
  const r = await call(AUTH);
  assert.equal(r.body.due, 0);
});
