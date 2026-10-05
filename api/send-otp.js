const https = require("https");

module.exports = async (req, res) => {
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
    const { mobileNumber } = req.body || {};

    if (!mobileNumber) {
      return res.status(400).json({
        success: false,
        message: "Mobile number is required."
      });
    }

    const cleanedNumber = String(mobileNumber).replace(/\D/g, "");

    if (cleanedNumber.length !== 10) {
      return res.status(400).json({
        success: false,
        message: "Invalid mobile number."
      });
    }

    const authToken = process.env.MESSAGE_CENTRAL_AUTH_TOKEN;

    if (!authToken) {
      console.error("Message Central auth token missing");

      return res.status(500).json({
        success: false,
        message: "OTP service configuration missing."
      });
    }

    const url = new URL(
      "https://cpaas.messagecentral.com/verification/v3/send"
    );

    url.searchParams.set("countryCode", "91");
    url.searchParams.set("flowType", "SMS");
    url.searchParams.set("mobileNumber", cleanedNumber);

    const request = https.request(
      url,
      {
        method: "POST",
        headers: {
          authToken: authToken
        }
      },
      (response) => {
        let data = "";

        response.on("data", (chunk) => {
          data += chunk;
        });

        response.on("end", () => {
          try {
            const result = JSON.parse(data);

            console.log("Message Central Send OTP:", result);

            if (
              response.statusCode === 200 &&
              result.responseCode === 200 &&
              result.data &&
              result.data.verificationId
            ) {
              return res.status(200).json({
                success: true,
                message: "OTP sent successfully.",
                verificationId: String(result.data.verificationId)
              });
            }

            return res.status(400).json({
              success: false,
              message: result.message || "Unable to send OTP."
            });
          } catch (error) {
            console.error("Response parsing error:", error);

            return res.status(500).json({
              success: false,
              message: "Invalid response from OTP service."
            });
          }
        });
      }
    );

    request.on("error", (error) => {
      console.error("Message Central request error:", error);

      return res.status(500).json({
        success: false,
        message: "Unable to connect to OTP service."
      });
    });

    request.end();
  } catch (error) {
    console.error("Send OTP error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to send OTP."
    });
  }
};
