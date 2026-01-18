// lib/discord/commands.js
const { PublicKey } = require("@solana/web3.js");
const { awardOnePoint } = require("../solana/award");
const { getDaoIdForGuild, setDaoIdForGuild } = require("./dao_store");
const { getPointsBalance } = require("../solana/points");

const DISCORD_API = "https://discord.com/api/v10";
const SOL_WALLET_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

// ✅ Hard cap to avoid rate limits: only ever read up to 100 thread messages (1 API call)
const THREAD_HISTORY_LIMIT = 100;

// --- Active call / voice-gating ---
// If set, require users to be in THIS voice/stage channel to use /checkin and /award_participation.
// If not set, require users to be in ANY voice/stage channel.
const ACTIVE_VOICE_CHANNEL_ID = process.env.VINE_ACTIVE_VOICE_CHANNEL_ID || null;

async function handlePoints(interaction, res) {
  const guildId = interaction.guild_id;
  const userId = interaction.member?.user?.id || interaction.user?.id;

  if (!guildId) return reply(res, "❌ `/points` must be used in a server.", true);

  const daoId = (await getDaoIdForGuild(guildId)) || process.env.VINE_DAO_ID;
  if (!daoId) {
    return reply(
      res,
      "❌ This server is not configured with a Vine Space yet. Ask an admin to run `/setspace`.",
      true
    );
  }

  const walletOpt = interaction.data?.options?.find((o) => o.name === "wallet")?.value;
  let wallet = walletOpt ? String(walletOpt).trim() : null;

  // If no wallet provided, best-effort: find last wallet from thread history
  if (!wallet) {
    const threadId = interaction.channel_id;
    if (threadId) {
      try {
        const msgs = await fetchThreadMessages(threadId, THREAD_HISTORY_LIMIT);
        wallet = findLastWalletForUser(msgs, userId);
      } catch {
        // ignore
      }
    }
  }

  if (!wallet) {
    return reply(
      res,
      "❌ I couldn’t find a wallet for you.\n" +
        "Use `/points wallet:<YOUR_SOLANA_WALLET>` or check in once with `/checkin wallet:<YOUR_SOLANA_WALLET>`.",
      true
    );
  }

  if (!isValidSolanaPubkey(wallet)) {
    return reply(res, "❌ Invalid Solana wallet address.", true);
  }

  try {
    const { points, season, hasAccount } = await getPointsBalance(wallet, { daoId });

    const spaceUrl = `https://vine.governance.so/dao/${daoId}`;

    return reply(
      res,
      `🌱 **Vine Points Balance**\n` +
        `• Wallet: \`${wallet}\`\n` +
        `• Season: **${season}**\n` +
        `• Points: **${points.toString()}**\n` +
        (hasAccount ? "" : `• Status: _No reputation account yet (0 points)_\n`) +
        `\n📌 Space: ${spaceUrl}`,
      true
    );
  } catch (e) {
    return reply(res, `❌ Failed to fetch points: ${e.message}`, true);
  }
}

async function handleGetSpace(interaction, res) {
  const guildId = interaction.guild_id;

  if (!guildId) return reply(res, "❌ `/getspace` must be used in a server.", true);

  const daoId = (await getDaoIdForGuild(guildId)) || process.env.VINE_DAO_ID;

  if (!daoId) {
    return reply(
      res,
      "ℹ️ No Vine Space is configured for this server yet.\n" +
        "Ask an admin/mod to run `/setspace space:<SPACE_PUBLIC_KEY>`.",
      true
    );
  }

  const url = `https://vine.governance.so/dao/${daoId}`;
  return reply(
    res,
    `✅ Current Vine Space for this server:\n` +
      `• DAO: \`${daoId}\`\n` +
      `• Link: ${url}`,
    true
  );
}

