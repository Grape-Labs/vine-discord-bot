// pages/api/interactions.js
const { verifyKey } = require("discord-interactions");

async function getRawBody(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sendJson(res, status, bodyObj) {
  const body = JSON.stringify(bodyObj);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Length", String(Buffer.byteLength(body)));
  res.setHeader("Cache-Control", "no-store");
  return res.end(body);
}

module.exports = async (req, res) => {
  // Probe-friendly
  if (req.method === "GET") return res.end("ok");
  if (req.method === "HEAD") return res.end();
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Allow", "POST, GET, HEAD, OPTIONS");
    res.setHeader("Cache-Control", "no-store");
    return res.end();
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST, GET, HEAD, OPTIONS");
    return res.end();
  }

  const signature = req.headers["x-signature-ed25519"];
  const timestamp = req.headers["x-signature-timestamp"];
  const publicKey = process.env.DISCORD_PUBLIC_KEY;

  const rawBody = await getRawBody(req);

  if (!signature || !timestamp) return sendJson(res, 401, { error: "Missing signature headers" });
  if (!publicKey) return sendJson(res, 500, { error: "Missing DISCORD_PUBLIC_KEY" });

  const isValidRequest = await verifyKey(rawBody, signature, timestamp, publicKey);
  if (!isValidRequest) return sendJson(res, 401, { error: "Invalid request signature" });

  let interaction;
  try {
    interaction = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return sendJson(res, 400, { error: "Bad JSON" });
  }

  // PING -> PONG (keep exact)
  if (interaction.type === 1) {
    const body = '{"type":1}';
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Length", String(Buffer.byteLength(body)));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Encoding", "identity");
    return res.end(body);
  }

  // ---- COMMAND ROUTER (add your logic here) ----
  // Slash commands are type 2. Component interactions are type 3.
  if (interaction.type === 2) {
    const name = interaction.data?.name;

    if (name === "points") {
      // TODO: paste your points handler here (add/balance with KV)
      return sendJson(res, 200, { type: 4, data: { content: "points command received ✅" } });
    }

    return sendJson(res, 200, { type: 4, data: { content: `Unknown command: ${name}` } });
  }

  // Default ACK for anything else
  return sendJson(res, 200, { type: 4, data: { content: "Interaction received." } });
};

module.exports.config = {
  api: { bodyParser: false },
};