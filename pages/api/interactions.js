// pages/api/interactions.js
const { verifyKey } = require("discord-interactions");

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) =>
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    );
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(text));
  res.setHeader("Cache-Control", "no-store");
  res.end(text);
}

module.exports = async function handler(req, res) {
  // Discord verification is POST
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.setHeader("Cache-Control", "no-store");
    return res.end("Method Not Allowed");
  }

  const rawBodyBuf = await readRawBody(req);
  const rawBody = rawBodyBuf.toString("utf8");

  const sig = req.headers["x-signature-ed25519"];
  const ts = req.headers["x-signature-timestamp"];
  const publicKey = process.env.DISCORD_PUBLIC_KEY;

  if (!sig || !ts) return sendJson(res, 401, { error: "Missing signature" });
  if (!publicKey) return sendJson(res, 500, { error: "Missing public key" });

  const isValid = verifyKey(rawBody, sig, ts, publicKey);
  if (!isValid) return sendJson(res, 401, { error: "Bad signature" });

  let interaction;
  try {
    interaction = JSON.parse(rawBody);
  } catch (e) {
    return sendJson(res, 400, { error: "Bad JSON" });
  }

  // The ONLY thing Discord needs to verify the URL:
  if (interaction.type === 1) {
    // respond with strict JSON PONG
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.end('{"type":1}');
  }

  // For now, just acknowledge anything else while we verify saving works
  return sendJson(res, 200, { type: 4, data: { content: "ok" } });
};

module.exports.config = {
  api: { bodyParser: false },
};