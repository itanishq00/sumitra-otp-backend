const https = require("https");

module.exports = async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  try {
    const {
      mobileNumber,
      otp,
      verificationId
    } = req.body || {};

    if (!mobileNumber || !otp || !verificationId) {
      return res.status(400).json({
        success: false,
        message: "Mobile number, OTP and verification ID are required."
      });
    }

    const cleanedNumber = String(mobileNumber).replace(/\D/g, "");
    const cleanedOtp = String(otp).trim();

    if (cleanedNumber.length !== 10) {
      return res.status(400).json({
        success: false,
        message: "Invalid mobile number."
      });
    }

    if (!/^\d{4,6}$/.test(cleanedOtp)) {
      return res.status(400).json({
        success: false,
        message: "Invalid OTP."
      });
    }

    const customerId = process.env.MESSAGE_CENTRAL_CUSTOMER_ID;
    const authToken = process.env.MESSAGE_CENTRAL_AUTH_TOKEN;

    if (!customerId || !authToken) {
      console.error("Message Central credentials missing");

      return res.status(500).json({
        success: false,
        message: "OTP service configuration missing."
      });
    }

    const url = new URL(
      "https://cpaas.messagecentral.com/verification/v3/validateOtp"
    );

    url.searchParams.set("countryCode", "91");
    url.searchParams.set("mobileNumber", cleanedNumber);
    url.searchParams.set("verificationId", String(verificationId));
    url.searchParams.set("customerId", customerId);
    url.searchParams.set("code", cleanedOtp);

    const options = {
      method: "GET",
      headers: {
        authToken: authToken
      }
    };

    const request = https.request(url, options, (response) => {
      let data = "";

      response.on("data", (chunk) => {
        data += chunk;
      });

      response.on("end", () => {
        try {
          const result = JSON.parse(data);

          console.log("Message Central Verify OTP:", result);

          if (
            response.statusCode === 200 &&
            result.responseCode === 200 &&
            result.data?.verificationStatus ===
              "VERIFICATION_COMPLETED"
          ) {
            return res.status(200).json({
              success: true,
              message: "OTP verified successfully."
            });
          }

          if (result.responseCode === 705) {
            return res.status(400).json({
              success: false,
              message: "OTP expired. Please request a new OTP."
            });
          }

          return res.status(400).json({
            success: false,
            message: result.message || "Invalid OTP.",
            details: result
          });
        } catch (error) {
          console.error("Message Central verify response error:", error);

          return res.status(500).json({
            success: false,
            message: "Invalid response from OTP service."
          });
        }
      });
    });

    request.on("error", (error) => {
      console.error("Message Central verify request error:", error);

      return res.status(500).json({
        success: false,
        message: "Unable to connect to OTP service."
      });
    });

    request.end();
  } catch (error) {
    console.error("Verify OTP error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to verify OTP."
    });
  }
};
