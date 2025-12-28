// lib/discord/commands.js
const { PublicKey } = require("@solana/web3.js");

// KV is OPTIONAL. We only enable it if the required env vars exist.
let kv = null;
try {
  const mod = require("@vercel/kv");
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    kv = mod.kv;
  } else {
    kv = null;
  }
} catch (e) {
  kv = null;
}

function reply(res, content, ephemeral = true) {
  return res.status(200).json({
    type: 4,
    data: {
      content,
      flags: ephemeral ? 64 : 0, // 64 = EPHEMERAL
    },
  });
}

function isValidSolanaPubkey(s) {
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

async function handleCheckin(interaction, res) {
  const guildId = interaction.guild_id;
  const channelId = interaction.channel_id; // thread/channel where used
  const userId = interaction.member?.user?.id || interaction.user?.id;

  // option name must match your slash command definition: "wallet"
  const wallet = interaction.data?.options?.find((o) => o.name === "wallet")?.value;

  if (!wallet) return reply(res, "❌ Missing wallet. Example: `/checkin wallet:<address>`");
  if (!isValidSolanaPubkey(wallet)) return reply(res, "❌ Invalid Solana wallet address.");

  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // Store in KV if available (optional persistence)
  if (kv) {
    // Track who checked in for this thread + day
    await kv.sadd(`checkin:${guildId}:${day}:${channelId}`, wallet);

    // Link Discord user → wallet
    await kv.set(`wallet:${guildId}:${userId}`, wallet);
  }

  // Even without KV, still confirm check-in
  return reply(
    res,
    kv
      ? `✅ Checked in: \`${wallet}\` (saved)`
      : `✅ Checked in: \`${wallet}\` (not saved yet — KV not configured)`
  );
}

async function handleSlashCommand(interaction, res) {
  const name = interaction.data?.name;

  if (name === "checkin") return handleCheckin(interaction, res);

  return reply(res, `Unknown command: ${name}`);
}

module.exports = { handleSlashCommand };