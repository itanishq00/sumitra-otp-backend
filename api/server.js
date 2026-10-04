require("dotenv").config();

const express = require("express");

const sendOtp = require("./api/send-otp");
const verifyOtp = require("./api/verify-otp");

const app = express();

app.use(express.json());

app.post("/api/send-otp", sendOtp);
app.post("/api/verify-otp", verifyOtp);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`OTP backend running on http://localhost:${PORT}`);
});