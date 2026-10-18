const crypto = require('crypto');
const admin = require('./_lib/firebase');

// B3: SMS ka bill aur spam rokne ke liye limits.
const LIMITS = { mobile10m: 3, mobileDay: 10, ipHour: 20 };
const MIN10 = 10 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function ipDocId(ip) {
  return 'ip_' + crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 32);
}

// Limit cross ho to { ok: false, message }, warna counter badha ke { ok: true }.
async function checkRateLimit(mobile, ip, now = Date.now()) {
  const db = admin.firestore();
  const mRef = db.collection('otpLimits').doc('m_' + mobile);
  const iRef = db.collection('otpLimits').doc(ipDocId(ip));
  return db.runTransaction(async (tx) => {
    const [mSnap, iSnap] = await Promise.all([tx.get(mRef), tx.get(iRef)]);
    const m = mSnap.exists ? mSnap.data() : {};
    const i = iSnap.exists ? iSnap.data() : {};

    let w10Start = m.w10Start || 0, w10Count = m.w10Count || 0;
    if (now - w10Start >= MIN10) { w10Start = now; w10Count = 0; }
    let dayStart = m.dayStart || 0, dayCount = m.dayCount || 0;
    if (now - dayStart >= DAY) { dayStart = now; dayCount = 0; }
    let hStart = i.hStart || 0, hCount = i.hCount || 0;
    if (now - hStart >= HOUR) { hStart = now; hCount = 0; }

    if (w10Count >= LIMITS.mobile10m) return { ok: false, message: 'Too many OTP requests. Please try again after 10 minutes.' };
    if (dayCount >= LIMITS.mobileDay) return { ok: false, message: 'Daily OTP limit reached. Please try again tomorrow.' };
    if (hCount >= LIMITS.ipHour) return { ok: false, message: 'Too many requests. Please try again later.' };

    tx.set(mRef, { w10Start, w10Count: w10Count + 1, dayStart, dayCount: dayCount + 1, updatedAtMs: now });
    tx.set(iRef, { hStart, hCount: hCount + 1, updatedAtMs: now });
    return { ok: true };
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method not allowed' });

  try {
    const { mobileNumber } = req.body || {};
    const cleaned = String(mobileNumber || '').replace(/\D/g, '');
    if (cleaned.length !== 10) {
      return res.status(400).json({ success: false, message: 'Invalid mobile number.' });
    }

    const authToken = process.env.MESSAGE_CENTRAL_AUTH_TOKEN;
    if (!authToken) {
      console.error('Message Central auth token missing');
      return res.status(500).json({ success: false, message: 'OTP service configuration missing.' });
    }

    let limit;
    try {
      limit = await checkRateLimit(cleaned, clientIp(req));
    } catch (e) {
      console.error('rate limit error:', e);
      return res.status(503).json({ success: false, message: 'OTP service busy. Please try again.' });
    }
    if (!limit.ok) return res.status(429).json({ success: false, message: limit.message });

    const url = new URL('https://cpaas.messagecentral.com/verification/v3/send');
    url.searchParams.set('countryCode', '91');
    url.searchParams.set('flowType', 'SMS');
    url.searchParams.set('mobileNumber', cleaned);

    const r = await fetch(url, { method: 'POST', headers: { authToken } });
    let result;
    try {
      result = JSON.parse(await r.text());
    } catch (_) {
      return res.status(500).json({ success: false, message: 'Invalid response from OTP service.' });
    }
    console.log('Message Central Send OTP:', { status: r.status, responseCode: result.responseCode });

    if (r.status === 200 && result.responseCode === 200 && result.data && result.data.verificationId) {
      return res.status(200).json({
        success: true,
        message: 'OTP sent successfully.',
        verificationId: String(result.data.verificationId),
      });
    }
    return res.status(400).json({ success: false, message: result.message || 'Unable to send OTP.' });
  } catch (error) {
    console.error('Send OTP error:', error);
    return res.status(500).json({ success: false, message: 'Unable to send OTP.' });
  }
};

module.exports.checkRateLimit = checkRateLimit;
module.exports.ipDocId = ipDocId;
