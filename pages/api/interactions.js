// pages/api/interactions.js
const { verifyKey } = require("discord-interactions");

// Helper: Read raw body for signature verification
async function getRawBody(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

const handler = async (req, res) => {
  // 1. Check method
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  // 2. Verify Signature
  const signature = req.headers["x-signature-ed25519"];
  const timestamp = req.headers["x-signature-timestamp"];
  const rawBody = await getRawBody(req);

  const isValidRequest = verifyKey(
    rawBody,
    signature,
    timestamp,
    process.env.DISCORD_PUBLIC_KEY
  );

  if (!isValidRequest) {
    return res.status(401).send("Invalid request signature");
  }

  // 3. Parse Body
  const interaction = JSON.parse(rawBody.toString("utf-8"));

  // 4. PING / PONG (Hardcoded for safety)
  if (interaction.type === 1) {
    console.log("PING received. Returning PONG.");
    // Directly return the raw JSON object Discord expects
    return res.status(200).json({ type: 1 });
  }

  // 5. Handle Commands
  if (interaction.type === 2) {
    return res.status(200).json({
      type: 4, // CHANNEL_MESSAGE_WITH_SOURCE
      data: {
        content: "Hello! Command received.",
      },
    });
  }

  return res.status(400).json({ error: "Unknown type" });
};

module.exports = handler;

module.exports.config = {
  api: {
    bodyParser: false,
  },
};