async function handleSetDao(interaction, res) {
  const guildId = interaction.guild_id;
  const userId = interaction.member?.user?.id || interaction.user?.id;
  const daoId = interaction.data?.options?.find((o) => o.name === "space")?.value;

  if (!guildId) return reply(res, "❌ `/setspace` must be used in a server.", true);
  if (!daoId) {
    return reply(
      res,
      "❌ Missing Reputation Space id. Example: `/setspace space:<SPACE_PUBLIC_KEY>`",
      true
    );
  }
  if (!isValidSolanaPubkey(daoId)) return reply(res, "❌ Invalid Reputation Space public key.", true);

  try {
    // If this guild already has this exact space, no-op
    const current = (await getDaoIdForGuild(guildId)) || null;
    if (current && String(current) === String(daoId).trim()) {
      return reply(
        res,
        `ℹ️ This server is already configured with that Space:\n• DAO: \`${current}\`\nNo changes were made.`,
        true
      );
    }

    await setDaoIdForGuild(guildId, daoId);

    return reply(
      res,
      `✅ DAO configured for this server: \`${String(daoId).trim()}\`\n(by <@${userId}>)`,
      true
    );
  } catch (e) {
    // Friendly error for "already assigned"
    if (String(e.message || "").toLowerCase().includes("already assigned")) {
      return reply(
        res,
        `⛔ That Space is already configured in another server.\n` +
          `If you believe this is a mistake, unassign it there first (or ask an admin).`,
        true
      );
    }
    return reply(res, `❌ Failed to save Space: ${e.message}`, true);
  }
}

// --- Check-in override marker (user can correct wallet BEFORE award is issued) ---
function checkinOverrideMarker(day, userId, wallet) {
  return `VINE_CHECKIN_OVERRIDE:${day}:${userId}:${wallet}`;
}

function parseCheckinOverride(content) {
  // Exact line match: VINE_CHECKIN_OVERRIDE:YYYY-MM-DD:<userId>:<wallet>
  const m = String(content || "").match(
    /^VINE_CHECKIN_OVERRIDE:(\d{4}-\d{2}-\d{2}):(\d+):([1-9A-HJ-NP-Za-km-z]{32,44})$/m
  );
  if (!m) return null;
  return { day: m[1], userId: m[2], wallet: m[3] };
}

// (Optional but recommended) ensure overrides only come from THIS bot.
// Set env DISCORD_BOT_USER_ID once.
function isFromThisBot(msg) {
  const botId = process.env.DISCORD_BOT_USER_ID;
  if (!botId) return true; // if not set, don't block (but less secure)
  return String(msg?.author?.id) === String(botId);
}

function safeGetInteractionVoiceChannelId(interaction) {
  // Some interaction payloads include voice state under member.voice
  return (
    interaction?.member?.voice?.channel_id ||
    interaction?.member?.voice?.channelId ||
    null
  );
}

// Find the most recent wallet this user has checked in with (best-effort within fetched history)
function findLastWalletForUser(messages, userId) {
  // messages are newest -> oldest
  for (const m of messages) {
    if (!isCheckinMessage(m)) continue;

    const uid = extractMentionedUserId(m.content);
    if (!uid || String(uid) !== String(userId)) continue;

    const wallet = extractCheckinWallet(m.content);
    if (wallet && isValidSolanaPubkey(wallet)) return wallet;
  }
  return null;
}

async function fetchUserVoiceChannelId(guildId, userId) {
  // Best-effort REST checks. Not all bots have access to voice state via REST depending on setup.
  // We try a couple of endpoints and gracefully fall back.

  // 1) Try per-user voice state (if supported)
  try {
    const vs = await discordFetch(`/guilds/${guildId}/voice-states/${userId}`);
    if (vs && (vs.channel_id || vs.channelId)) return vs.channel_id || vs.channelId;
  } catch (e) {
    // ignore
  }

  // 2) Try list voice states (if supported)
  try {
    const list = await discordFetch(`/guilds/${guildId}/voice-states`);
    if (Array.isArray(list)) {
      const hit = list.find((v) => String(v?.user_id) === String(userId));
      if (hit && (hit.channel_id || hit.channelId)) return hit.channel_id || hit.channelId;
    }
  } catch (e) {
    // ignore
  }

  return null;
}

