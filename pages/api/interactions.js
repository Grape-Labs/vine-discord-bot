// pages/api/interactions.js
const { verifyKey } = require("discord-interactions");
const { handleSlashCommand } = require("../../lib/discord/commands");

async function getRawBody(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();

  const rawBody = await getRawBody(req);
  const signature = req.headers["x-signature-ed25519"];
  const timestamp = req.headers["x-signature-timestamp"];

  const isValid = await verifyKey(
    rawBody,
    signature,
    timestamp,
    process.env.DISCORD_PUBLIC_KEY
  );

  if (!isValid) return res.status(401).end("Invalid signature");

  const interaction = JSON.parse(rawBody.toString("utf8"));

  // Discord PING
  if (interaction.type === 1) {
    return res
      .status(200)
      .setHeader("Content-Type", "application/json")
      .end('{"type":1}');
  }

  // Slash commands
  if (interaction.type === 2) {
    return handleSlashCommand(interaction, res);
  }

  return res.status(200).end();
};

module.exports.config = {
  api: { bodyParser: false },
};