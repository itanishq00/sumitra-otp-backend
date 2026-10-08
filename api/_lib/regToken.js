const crypto = require('crypto');

// Secret: Firebase private key se nikala hua (server se bahar nahi jata).
function secret() {
  const k = process.env.FIREBASE_PRIVATE_KEY || '';
  if (!k) throw new Error('Server secret missing');
  return crypto.createHash('sha256').update(`sumitra-registration:${k}`).digest();
}

const b64 = (buf) => Buffer.from(buf).toString('base64url');

function signRegistration(mobile, ttlMs = 15 * 60 * 1000) {
  const payload = b64(JSON.stringify({ m: mobile, p: 'register', exp: Date.now() + ttlMs }));
  const sig = b64(crypto.createHmac('sha256', secret()).update(payload).digest());
  return `${payload}.${sig}`;
}

// Sahi ho to mobile number, warna null.
function verifyRegistration(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = b64(crypto.createHmac('sha256', secret()).update(payload).digest());
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString());
  } catch (_) {
    return null;
  }
  if (data.p !== 'register' || !data.exp || data.exp < Date.now()) return null;
  if (!/^\d{10}$/.test(String(data.m))) return null;
  return String(data.m);
}

module.exports = { signRegistration, verifyRegistration };