async function requireActiveCall(interaction, res, labelForUser) {
  const guildId = interaction.guild_id;
  const userId = interaction.member?.user?.id || interaction.user?.id;

  if (!guildId || !userId) {
    // DM / missing context; block because we can't determine voice state
    return reply(
      res,
      `❌ ${labelForUser} is only available inside the server thread while you are in the active call.`,
      true
    );
  }

  // Prefer interaction payload (fast)
  let channelId = safeGetInteractionVoiceChannelId(interaction);

  // Fallback to REST (best effort)
  if (!channelId) {
    channelId = await fetchUserVoiceChannelId(guildId, userId);
  }

  if (!channelId) {
    return reply(
      res,
      `❌ You must be in the active voice/stage call to use ${labelForUser}.` +
        (ACTIVE_VOICE_CHANNEL_ID ? `\n(Required channel: \`${ACTIVE_VOICE_CHANNEL_ID}\`)` : ""),
      true
    );
  }

  if (ACTIVE_VOICE_CHANNEL_ID && String(channelId) !== String(ACTIVE_VOICE_CHANNEL_ID)) {
    return reply(
      res,
      `❌ You must be in the active voice/stage call to use ${labelForUser}.\n` +
        `Join the required channel: \`${ACTIVE_VOICE_CHANNEL_ID}\``,
      true
    );
  }

  return null; // OK
}

function takeLinesUpTo(lines, maxChars) {
  const out = [];
  let len = 0;

  for (const line of lines) {
    const add = (out.length ? 1 : 0) + line.length; // +1 for newline
    if (len + add > maxChars) break;
    out.push(line);
    len += add;
  }
  return out;
}

function formatSampleBlock(label, lines, totalCount, maxChars) {
  if (!lines || lines.length === 0) return "";

  const picked = takeLinesUpTo(lines, maxChars);
  const shown = picked.length;
  const remaining = Math.max(0, totalCount - shown);

  return (
    `\n\n${label} (sample):\n` +
    picked.join("\n") +
    (remaining > 0 ? `\n…and **${remaining}** more.` : "")
  );
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function extractMentionedUserId(text) {
  // Matches <@123> and <@!123>
  if (!text) return null;
  const m = text.match(/<@!?(\d+)>/);
  return m ? m[1] : null;
}

function extractCheckinWallet(text) {
  // Prefer the wallet inside backticks from your checkin message: `...`
  if (!text) return null;
  const m = text.match(/checked in:\s*`([^`]+)`/i);
  const w = m ? m[1].trim() : null;
  if (w && isValidSolanaPubkey(w)) return w;

  // Fallback: any wallet-looking string in the content
  const w2 = extractWalletsFromText(text)[0];
  return w2 && isValidSolanaPubkey(w2) ? w2 : null;
}

function isCheckinMessage(msg) {
  // Only treat your bot's checkin posts as checkins
  const c = msg?.content || "";
  return c.includes("checked in:");
}

async function vineSpaceUrlForInteraction(interaction) {
  const guildId = interaction?.guild_id;
  const daoId = (await getDaoIdForGuild(guildId)) || process.env.VINE_DAO_ID;
  return daoId ? `https://vine.governance.so/dao/${daoId}` : null;
}

function defer(res, ephemeral = true) {
  const payload = { type: 5, data: {} };
  if (ephemeral) payload.data.flags = 64;
  return res.status(200).json(payload);
}

function startMarker(day) {
  // one "start" per thread per day
  return `VINE_START_MARKER:${day}`;
}

// one-time lock per thread (no date)
function awardLockMarker() {
  return `VINE_AWARD_LOCK`;
}

// optional: keep daily marker too (nice for history/debug)
function awardDayMarker(day) {
  return `VINE_AWARD_MARKER:${day}`;
}

function reply(res, content, ephemeral = true) {
  const payload = { type: 4, data: { content } };
  if (ephemeral) payload.data.flags = 64; // EPHEMERAL
  return res.status(200).json(payload);
}

function interactionAppId(interaction) {
  return interaction.application_id || process.env.DISCORD_APP_ID;
}

