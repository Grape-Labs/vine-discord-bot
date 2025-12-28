// pages/api/interactions.js
const { verifyKey } = require("discord-interactions");

// raw body reader (required)
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

module.exports = async function handler(req, res) {
  // Discord may probe GET/HEAD/OPTIONS before verification
  if (req.method === "GET") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.end("ok");
  }

  if (req.method === "HEAD") {
    res.statusCode = 200;
    res.setHeader("Cache-Control", "no-store");
    return res.end();
  }

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Allow", "POST, GET, HEAD, OPTIONS");
    res.setHeader("Cache-Control", "no-store");
    return res.end();
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST, GET, HEAD, OPTIONS");
    res.setHeader("Cache-Control", "no-store");
    return res.end("Method Not Allowed");
  }

  // MUST verify signature using the RAW request body bytes
  const raw = await readRawBody(req);
  const rawText = raw.toString("utf8");

  const sig = req.headers["x-signature-ed25519"];
  const ts = req.headers["x-signature-timestamp"];
  const publicKey = process.env.DISCORD_PUBLIC_KEY;

  if (!publicKey) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({ error: "Missing DISCORD_PUBLIC_KEY" }));
  }

  if (!sig || !ts) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({ error: "Missing signature headers" }));
  }

  const ok = verifyKey(rawText, sig, ts, publicKey);
  if (!ok) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({ error: "Bad signature" }));
  }

  let interaction;
  try {
    interaction = JSON.parse(rawText);
  } catch (e) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({ error: "Bad JSON" }));
  }

  // ✅ Verification requires this exact response
  if (interaction.type === 1) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.end('{"type":1}');
  }

  // For now, just ACK other interactions (after save succeeds we can route commands)
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.end(JSON.stringify({ type: 4, data: { content: "ok" } }));
};

module.exports.config = {
  api: { bodyParser: false },
};