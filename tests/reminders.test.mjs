import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Sirf emulator');
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
Object.assign(process.env, { FIREBASE_PROJECT_ID: 'demo-gas-test', GCLOUD_PROJECT: 'demo-gas-test', FIREBASE_CLIENT_EMAIL: 'tester@demo-gas-test.iam.gserviceaccount.com', FIREBASE_PRIVATE_KEY: privateKey, CRON_SECRET: 'test-secret-1234567890' });
const require = createRequire(import.meta.url);
const admin = require('../api/_lib/firebase');
const { Timestamp } = require('firebase-admin/firestore');
const { runReminders } = require('../api/escalate.js');
const db = admin.firestore();
const ago = (d) => Timestamp.fromMillis(Date.now() - d * 86400e3);
before(async () => {
  await db.doc('customers/remc1').set({ agencyId: 'agM', lastBookingAt: ago(50), lastBookingId: 'rmb1', verificationStatus: 'verified' });
  await db.doc('bookings/rmb1').set({ customerId: 'remc1', status: 'Delivered', orderStatus: 'DELIVERED', createdAt: ago(50) });
  await db.doc('customers/remc2').set({ agencyId: 'agM', lastBookingAt: ago(10), lastBookingId: 'rmb2', verificationStatus: 'verified' });
});
test('M1 45+ din wale ko reminder, naye ko nahi', async () => {
  await runReminders({});
  assert.equal((await db.doc('customers/remc1').get()).get('reminderSentFor'), 'rmb1');
  assert.equal((await db.doc('customers/remc2').get()).get('reminderSentFor'), undefined);
});
test('M2 ek booking par dobara reminder nahi', async () => {
  const r = await runReminders({}); assert.ok(!r.ids.includes('remc1'));
});
