// lib/discord/commands.js
const { PublicKey } = require("@solana/web3.js");
const { awardOnePoint } = require("../solana/award");
const { getDaoIdForGuild, setDaoIdForGuild } = require("./dao_store");

const DISCORD_API = "https://discord.com/api/v10";
const SOL_WALLET_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

// --- Active call / voice-gating ---
// If set, require users to be in THIS voice/stage channel to use /checkin and /award_participation.
// If not set, require users to be in ANY voice/stage channel.
const ACTIVE_VOICE_CHANNEL_ID = process.env.VINE_ACTIVE_VOICE_CHANNEL_ID || null;

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
  if (!daoId) return reply(res, "❌ Missing Reputation Space id. Example: `/setspace space:<SPACE_PUBLIC_KEY>`", true);
  if (!isValidSolanaPubkey(daoId)) return reply(res, "❌ Invalid Reputation Space public key.", true);

  try {
    await setDaoIdForGuild(guildId, daoId);
    return reply(res, `✅ DAO configured for this server: \`${daoId}\`\n(by <@${userId}>)`, true);
  } catch (e) {
    return reply(res, `❌ Failed to save Space: ${e.message}`, true);
  }
}

function safeGetInteractionVoiceChannelId(interaction) {
  // Some interaction payloads include voice state under member.voice
  return (
    interaction?.member?.voice?.channel_id ||
    interaction?.member?.voice?.channelId ||
    null
  );
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
    return reply(res, `❌ ${labelForUser} is only available inside the server thread while you are in the active call.`, true);
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

function isMissingAccessError(e) {
  const msg = String(e?.message || "");
  return msg.includes("403") || msg.toLowerCase().includes("missing access");
}

// For PRIVATE threads, bots must be a thread member to read history.
// Safe to call on public threads too.
async function ensureBotInThread(threadId) {
  try {
    await discordFetch(`/channels/${threadId}/thread-members/@me`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    return true;
  } catch (e) {
    return false;
  }
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

async function discordPostMessage(channelId, content, suppressEmbeds = false) {
  const body = { content };

  if (suppressEmbeds) {
    body.flags = 4; // SUPPRESS_EMBEDS
  }

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

// Fetch messages in this thread (newest -> older)
async function fetchThreadMessages(threadId, maxMessages = 300) {
  // ✅ ensure bot is a member (private threads)
  await ensureBotInThread(threadId);

  let before = null;
  let fetched = 0;
  const all = [];

  while (fetched < maxMessages) {
    const qs = new URLSearchParams({ limit: "100" });
    if (before) qs.set("before", before);

    let msgs;
    try {
      msgs = await discordFetch(`/channels/${threadId}/messages?${qs.toString()}`);
    } catch (e) {
      // Bubble up so callers can show a real message instead of silently continuing
      throw e;
    }

    if (!msgs || msgs.length === 0) break;

    for (const m of msgs) {
      all.push(m);
      fetched++;
      before = m.id;
      if (fetched >= maxMessages) break;
    }
    if (msgs.length < 100) break;
  }

  return all;
}

function msgIdBigInt(id) {
  try { return BigInt(id); } catch { return null; }
}

// Find the most recent /startparticipation marker message id for today
function findTodayStartMessageId(messages, day) {
  const marker = startMarker(day);

  // messages are newest -> oldest
  for (const m of messages) {
    if ((m.content || "").includes(marker)) {
      return m.id; // this is the newest start marker for today
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

async function hasAwardMarker(threadId) {
  const lock = awardLockMarker();
  const msgs = await fetchThreadMessages(threadId, 300);
  return msgs.some((m) => (m.content || "").includes(lock));
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

  if (!threadId) return reply(res, "❌ `/checkin` must be used inside the participation thread.", true);

  if (!wallet) return reply(res, "❌ Missing wallet. Example: `/checkin wallet:<address>`", true);
  if (!isValidSolanaPubkey(wallet)) return reply(res, "❌ Invalid Solana wallet address.", true);

  const gate = await requireActiveCall(interaction, res, "`/checkin`");
  if (gate) return gate;

  const startedGate = await requireStartedToday(interaction, res, "`/checkin`");
  if (startedGate) return startedGate;

  const alreadyAwarded = await hasAwardMarker(threadId); // make sure this is NOT day-based
  if (alreadyAwarded) {
    return reply(res, `⛔ Awards have already been issued in this thread. Check-in is closed.`, true);
  }

  try {
    const day = todayUTC();
    const msgs = await fetchThreadMessages(threadId, 300);

    const startMsgId = findTodayStartMessageId(msgs, day);
    if (!startMsgId) {
      return reply(
        res,
        `❌ No participation session has been started **today** in this thread.\n` +
          `Ask a moderator to run \`/startparticipation\` first.`,
        true
      );
    }

    const firstByUser = buildFirstWalletByUserSince(msgs, startMsgId);

    if (firstByUser.has(userId)) {
      const existing = firstByUser.get(userId);
      return reply(
        res,
        `⚠️ <@${userId}> you already checked in with: \`${existing}\`\nFirst wallet counts — no changes applied.`,
        false
      );
    }

    // ✅ only post success if we successfully checked history
    return reply(res, `✅ <@${userId}> checked in: \`${wallet}\``, false);

  } catch (e) {
    console.log("Checkin: could not read thread history:", e.message);

    if (isMissingAccessError(e)) {
      return reply(
        res,
        "❌ I can’t read this thread’s message history, so I can’t verify if you already checked in.\n\n" +
          "Fix (server admin): grant the bot **View Channel** + **Read Message History** + **Send Messages in Threads**.\n" +
          "If this is a **Private Thread**, the bot must be added to the thread (or have Manage Threads).",
        true
      );
    }

    return reply(res, `❌ Error reading thread history: ${e.message}`, true);
  }
}

function startMarker(day) {
  // one "start" per thread per day
  return `VINE_START_MARKER:${day}`;
}

async function hasStartMarkerToday(threadId) {
  const day = todayUTC();
  const marker = startMarker(day);

  const msgs = await fetchThreadMessages(threadId, 300);
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

  // ✅ Only allow /award_participation if the invoker is currently in the active call
  const gate = await requireActiveCall(interaction, res, "`/award_participation`");
  if (gate) return gate;

  // ✅ NEW: Only allow awarding if /startparticipation happened today in this thread
  const startedGate = await requireStartedToday(interaction, res, "`/award_participation`");
  if (startedGate) return startedGate;

  try {
    const already = await hasAwardMarker(threadId);
    if (already) {
      return reply(
        res,
        `⛔ Participation was already awarded in this thread.\n(One award per thread only.)`,
        false
      );
    }

    // Build eligible list (first wallet per user)
let msgs;
try {
  msgs = await fetchThreadMessages(threadId, 800);
} catch (e) {
  if (isMissingAccessError(e)) {
    return reply(
      res,
      "❌ I can’t read this thread’s message history, so I can’t determine who checked in.\n\n" +
        "Fix (server admin): grant the bot **View Channel** + **Read Message History** + **Send Messages in Threads**.\n" +
        "If this is a **Private Thread**, the bot must be added to the thread (or have Manage Threads).",
      true
    );
  }
  throw e;
}

    const startMsgId = findTodayStartMessageId(msgs, day);
    if (!startMsgId) {
      return reply(
        res,
        `❌ No participation session has been started **today** in this thread.\n` +
          `Ask a moderator to run \`/startparticipation\` first.`,
        true
      );
    }

    const firstByUser = buildFirstWalletByUserSince(msgs, startMsgId);

    if (firstByUser.size === 0) {
      return reply(res, "No wallets found in this thread yet.", false);
    }

    const wallets = Array.from(firstByUser.values()); // wallets only

    // ✅ Run on-chain awards FIRST (no public “started” yet)
    const daoId = (await getDaoIdForGuild(interaction.guild_id)) || process.env.VINE_DAO_ID;
    if (!daoId) return reply(res, "❌ This server is not configured with an OG Space yet. Ask an admin to run `/setspace`.", true);

    const results = await awardOnePoint(wallets, { daoId });

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

    const lockMarker = awardLockMarker();
    const dayMarker = awardDayMarker(day);

    // ✅ Only now: post “started” + LOCK marker (since we had successes)
    await discordPostMessage(
    threadId,
    `✅ Participation awarded for **${day}** — **${amount}** point per participant.\n` +
        `${lockMarker}\n${dayMarker}`,
    true
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
            (spaceUrl ? `\n\n📌 View the Space: ${spaceUrl}` : "") +
            (sampleTx ? `\n\nSuccess:\n${sampleTx}` : "") +
            (failList ? `\n\nFirst failures:\n${failList}` : ""),
            true // suppress embeds
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
  if (name === "setspace") return handleSetDao(interaction, res);
  if (name === "getspace") return handleGetSpace(interaction, res);

  return reply(res, `Unknown command: ${name}`, true);
}

module.exports = { handleSlashCommand };