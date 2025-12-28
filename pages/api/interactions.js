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

function setNoStore(res) {
  res.setHeader("Cache-Control", "no-store");
}

function sendText(res, status, text) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  setNoStore(res);
  return res.end(text || "");
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  setNoStore(res);
  return res.end(body);
}

module.exports = async function handler(req, res) {
  const ua = req.headers["user-agent"] || "";

  // ✅ Discord/portal often probes with HEAD/GET first
  if (req.method === "HEAD") {
    res.statusCode = 200;
    setNoStore(res);
    return res.end();
  }

  if (req.method === "GET") {
    return sendText(res, 200, "ok");
  }

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Allow", "POST, GET, HEAD, OPTIONS");
    setNoStore(res);
    return res.end();
  }

  // ✅ Actual Discord verification is POST
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, GET, HEAD, OPTIONS");
    return sendText(res, 405, "Method Not Allowed");
  }

  const rawBodyBuf = await readRawBody(req);
  const rawBody = rawBodyBuf.toString("utf8");

  const sig = req.headers["x-signature-ed25519"];
  const ts = req.headers["x-signature-timestamp"];
  const publicKey = process.env.DISCORD_PUBLIC_KEY;

  if (!publicKey) return sendJson(res, 500, { error: "Missing DISCORD_PUBLIC_KEY" });
  if (!sig || !ts) return sendJson(res, 401, { error: "Missing signature" });

  const ok = verifyKey(rawBody, sig, ts, publicKey);
  if (!ok) return sendJson(res, 401, { error: "Invalid signature" });

  let interaction;
  try {
    interaction = JSON.parse(rawBody);
  } catch {
    return sendJson(res, 400, { error: "Invalid JSON" });
  }

  // ✅ PING -> strict PONG
  if (interaction.type === 1) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    setNoStore(res);
    return res.end('{"type":1}');
  }

  // Temporary ack for anything else
  return sendJson(res, 200, { type: 4, data: { content: "ok" } });
};

module.exports.config = {
  api: { bodyParser: false },
};