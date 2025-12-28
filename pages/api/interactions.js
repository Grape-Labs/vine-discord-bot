const { verifyKey, InteractionType, InteractionResponseType } = require("discord-interactions");

// Helper to read the stream into a Buffer
async function getRawBody(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

module.exports = async function handler(req, res) {
  // 1. Only POST is required for Discord Interactions
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const signature = req.headers["x-signature-ed25519"];
  const timestamp = req.headers["x-signature-timestamp"];
  
  // 2. Get the Raw Body (Crucial for cryptographic verification)
  const rawBody = await getRawBody(req);

  // 3. Verify the signature
  const isValidRequest = verifyKey(
    rawBody,
    signature,
    timestamp,
    process.env.DISCORD_PUBLIC_KEY
  );

  if (!isValidRequest) {
    return res.status(401).send("Invalid request signature");
  }

  // 4. Parse the body
  const interaction = JSON.parse(rawBody.toString());

  // 5. Handle PING (This is what the Developer Portal checks)
  if (interaction.type === InteractionType.PING) {
    return res.status(200).json({
      type: InteractionResponseType.PONG,
    });
  }

  // 6. Handle actual interactions (Commands, Buttons, etc.)
  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    return res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: "Hello! Interaction verified successfully.",
      },
    });
  }

  return res.status(400).json({ error: "Unknown interaction type" });
};

// 7. DISABLE the default body parser
export const config = {
  api: {
    bodyParser: false,
  },
};