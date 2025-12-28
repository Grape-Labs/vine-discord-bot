// lib/discord/commands.js
const { PublicKey } = require("@solana/web3.js");

const DISCORD_API = "https://discord.com/api/v10";

// Solana base58 pubkey (32–44 chars), avoiding 0/O/I/l etc
const SOL_WALLET_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

function reply(res, content, ephemeral = true) {
  const payload = {
    type: 4,
    data: { content },
  };

  if (ephemeral) payload.data.flags = 64; // EPHEMERAL
  return res.status(200).json(payload);
}

function isValidSolanaPubkey(s) {
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

async function discordFetch(path, opts = {}) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("Missing DISCORD_BOT_TOKEN");

  const res = await fetch(`${DISCORD_API}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bot ${token}`,
      ...(opts.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discord API ${res.status}: ${text}`);
  }

  // Some endpoints may return empty
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function extractWalletsFromText(text) {
  if (!text) return [];
  return text.match(SOL_WALLET_RE) || [];
}

async function fetchThreadWallets(threadId, maxMessages = 500) {
  const wallets = new Set();
  let before = null;
  let fetched = 0;

  while (fetched < maxMessages) {
    const qs = new URLSearchParams({ limit: "100" });
    if (before) qs.set("before", before);

    const msgs = await discordFetch(`/channels/${threadId}/messages?${qs.toString()}`);

    if (!msgs || msgs.length === 0) break;

    for (const m of msgs) {
      fetched++;
      const content = m.content || "";
      for (const w of extractWalletsFromText(content)) wallets.add(w);

      // paginate older using the oldest message we’ve seen
      before = m.id;

      if (fetched >= maxMessages) break;
    }

    if (msgs.length < 100) break;
  }

  return Array.from(wallets);
}

async function handleCheckin(interaction, res) {
  const userId = interaction.member?.user?.id || interaction.user?.id;

  const wallet = interaction.data?.options?.find((o) => o.name === "wallet")?.value;

  if (!wallet) return reply(res, "❌ Missing wallet. Example: `/checkin wallet:<address>`", true);
  if (!isValidSolanaPubkey(wallet)) return reply(res, "❌ Invalid Solana wallet address.", true);

  // ✅ Public message including wallet (fastest ship)
  return reply(res, `✅ <@${userId}> checked in: \`${wallet}\``, false);
}

async function handleAwardParticipation(interaction, res) {
  const threadId = interaction.channel_id;
  const amount =
    Number(interaction.data?.options?.find((o) => o.name === "amount")?.value ?? 1) || 1;

  // NOTE: permissions: bot needs View Channel + Read Message History in this thread
  try {
    const wallets = await fetchThreadWallets(threadId, 500);

    if (!wallets.length) {
      return reply(res, "No wallets found in this thread yet.", false);
    }

    // For now: show preview + count. Next step: award on-chain.
    const preview = wallets.slice(0, 15).map((w) => `\`${w}\``).join("\n");
    const more = wallets.length > 15 ? `\n…and ${wallets.length - 15} more` : "";

    return reply(
      res,
      `✅ Found **${wallets.length}** unique wallet(s) in this thread.\n` +
        `Planned award amount: **${amount}** each.\n\n` +
        `${preview}${more}`,
      false
    );
  } catch (e) {
    return reply(res, `❌ Error reading thread messages: ${e.message}`, true);
  }
}

async function handleSlashCommand(interaction, res) {
  const name = interaction.data?.name;

  if (name === "checkin") return handleCheckin(interaction, res);
  if (name === "award_participation") return handleAwardParticipation(interaction, res);

  return reply(res, `Unknown command: ${name}`, true);
}

module.exports = { handleSlashCommand };