// pages/api/interactions.js
const { verifyKey } = require("discord-interactions");
const fetch = require("node-fetch");
const { handleSlashCommand } = require("../../lib/discord/commands");

const DISCORD_API = "https://discord.com/api/v10";

async function getRawBody(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function interactionAppId(interaction) {
  return interaction.application_id || process.env.DISCORD_APP_ID;
}

async function discordEditOriginal(interaction, content) {
  const appId = interactionAppId(interaction);
  const token = interaction.token;
  const botToken = process.env.DISCORD_BOT_TOKEN;

  if (!appId) throw new Error("Missing DISCORD_APP_ID");
  if (!token) throw new Error("Missing interaction.token");
  if (!botToken) throw new Error("Missing DISCORD_BOT_TOKEN");

  const url = `${DISCORD_API}/webhooks/${appId}/${token}/messages/@original`;

  const r = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content }),
  });

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`edit original failed ${r.status}: ${text}`);
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();

  const rawBody = await getRawBody(req);
  const signature = req.headers["x-signature-ed25519"];
  const timestamp = req.headers["x-signature-timestamp"];

  const isValid = verifyKey(
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
    const name = interaction.data?.name;

    // Defer for anything that might touch Discord APIs / KV / chain
    const shouldDefer = ["checkin", "award_participation", "setspace"].includes(name);

    if (!shouldDefer) {
      // Fast paths can reply normally
      return handleSlashCommand(interaction, res);
    }

    // ✅ ACK immediately (must be within ~3 seconds)
    res.status(200).json({ type: 5, data: { flags: 64 } }); // ephemeral "thinking…"

    // ✅ Continue work after ACK and update original response
    try {
      // IMPORTANT: your commands.js must support a "deferred mode"
      // If it DOESN'T yet, see Fix B below.
      const result = await handleSlashCommand(interaction, null, { deferred: true });
      if (typeof result === "string" && result.length) {
        await discordEditOriginal(interaction, result);
      }
    } catch (e) {
      await discordEditOriginal(interaction, `❌ Error: ${e?.message || String(e)}`);
    }

    return;
  }

  return res.status(200).end();
};

module.exports.config = {
  api: { bodyParser: false },
};