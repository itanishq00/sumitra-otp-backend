const crypto = require("crypto");
const admin = require("firebase-admin");
const {
  getFirestore,
  Timestamp,
} = require("firebase-admin/firestore");

const serviceAccount = require("../gas-agency-app-54892e678200.json");

if (admin.getApps().length === 0) {
  admin.initializeApp({
    credential: admin.cert(serviceAccount),
  });
}

const db = getFirestore();

function hashValue(value) {
  return crypto
    .createHash("sha256")
    .update(value)
    .digest("hex");
}

module.exports = async function verifyOtp(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed.",
    });
  }

  try {
    const { email, otp } = req.body || {};

    if (
      typeof email !== "string" ||
      typeof otp !== "string"
    ) {
      return res.status(400).json({
        success: false,
        message: "Email and OTP are required.",
      });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const normalizedOtp = otp.trim();

    const emailRegex =
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailRegex.test(normalizedEmail)) {
      return res.status(400).json({
        success: false,
        message: "Invalid email address.",
      });
    }

    if (!/^\d{6}$/.test(normalizedOtp)) {
      return res.status(400).json({
        success: false,
        message: "OTP must be 6 digits.",
      });
    }

    const emailHash = hashValue(normalizedEmail);
    const otpHash = hashValue(normalizedOtp);

    const snapshot = await db
      .collection("otp_requests")
      .where("emailHash", "==", emailHash)
      .where("verified", "==", false)
      .where("invalidated", "==", false)
      .get();

    if (snapshot.empty) {
      return res.status(400).json({
        success: false,
        message:
          "No active OTP found. Please request a new OTP.",
      });
    }

    const documents = snapshot.docs.sort((a, b) => {
      const aTime =
        a.data().createdAt?.toMillis?.() || 0;

      const bTime =
        b.data().createdAt?.toMillis?.() || 0;

      return bTime - aTime;
    });

    const otpDoc = documents[0];
    const otpData = otpDoc.data();

    if (!otpData.expiresAt) {
      return res.status(400).json({
        success: false,
        message:
          "OTP expiry information is missing.",
      });
    }

    if (Date.now() > otpData.expiresAt.toMillis()) {
      await otpDoc.ref.update({
        invalidated: true,
      });

      return res.status(400).json({
        success: false,
        message:
          "OTP has expired. Please request a new OTP.",
      });
    }

    const attempts =
      Number(otpData.attempts || 0);

    if (attempts >= 5) {
      await otpDoc.ref.update({
        invalidated: true,
      });

      return res.status(429).json({
        success: false,
        message:
          "Too many incorrect attempts. Please request a new OTP.",
      });
    }

    if (otpData.otpHash !== otpHash) {
      await otpDoc.ref.update({
        attempts: attempts + 1,
      });

      return res.status(400).json({
        success: false,
        message: "Incorrect OTP.",
      });
    }

    await otpDoc.ref.update({
      verified: true,
      verifiedAt: Timestamp.now(),
    });

    return res.status(200).json({
      success: true,
      message: "OTP verified successfully.",
    });

  } catch (error) {
    console.error("Verify OTP error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to verify OTP.",
    });
  }
};
