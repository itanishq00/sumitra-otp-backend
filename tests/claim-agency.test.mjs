// C1 integration tests. SIRF emulator (Auth + Firestore, demo-gas-test) par.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

if (!process.env.FIREBASE_AUTH_EMULATOR_HOST || !process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Sirf emulator par chalao');
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
Object.assign(process.env, { FIREBASE_PROJECT_ID: 'demo-gas-test', GCLOUD_PROJECT: 'demo-gas-test', FIREBASE_CLIENT_EMAIL: 'tester@demo-gas-test.iam.gserviceaccount.com', FIREBASE_PRIVATE_KEY: privateKey });
const require = createRequire(import.meta.url);
const admin = require('../api/_lib/firebase');
const h = require('../api/claim-agency.js');
const db = admin.firestore();
const AUTH = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1`;

async function signUp(email) {
  const r = await fetch(`${AUTH}/accounts:signUp?key=fake`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'secret123', returnSecureToken: true }) });
  const j = await r.json(); return { uid: j.localId, token: j.idToken };
}
async function call(token, body) {
  const res = { code: 0, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
  await h({ method: 'POST', headers: token ? { authorization: 'Bearer ' + token } : {}, body }, res);
  return res;
}
let A;
before(async () => {
  const day = 86400000;
  await db.doc('agencies/agX').set({ id: 'agX', name: 'Agency X', status: 'ACTIVE', ownerUid: null });
  await db.doc('agencyInvites/GOODCODE').set({ agencyId: 'agX', createdBy: 'hp', expiresAtMs: Date.now() + day });
  await db.doc('agencyInvites/OLDCODE1').set({ agencyId: 'agX', createdBy: 'hp', expiresAtMs: Date.now() - 1000 });
  await db.doc('agencyInvites/SECOND22').set({ agencyId: 'agX', createdBy: 'hp', expiresAtMs: Date.now() + day });
  A = await signUp('owner.a@test.com');
});

test('01 bina login -> 401', async () => assert.equal((await call(null, { code: 'GOODCODE' })).code, 401));
test('02 galat format -> 400', async () => assert.equal((await call(A.token, { code: 'abc' })).code, 400));
test('03 anjaan code -> 404', async () => assert.equal((await call(A.token, { code: 'ZZZZ9999' })).code, 404));
test('04 expired code -> 410', async () => assert.equal((await call(A.token, { code: 'OLDCODE1' })).code, 410));
test('05 customer account owner NA bane -> 403', async () => {
  const c = await signUp('9000000001@customer.sumitra.local');
  assert.equal((await call(c.token, { code: 'GOODCODE' })).code, 403);
});
test('06 sahi code -> owner ACTIVE, claims, invite used', async () => {
  const r = await call(A.token, { code: 'goodcode', name: 'Owner A' });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  const ad = (await db.doc('admins/' + A.uid).get()).data();
  assert.equal(ad.status, 'ACTIVE'); assert.equal(ad.agencyId, 'agX'); assert.equal(ad.role, 'owner');
  assert.equal((await db.doc('agencyInvites/GOODCODE').get()).get('usedBy'), A.uid);
  assert.equal((await db.doc('agencies/agX').get()).get('ownerUid'), A.uid);
  const u = await admin.auth().getUser(A.uid);
  assert.equal(u.customClaims.role, 'owner'); assert.equal(u.customClaims.agencyId, 'agX');
});
test('07 wahi code dusra user -> 409', async () => {
  const b = await signUp('owner.b@test.com');
  assert.equal((await call(b.token, { code: 'GOODCODE' })).code, 409);
});
test('08 already ACTIVE owner dusra code -> 409', async () => assert.equal((await call(A.token, { code: 'SECOND22' })).code, 409));
