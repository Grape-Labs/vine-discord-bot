// pages/api/interactions.js
const { verifyKey } = require("discord-interactions");

async function getRawBody(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end();
  }

  const signature = req.headers["x-signature-ed25519"];
  const timestamp = req.headers["x-signature-timestamp"];
  const publicKey = process.env.DISCORD_PUBLIC_KEY;

  const rawBody = await getRawBody(req);

  if (!signature || !timestamp) {
    res.statusCode = 401;
    return res.end("Missing signature headers");
  }
  if (!publicKey) {
    res.statusCode = 500;
    return res.end("Missing DISCORD_PUBLIC_KEY");
  }

  // ✅ In your environment verifyKey is async -> await it
  const isValidRequest = await verifyKey(
    rawBody,            // Buffer is fine
    signature,
    timestamp,
    publicKey
  );

  console.log("Verification Result:", isValidRequest);

  if (!isValidRequest) {
    res.statusCode = 401;
    return res.end("Invalid request signature");
  }

  const interaction = JSON.parse(rawBody.toString("utf8"));

  // ✅ Respond to PING exactly
  if (interaction.type === 1) {
    const body = '{"type":1}';
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Length", String(Buffer.byteLength(body)));
    res.setHeader("Cache-Control", "no-store");
    return res.end(body);
  }

  const body = JSON.stringify({
    type: 4,
    data: { content: "Interaction verified and processed." },
  });

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Length", String(Buffer.byteLength(body)));
  res.setHeader("Cache-Control", "no-store");
  return res.end(body);
};

module.exports.config = {
  api: { bodyParser: false },
};