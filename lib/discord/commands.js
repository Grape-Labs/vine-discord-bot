// lib/discord/commands.js
const { PublicKey } = require("@solana/web3.js");
const { awardOnePointToWallets } = require("../solana/award");
const { awardOnePoint } = require("../solana/award");

const DISCORD_API = "https://discord.com/api/v10";
const SOL_WALLET_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

function todayUTC() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function awardMarker(day) {
  // Unique-ish marker we can search for in the thread
  return `VINE_AWARD_MARKER:${day}`;
}

function reply(res, content, ephemeral = true) {
  const payload = { type: 4, data: { content } };
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

  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function discordPostMessage(channelId, content) {
  return discordFetch(`/channels/${channelId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
}

function extractWalletsFromText(text) {
  if (!text) return [];
  return text.match(SOL_WALLET_RE) || [];
}

// Fetch messages in this thread
async function fetchThreadMessages(threadId, maxMessages = 300) {
  let before = null;
  let fetched = 0;
  const all = [];

  while (fetched < maxMessages) {
    const qs = new URLSearchParams({ limit: "100" });
    if (before) qs.set("before", before);

    const msgs = await discordFetch(`/channels/${threadId}/messages?${qs.toString()}`);
    if (!msgs || msgs.length === 0) break;

    for (const m of msgs) {
      all.push(m);
      fetched++;
      before = m.id;
      if (fetched >= maxMessages) break;
    }
    if (msgs.length < 100) break;
  }

  return all; // newest->older batches, but array is in fetch order (newest first per Discord)
}

async function hasAwardMarkerToday(threadId) {
  const day = todayUTC();
  const marker = awardMarker(day);

  // Only need to scan a reasonable amount (marker will be recent)
  const msgs = await fetchThreadMessages(threadId, 300);

  // If the bot posted marker today, it will be in content
  return msgs.some((m) => (m.content || "").includes(marker));
}

function normalizeAuthorId(msg) {
  // In threads, messages have author.id
  return msg?.author?.id || null;
}

function getFirstWalletInMessage(msg) {
  const w = extractWalletsFromText(msg?.content || "")[0];
  return w || null;
}

// Find the earliest (first) wallet a user posted in this thread (by scanning older messages last)
function buildFirstWalletByUser(messages) {
  // Discord returns newest first. We want oldest -> newest to capture FIRST wallet.
  const oldestFirst = [...messages].reverse();

  const firstByUser = new Map(); // userId -> wallet
  for (const m of oldestFirst) {
    const uid = normalizeAuthorId(m);
    if (!uid) continue;
    if (firstByUser.has(uid)) continue;

    const wallet = getFirstWalletInMessage(m);
    if (wallet && isValidSolanaPubkey(wallet)) {
      firstByUser.set(uid, wallet);
    }
  }
  return firstByUser;
}

async function handleStartParticipation(interaction, res) {
  const note = interaction.data?.options?.find((o) => o.name === "note")?.value;

  const now = new Date();

  // Format: Tue Dec 29, 2025
  const dateLabel = now.toLocaleDateString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  const msg =
    `**NEW DATE: ${dateLabel}**\n` +
    `Use \`/checkin wallet:<YOUR_SOLANA_WALLET>\` to check in for participation points.` +
    (note ? `\n\n${note}` : "");

  return reply(res, msg, false); // PUBLIC
}

async function handleCheckin(interaction, res) {
  const threadId = interaction.channel_id;
  const userId = interaction.member?.user?.id || interaction.user?.id;
  const wallet = interaction.data?.options?.find((o) => o.name === "wallet")?.value;

  if (!wallet) return reply(res, "❌ Missing wallet. Example: `/checkin wallet:<address>`", true);
  if (!isValidSolanaPubkey(wallet)) return reply(res, "❌ Invalid Solana wallet address.", true);

  // Enforce rule: ONE wallet per Discord user (first one counts)
  // Scan recent messages and see if this user already posted a wallet.
  try {
    const msgs = await fetchThreadMessages(threadId, 300);
    const firstByUser = buildFirstWalletByUser(msgs);

    if (firstByUser.has(userId)) {
      const existing = firstByUser.get(userId);
      return reply(
        res,
        `⚠️ <@${userId}> you already checked in with: \`${existing}\`\n` +
          `First wallet counts — no changes applied.`,
        false
      );
    }
  } catch (e) {
    // If we can’t read history, still allow checkin (but tell you why)
    // You may choose to block instead.
    console.log("Checkin: could not read thread history:", e.message);
  }

  // Public post (fastest ship)
  return reply(res, `✅ <@${userId}> checked in: \`${wallet}\``, false);
}

async function handleAwardParticipation(interaction, res) {
  const threadId = interaction.channel_id;
  const day = todayUTC();
  const marker = awardMarker(day);
  const amount = 1;

  try {
    const already = await hasAwardMarkerToday(threadId);
    if (already) {
      return reply(
        res,
        `⛔ Participation was already awarded for **${day}** in this thread.\n(One award per day only.)`,
        false
      );
    }

    // Build eligible list (first wallet per user)
    const msgs = await fetchThreadMessages(threadId, 800);
    const firstByUser = buildFirstWalletByUser(msgs);

    if (firstByUser.size === 0) {
      return reply(res, "No wallets found in this thread yet.", false);
    }

    const wallets = Array.from(firstByUser.values()); // wallets only

    // ✅ Run on-chain awards FIRST (no public “started” yet)
    const results = await awardOnePoint(wallets);

    const ok = results.filter((r) => r.ok);
    const bad = results.filter((r) => !r.ok);

    // If everything failed, don't lock and don't post “started”
    if (ok.length === 0) {
      const failPreview = bad
        .slice(0, 3)
        .map((r) => `• \`${r.wallet}\` → ${r.error}`)
        .join("\n");

      return reply(
        res,
        `❌ Award failed for **${day}** (0 successes). Not locked.\n` +
          (failPreview ? `\nFirst errors:\n${failPreview}` : ""),
        true
      );
    }

    // ✅ Only now: post “started” + LOCK marker (since we had successes)
    await discordPostMessage(
      threadId,
      `✅ Participation awarded for **${day}** — **${amount}** point per participant.\n${marker}`
    );

    const summary =
      `✅ Award complete for **${day}**\n` +
      `• Eligible wallets: **${wallets.length}**\n` +
      `• Success: **${ok.length}**\n` +
      `• Failed: **${bad.length}**`;

    const sampleTx = ok
      .slice(0, 5)
      .map((r) => `• \`${r.wallet}\` → ${r.url}`)
      .join("\n");

    const failList = bad
      .slice(0, 5)
      .map((r) => `• \`${r.wallet}\` → ${r.error}`)
      .join("\n");

    await discordPostMessage(
      threadId,
      summary +
        (sampleTx ? `\n\nSample tx:\n${sampleTx}` : "") +
        (failList ? `\n\nFirst failures:\n${failList}` : "")
    );

    return reply(
      res,
      `✅ Awarded **${ok.length}/${wallets.length}** participant(s). Locked for **${day}**.`,
      true
    );
  } catch (e) {
    // ✅ No public post on error
    return reply(res, `❌ Error: ${e.message}`, true);
  }
}

async function handleSlashCommand(interaction, res) {
  const name = interaction.data?.name;

  if (name === "startparticipation") return handleStartParticipation(interaction, res);
  if (name === "checkin") return handleCheckin(interaction, res);
  if (name === "award_participation") return handleAwardParticipation(interaction, res);

  return reply(res, `Unknown command: ${name}`, true);
}

module.exports = { handleSlashCommand };