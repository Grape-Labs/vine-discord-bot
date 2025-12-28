// pages/api/interactions.js
const { verifyKey } = require("discord-interactions");

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) =>
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
    );
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

  const publicKey = process.env.DISCORD_PUBLIC_KEY;

  const sig = req.headers["x-signature-ed25519"];
  const ts = req.headers["x-signature-timestamp"];
  const sig1 = Array.isArray(sig) ? sig[0] : sig;
  const ts1 = Array.isArray(ts) ? ts[0] : ts;

  if (!publicKey) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.end(JSON.stringify({ error: "Missing DISCORD_PUBLIC_KEY" }));
  }

  if (!sig1 || !ts1) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.end(JSON.stringify({ error: "Missing signature headers" }));
  }

  const ok = verifyKey(raw, sig1, ts1, publicKey);
  if (!ok) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.end(JSON.stringify({ error: "Bad signature" }));
  }

  let interaction;
  try {
    interaction = JSON.parse(rawText);
  } catch (e) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.end(JSON.stringify({ error: "Bad JSON" }));
  }

  // ✅ Verification requires this exact response
  if (interaction.type === 1) {
    console.log("PING host:", req.headers.host, "url:", req.url);
    //console.log("DISCORD PING VERIFIED FOR APP:", process.env.DISCORD_APP_ID);
    //console.log("DISCORD PING VERIFIED FOR PK:", process.env.DISCORD_PUBLIC_KEY);
    const body = '{"type":1}';
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Length", String(Buffer.byteLength(body)));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Connection", "close");
    res.setHeader("Content-Encoding", "identity");

    console.log("SENDING PONG", {
        status: 200,
        contentType: "application/json",
        contentLength: String(Buffer.byteLength(body)),
        body,
        });
    return res.end(body);
  }

  // ACK other interactions (we'll route commands after verification succeeds)
  const body = JSON.stringify({ type: 4, data: { content: "ok" } });
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.setHeader("Cache-Control", "no-store");
  return res.end(body);
};

module.exports.config = {
  api: { bodyParser: false },
};