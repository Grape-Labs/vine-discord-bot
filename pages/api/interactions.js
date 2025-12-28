// pages/api/interactions.js
const { verifyKey, InteractionType, InteractionResponseType } = require("discord-interactions");

// Helper to read the raw body as a Buffer
async function getRawBody(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

const handler = async (req, res) => {
  // 1. Only allow POST requests
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  // 2. Extract headers
  const signature = req.headers["x-signature-ed25519"];
  const timestamp = req.headers["x-signature-timestamp"];
  
  // 3. Get the Raw Body (Crucial for verification)
  const rawBody = await getRawBody(req);

  // 4. Verify the signature
  // We pass the rawBody Buffer directly, which is safer than converting to string
  const isValidRequest = verifyKey(
    rawBody,
    signature,
    timestamp,
    process.env.DISCORD_PUBLIC_KEY
  );

  if (!isValidRequest) {
    console.error("Signature verification failed.");
    return res.status(401).send("Invalid request signature");
  }

  // 5. Parse the body
  const interaction = JSON.parse(rawBody.toString("utf-8"));

  // 6. Handle PING (This fixes the "interactions_endpoint_url" error)
  if (interaction.type === InteractionType.PING) {
    console.log("PING received, sending PONG...");
    return res.status(200).json({
      type: InteractionResponseType.PONG,
    });
  }

  // 7. Handle Commands (Slash commands)
  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    return res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: "Hello! Interaction received.",
      },
    });
  }

  return res.status(400).json({ error: "Unknown interaction type" });
};

module.exports = handler;

// Important: Disable Next.js body parser so we can read raw bytes
module.exports.config = {
  api: {
    bodyParser: false,
  },
};