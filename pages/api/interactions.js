// pages/api/interactions.js
const { verifyKey } = require("discord-interactions");

async function getRawBody(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

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

  const interaction = JSON.parse(rawBody.toString("utf-8"));

  if (interaction.type === 1) {
    // We send a raw string to prevent any automatic formatting
    res.setHeader("Content-Type", "application/json");
    return res.status(200).send(JSON.stringify({ type: 1 }));
  }

  if (interaction.type === 2) {
    return res.status(200).json({
      type: 4,
      data: { content: "Interaction verified!" },
    });
  }

  return res.status(400).json({ error: "Unknown type" });
};

module.exports.config = {
  api: { bodyParser: false },
};