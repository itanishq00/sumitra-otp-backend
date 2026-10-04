require("dotenv").config();

const crypto = require("crypto");
const admin = require("firebase-admin");
const { getFirestore, Timestamp, FieldValue } = require("firebase-admin/firestore");
const { Resend } = require("resend");

const serviceAccount = require("../gas-agency-app-54892e678200.json");

if (admin.getApps().length === 0) {
  admin.initializeApp({
    credential: admin.cert(serviceAccount),
  });
}

const db = getFirestore();
const resend = new Resend(process.env.RESEND_API_KEY);

function hashValue(value) {
  return crypto
    .createHash("sha256")
    .update(value)
    .digest("hex");
}

function generateOtp() {
  return crypto.randomInt(100000, 1000000).toString();
}

async function sendOtp(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed",
    });
  }

  try {
    const email = req.body?.email;

    if (!email || typeof email !== "string") {
      return res.status(400).json({
        success: false,
        message: "Email is required.",
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const otp = generateOtp();
    const otpHash = hashValue(otp);
    const emailHash = hashValue(normalizedEmail);

    const expiresAt = new Date(
      Date.now() + 10 * 60 * 1000
    );

    const oldRequests = await db
      .collection("otp_requests")
      .where("emailHash", "==", emailHash)
      .where("verified", "==", false)
      .where("invalidated", "==", false)
      .get();

    const batch = db.batch();

    oldRequests.forEach((doc) => {
      batch.update(doc.ref, {
        invalidated: true,
      });
    });

    if (!oldRequests.empty) {
      await batch.commit();
    }

    await db.collection("otp_requests").add({
      emailHash: emailHash,
      otpHash: otpHash,
      expiresAt: Timestamp.fromDate(expiresAt),
      attempts: 0,
      verified: false,
      invalidated: false,
      createdAt: FieldValue.serverTimestamp(),
    });

    const result = await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL,
      to: [normalizedEmail],
      subject: "Your Sumitra HP Gas Verification OTP",

      html: `
        <div style="font-family:Arial,sans-serif;max-width:500px;margin:auto;padding:20px">

          <h2 style="color:#1976D2">
            SUMITRA HP GAS
          </h2>

          <p>
            Your verification OTP is:
          </p>

          <div style="
            font-size:32px;
            font-weight:bold;
            letter-spacing:8px;
            padding:20px;
            background:#EAF6FF;
            text-align:center;
            border-radius:12px;
          ">
            ${otp}
          </div>

          <p>
            This OTP is valid for
            <strong>10 minutes</strong>.
          </p>

          <p>
            If you did not request this OTP,
            please ignore this email.
          </p>

          <hr>

          <p style="color:#78909C;font-size:12px">
            Sumitra HP Gas — Rasalpur
          </p>

        </div>
      `,
    });

    if (result.error) {
      console.error("Resend error:", result.error);

      return res.status(500).json({
        success: false,
        message: "Unable to send OTP.",
      });
    }

    console.log("OTP sent to:", normalizedEmail);

    return res.status(200).json({
      success: true,
      message: "OTP sent successfully.",
    });

  } catch (error) {
    console.error("Send OTP error:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Unable to send OTP.",
    });
  }
}

module.exports = sendOtp;
