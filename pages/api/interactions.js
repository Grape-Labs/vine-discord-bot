// pages/api/interactions.js
const discordHandler = require("./discord");

module.exports = async function interactions(req, res) {
  if (req.method === "GET") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.end("ok");
  }

  return discordHandler(req, res);
};

module.exports.config = {
  api: { bodyParser: false },
};