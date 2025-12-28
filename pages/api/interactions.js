import { verifyKey, InteractionType, InteractionResponseType } from "discord-interactions";

// Helper to read the stream into a Buffer for ESM
async function getRawBody(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  // 1. Only POST is required for Discord Interactions
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const signature = req.headers["x-signature-ed25519"];
  const timestamp = req.headers["x-signature-timestamp"];
  
  // 2. Get the Raw Body
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

  // 5. Handle PING (Critical for Discord Portal verification)
  if (interaction.type === InteractionType.PING) {
    return res.status(200).json({
      type: InteractionResponseType.PONG,
    });
  }

  // 6. Handle actual interactions
  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    return res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: "Success! ESM interaction verified.",
      },
    });
  }

  return res.status(400).json({ error: "Unknown interaction type" });
}

// 7. Disable the default body parser (MUST use 'export' here)
export const config = {
  api: {
    bodyParser: false,
  },
};