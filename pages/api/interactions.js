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
  
  // 1. Get the raw body as a BUFFER
  const rawBody = await getRawBody(req);

  // 2. Verify Key is SYNCHRONOUS. Do not await it.
  // Ensure process.env.DISCORD_PUBLIC_KEY is a string.
  const isValidRequest = verifyKey(
    rawBody, 
    signature, 
    timestamp, 
    process.env.DISCORD_PUBLIC_KEY
  );

  console.log("Verification Result:", isValidRequest);

  if (!isValidRequest) {
    console.error("Verification failed for signature:", signature);
    return res.status(401).send("Invalid request signature");
  }

  // 3. Only parse after successful verification
  const interaction = JSON.parse(rawBody.toString());

  if (interaction.type === 1) {
    return res.status(200).json({ type: 1 });
  }

  return res.status(200).json({
    type: 4,
    data: { content: "Interaction verified and processed." }
  });
};

module.exports.config = {
  api: { bodyParser: false },
};