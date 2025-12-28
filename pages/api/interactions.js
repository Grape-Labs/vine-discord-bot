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
  if (req.method !== "POST") return res.status(405).end();

  const signature = req.headers["x-signature-ed25519"];
  const timestamp = req.headers["x-signature-timestamp"];
  const rawBody = await getRawBody(req);

  const isValidRequest = verifyKey(
    rawBody,
    signature,
    timestamp,
    process.env.DISCORD_PUBLIC_KEY
  );

  console.log("Verification Result:", isValidRequest);

  if (!isValidRequest) {
    return res.status(401).end("invalid request signature");
  }

  const interaction = JSON.parse(rawBody.toString());

  if (interaction.type === 1) {
    // Return EXACTLY what Discord wants with no extra whitespace
    return res.status(200).json({ type: 1 });
  }

  return res.status(200).json({
    type: 4,
    data: { content: "Verified" }
  });
};

module.exports.config = {
  api: { bodyParser: false },
};