async function discordEditOriginal(interaction, content) {
  const appId = interactionAppId(interaction);
  const token = interaction.token;
  if (!appId) throw new Error("Missing DISCORD_APP_ID");
  if (!token) throw new Error("Missing interaction.token");

  const url = `${DISCORD_API}/webhooks/${appId}/${token}/messages/@original`;

  const r = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`edit original failed ${r.status}: ${text}`);
  }
}

function isValidSolanaPubkey(s) {
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

// ✅ 429-aware fetch with a few retries + jitter buffer
async function discordFetch(path, opts = {}, attempt = 0) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("Missing DISCORD_BOT_TOKEN");

  const res = await fetch(`${DISCORD_API}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bot ${token}`,
      ...(opts.headers || {}),
    },
  });

  // ✅ Handle rate limits gracefully
  if (res.status === 429) {
    const body = await res.json().catch(() => null);
    const retryAfterSec =
      (body && (body.retry_after || body.retryAfter)) ||
      parseFloat(res.headers.get("retry-after") || "1") ||
      1;

    if (attempt >= 3) {
      throw new Error(`Discord API 429: rate limited (gave up after retries)`);
    }

    const waitMs = Math.ceil(retryAfterSec * 1000) + 150; // small buffer
    await new Promise((r) => setTimeout(r, waitMs));
    return discordFetch(path, opts, attempt + 1);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discord API ${res.status}: ${text}`);
  }

  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function discordPostMessage(channelId, content, suppressEmbeds = false) {
  const body = { content };
  if (suppressEmbeds) body.flags = 4; // SUPPRESS_EMBEDS

  return discordFetch(`/channels/${channelId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function extractWalletsFromText(text) {
  if (!text) return [];
  return text.match(SOL_WALLET_RE) || [];
}

// ✅ Fetch messages in this thread (HARD-CAPPED at 100 by default)
async function fetchThreadMessages(threadId, maxMessages = THREAD_HISTORY_LIMIT) {
  const limit = Math.min(100, Math.max(1, maxMessages || THREAD_HISTORY_LIMIT));
  return (await discordFetch(`/channels/${threadId}/messages?limit=${limit}`)) || [];
}

function msgIdBigInt(id) {
  try {
    return BigInt(id);
  } catch {
    return null;
  }
}

// Find the most recent /startparticipation marker message id for today
function findTodayStartMessageId(messages, day) {
  const marker = startMarker(day);

  // messages are newest -> oldest
  for (const m of messages) {
    if ((m.content || "").includes(marker)) {
      return m.id; // newest start marker for today
    }
  }
  return null;
}

// Build first wallet per user, but ONLY from checkins posted AFTER startMessageId
function buildFirstWalletByUserSince(messages, startMessageId) {
  const startId = msgIdBigInt(startMessageId);
  if (!startId) return new Map();

  const oldestFirst = [...messages].reverse();
  const firstByUser = new Map();

  for (const m of oldestFirst) {
    const mid = msgIdBigInt(m.id);
    if (!mid || mid <= startId) continue; // ignore anything before/at start

    if (!isCheckinMessage(m)) continue;

    const uid = extractMentionedUserId(m.content);
    if (!uid) continue;
    if (firstByUser.has(uid)) continue;

    const wallet = extractCheckinWallet(m.content);
    if (wallet) firstByUser.set(uid, wallet);
  }

  return firstByUser;
}

function buildFinalWalletByUserSince(messages, startMessageId, day) {
  // Start with "first wallet counts"
  const firstByUser = buildFirstWalletByUserSince(messages, startMessageId);

  const startId = msgIdBigInt(startMessageId);
  if (!startId) return firstByUser;

  // Apply overrides AFTER start marker; latest override wins
  const oldestFirst = [...messages].reverse();

  for (const m of oldestFirst) {
    const mid = msgIdBigInt(m.id);
    if (!mid || mid <= startId) continue;

    // Only accept overrides the bot posted (recommended)
    if (!isFromThisBot(m)) continue;

    const ov = parseCheckinOverride(m.content);
    if (!ov) continue;
    if (ov.day !== day) continue;
    if (!isValidSolanaPubkey(ov.wallet)) continue;

    firstByUser.set(ov.userId, ov.wallet);
  }

  return firstByUser;
}

/*
async function hasAwardMarker(threadId) {
  const lock = awardLockMarker();
  const msgs = await fetchThreadMessages(threadId, THREAD_HISTORY_LIMIT);
  return msgs.some((m) => (m.content || "").includes(lock));
}*/
// Replace old thread-wide checker with day-based checker
async function hasAwardMarkerForDay(threadId, day) {
  const marker = awardDayMarker(day);
  const msgs = await fetchThreadMessages(threadId, THREAD_HISTORY_LIMIT);
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
  const oldestFirst = [...messages].reverse();
  const firstByUser = new Map(); // discordUserId -> wallet

  for (const m of oldestFirst) {
    if (!isCheckinMessage(m)) continue;

    // ✅ user id comes from the mention in the bot message, not msg.author.id
    const uid = extractMentionedUserId(m.content);
    if (!uid) continue;
    if (firstByUser.has(uid)) continue;

    const wallet = extractCheckinWallet(m.content);
    if (wallet) firstByUser.set(uid, wallet);
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

  const day = todayUTC();
  const marker = startMarker(day);

  const msg =
    `**NEW DATE: ${dateLabel}**\n` +
    `Use \`/checkin wallet:<YOUR_SOLANA_WALLET>\` to check in for participation points.` +
    (note ? `\n\n${note}` : "") +
    `\n\n${marker}`; // ✅ lock-in marker for today

  return reply(res, msg, false);
}

async function handleCheckin(interaction, res) {
  const threadId = interaction.channel_id;
  const userId = interaction.member?.user?.id || interaction.user?.id;
  const wallet = interaction.data?.options?.find((o) => o.name === "wallet")?.value;
    const fixRaw = interaction.data?.options?.find((o) => o.name === "fix")?.value;
    const fix =
    fixRaw === true ||
    fixRaw === "true" ||
    fixRaw === 1 ||
    fixRaw === "1";

  if (!threadId) return reply(res, "❌ `/checkin` must be used inside the participation thread.", true);

  if (!wallet) return reply(res, "❌ Missing wallet. Example: `/checkin wallet:<address>`", true);
  if (!isValidSolanaPubkey(wallet)) return reply(res, "❌ Invalid Solana wallet address.", true);

  const gate = await requireActiveCall(interaction, res, "`/checkin`");
  if (gate) return gate;

  const startedGate = await requireStartedToday(interaction, res, "`/checkin`");
  if (startedGate) return startedGate;

  const day = todayUTC();

  // Close check-in if today's awards already issued
  const alreadyAwardedToday = await hasAwardMarkerForDay(threadId, day);
  if (alreadyAwardedToday) {
    return reply(res, `⛔ Awards have already been issued **today** in this thread. Check-in is closed.`, true);
  }

  try {
    const msgs = await fetchThreadMessages(threadId, THREAD_HISTORY_LIMIT);

    const startMsgId = findTodayStartMessageId(msgs, day);
    if (!startMsgId) {
      return reply(
        res,
        `❌ No participation session has been started **today** in this thread.\n` +
          `Ask a moderator to run \`/startparticipation\` first.`,
        true
      );
    }

    const finalByUser = buildFinalWalletByUserSince(msgs, startMsgId, day);

    // First-time checkin (no existing wallet)
    if (!finalByUser.has(userId)) {
      return reply(res, `✅ <@${userId}> checked in: \`${wallet}\``, false);
    }

    // Already checked in, no fix flag
    if (!fix) {
      const existing = finalByUser.get(userId);
      return reply(
        res,
        `⚠️ <@${userId}> you already checked in with: \`${existing}\`\n` +
          `If that’s wrong, run \`/checkin wallet:<correct_wallet> fix:true\` (before awards).`,
        true
      );
    }

    // Fix: record override marker so award uses corrected wallet
    await discordPostMessage(threadId, checkinOverrideMarker(day, userId, wallet), true);
    return reply(res, `✅ <@${userId}> updated check-in wallet for **${day}**: \`${wallet}\``, false);
  } catch (e) {
    console.log("Checkin: could not read thread history:", e.message);
    // Fall back to posting the check-in (best effort)
    return reply(res, `✅ <@${userId}> checked in: \`${wallet}\``, false);
  }
}

async function handleCheckinWithLastWallet(interaction, res) {
  const threadId = interaction.channel_id;
  const userId = interaction.member?.user?.id || interaction.user?.id;

  if (!threadId) {
    return reply(res, "❌ `/checkinwithlastwallet` must be used inside the participation thread.", true);
  }

  const gate = await requireActiveCall(interaction, res, "`/checkinwithlastwallet`");
  if (gate) return gate;

  const startedGate = await requireStartedToday(interaction, res, "`/checkinwithlastwallet`");
  if (startedGate) return startedGate;

  const day = todayUTC();

  // Close check-in if today's awards already issued
  const alreadyAwardedToday = await hasAwardMarkerForDay(threadId, day);
  if (alreadyAwardedToday) {
    return reply(res, `⛔ Awards have already been issued **today** in this thread. Check-in is closed.`, true);
  }

  try {
    const msgs = await fetchThreadMessages(threadId, THREAD_HISTORY_LIMIT);

    const startMsgId = findTodayStartMessageId(msgs, day);
    if (!startMsgId) {
      return reply(
        res,
        `❌ No participation session has been started **today** in this thread.\n` +
          `Ask a moderator to run \`/startparticipation\` first.`,
        true
      );
    }

    // If already checked in today, show what we have on record (respect overrides)
    const finalByUser = buildFinalWalletByUserSince(msgs, startMsgId, day);
    if (finalByUser.has(userId)) {
      const existing = finalByUser.get(userId);
      return reply(
        res,
        `⚠️ <@${userId}> you already checked in with: \`${existing}\`\n` +
          `If that’s wrong, run \`/checkin wallet:<correct_wallet> fix:true\` (before awards).`,
        true
      );
    }

    // Otherwise, use last wallet the user checked in with (from recent history)
    const lastWallet = findLastWalletForUser(msgs, userId);
    if (!lastWallet) {
      return reply(
        res,
        `❌ I couldn’t find a previous check-in wallet for you in this thread history.\n` +
          `Please run \`/checkin wallet:<YOUR_SOLANA_WALLET>\` once, then you can use \`/checkinwithlastwallet\` next time.`,
        true
      );
    }

    return reply(res, `✅ <@${userId}> checked in: \`${lastWallet}\``, false);
  } catch (e) {
    console.log("checkinwithlastwallet: could not read thread history:", e.message);
    return reply(
      res,
      `❌ I couldn’t read thread history to find your last wallet.\n` +
        `Please use \`/checkin wallet:<YOUR_SOLANA_WALLET>\` instead.`,
      true
    );
  }
}

async function hasStartMarkerToday(threadId) {
  const day = todayUTC();
  const marker = startMarker(day);

  const msgs = await fetchThreadMessages(threadId, THREAD_HISTORY_LIMIT);
  return msgs.some((m) => (m.content || "").includes(marker));
}

async function requireStartedToday(interaction, res, labelForUser) {
  const threadId = interaction.channel_id;
  if (!threadId) {
    return reply(res, `❌ ${labelForUser} must be used inside the participation thread.`, true);
  }

  const started = await hasStartMarkerToday(threadId);
  if (!started) {
    return reply(
      res,
      `❌ No participation session has been started **today** in this thread.\n` +
        `Ask a moderator to run \`/startparticipation\` first.`,
      true
    );
  }

  return null; // OK
}

async function handleAwardParticipation(interaction, res) {
  const spaceUrl = await vineSpaceUrlForInteraction(interaction);
  const threadId = interaction.channel_id;
  const day = todayUTC();
  const amount = 1;

  const gate = await requireActiveCall(interaction, res, "`/award_participation`");
  if (gate) return gate;

  const startedGate = await requireStartedToday(interaction, res, "`/award_participation`");
  if (startedGate) return startedGate;

  try {
    const alreadyToday = await hasAwardMarkerForDay(threadId, day);
    if (alreadyToday) {
    return reply(
        res,
        `⛔ Participation was already awarded for **${day}** in this thread.\n(One award per day.)`,
        false
    );
    }

    // ✅ Build eligible list (first wallet per user) from last 100 messages only
    const msgs = await fetchThreadMessages(threadId, THREAD_HISTORY_LIMIT);

    const startMsgId = findTodayStartMessageId(msgs, day);
    if (!startMsgId) {
      return reply(
        res,
        `❌ No participation session has been started **today** in this thread.\n` +
          `Ask a moderator to run \`/startparticipation\` first.`,
        true
      );
    }

    /*
    const firstByUser = buildFirstWalletByUserSince(msgs, startMsgId);

    if (firstByUser.size === 0) {
      return reply(res, "No wallets found in this thread yet.", false);
    }
      
    const wallets = Array.from(firstByUser.values()); // wallets only
    */
   const finalByUser = buildFinalWalletByUserSince(msgs, startMsgId, day);

    if (finalByUser.size === 0) {
        return reply(res, "No wallets found in this thread yet.", false);
    }

    const wallets = Array.from(finalByUser.values());


    const daoId = (await getDaoIdForGuild(interaction.guild_id)) || process.env.VINE_DAO_ID;
    if (!daoId)
      return reply(res, "❌ This server is not configured with an OG Space yet. Ask an admin to run `/setspace`.", true);

    const results = await awardOnePoint(wallets, { daoId });

    const ok = results.filter((r) => r.ok);
    const bad = results.filter((r) => !r.ok);

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
    
    const dayMarker = awardDayMarker(day);

    // 1) Lock/marker message (keep it short)
    await discordPostMessage(
      threadId,
      `✅ Participation awarded for **${day}** — **${amount}** point per participant.\n` +
        `• Participants: **${wallets.length}**\n` +
        `${dayMarker}`,
      true
    );

    // 2) Detailed summary message (this is what you’re currently missing)
    const successLinesAll = ok.map((r) => `• \`${r.wallet}\` → ${r.url}`);
    const failureLinesAll = bad.map((r) => `• \`${r.wallet}\` → ${r.error}`);

    const MAX_SUCCESS_CHARS = 1400;
    const MAX_FAIL_CHARS = 700;

    const successBlock = formatSampleBlock("Success", successLinesAll, successLinesAll.length, MAX_SUCCESS_CHARS);
    const failBlock = formatSampleBlock("Failures", failureLinesAll, failureLinesAll.length, MAX_FAIL_CHARS);

    const summary =
      `✅ Award complete for **${day}**\n` +
      `• Eligible wallets: **${wallets.length}**\n` +
      `• Success: **${ok.length}**\n` +
      `• Failed: **${bad.length}**`;

    await discordPostMessage(
      threadId,
      summary +
        (spaceUrl ? `\n\n📌 View the Space: ${spaceUrl}` : "") +
        successBlock +
        failBlock,
      true
    );

    return reply(
      res,
      `✅ Awarded **${ok.length}/${wallets.length}** participant(s). Locked for **${day}**.`,
      true
    );

    return reply(res, `✅ Awarded **${ok.length}/${wallets.length}** participant(s). Locked for **${day}**.`, true);
  } catch (e) {
    return reply(res, `❌ Error: ${e.message}`, true);
  }
}

async function handleSlashCommand(interaction, res) {
  const name = interaction.data?.name;

  if (name === "startparticipation") return handleStartParticipation(interaction, res);
  if (name === "checkin") return handleCheckin(interaction, res);
  if (name === "checkinwithlastwallet") return handleCheckinWithLastWallet(interaction, res);
  if (name === "award_participation") return handleAwardParticipation(interaction, res);
  if (name === "setspace") return handleSetDao(interaction, res);
  if (name === "getspace") return handleGetSpace(interaction, res);
  

  return reply(res, `Unknown command: ${name}`, true);
}

module.exports = { handleSlashCommand };