// pages/api/interactions.js

const discordHandler = require("./discord");

module.exports = async function interactions(req, res) {
  // Portal-friendly GET probe
  if (req.method === "GET") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.end("ok");
  }

  // Delegate EVERYTHING else (POST, OPTIONS, HEAD) to the real handler
  return discordHandler(req, res);
};

// IMPORTANT: preserve raw body handling
module.exports.config = {
  api: { bodyParser: false },
};