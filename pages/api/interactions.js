const { verifyKey, InteractionType, InteractionResponseType } = require("discord-interactions");

// Standard helper for Next.js to get Raw Body
async function getRawBody(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

module.exports = async function handler(req, res) {
  // 1. Only allow POST
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  // 2. Extract headers
  const signature = req.headers["x-signature-ed25519"];
  const timestamp = req.headers["x-signature-timestamp"];
  
  // 3. Get Raw Body (Crucial for verification)
  const rawBody = await getRawBody(req);

  // 4. Verify Signature
  const isValidRequest = verifyKey(
    rawBody,
    signature,
    timestamp,
    process.env.DISCORD_PUBLIC_KEY
  );

  if (!isValidRequest) {
    console.error("Invalid Request Signature");
    return res.status(401).send("Bad request signature");
  }

  // 5. Parse Body
  const interaction = JSON.parse(rawBody.toString());

  // 6. Handle PING (This fixes the Developer Portal error)
  if (interaction.type === InteractionType.PING) {
    return res.status(200).json({
      type: InteractionResponseType.PONG,
    });
  }

  // 7. Handle actual commands
  return res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: "Interaction received!" },
  });
};

// Essential: Disable the automatic parser
export const config = {
  api: {
    bodyParser: false,
  },
};