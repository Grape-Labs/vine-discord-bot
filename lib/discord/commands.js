// lib/discord/commands.js
const { PublicKey } = require("@solana/web3.js");
const { awardOnePoint, getFeePayerStatus } = require("../solana/award");
const {
  getDaoIdForGuild,
  getDaoIdForThread,
  getEffectiveDaoIdForContext,
  setDaoIdForGuild,
  setDaoIdForThread,
  clearDaoIdForThread,
} = require("./dao_store");
const { getPointsBalance } = require("../solana/points"); 
const { getLeaderboard } = require("../solana/leaderboard");
const {
  getSignerMetaForGuild,
  clearSignerForGuild,
} = require("./signer_store");

const DISCORD_API = "https://discord.com/api/v10";
const SOL_WALLET_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const DISCORD_HTTP_TIMEOUT_MS = 20000;
const VOICE_STATE_TIMEOUT_MS = Math.max(
  500,
  Math.min(2500, Math.floor(Number(process.env.DISCORD_VOICE_STATE_TIMEOUT_MS || 1200)))
);
const DISCORD_TIMEOUT_RETRIES = Math.max(
  0,
  Math.floor(Number(process.env.DISCORD_TIMEOUT_RETRIES || 1))
);

function authorityPanelUrl(guildId) {
  const base = process.env.VINE_WEB_BASE_URL;
  if (!base) return null;

  const url = new URL("/authority", base);
  if (guildId) url.searchParams.set("guildId", String(guildId));
  return url.toString();
}

// Default thread history window for most commands (1 API call).
const THREAD_HISTORY_LIMIT = 100;
// Expanded window for /checkinwithlastwallet only (up to 2 API calls).
const CHECKIN_LAST_WALLET_HISTORY_LIMIT = 200;
// Expanded window for /award_participation worker on busy threads (up to 5 API calls).
const AWARD_HISTORY_LIMIT = Math.max(
  100,
  Math.min(500, Number(process.env.AWARD_HISTORY_LIMIT || 300) || 300)
);

// --- Active call / voice-gating ---
// If set, require users to be in THIS voice/stage channel to use /checkin and /award_participation.
// If not set, require users to be in ANY voice/stage channel.
const ACTIVE_VOICE_CHANNEL_ID = process.env.VINE_ACTIVE_VOICE_CHANNEL_ID || null;
const PERM_ADMINISTRATOR = 1n << 3n;
const PERM_MANAGE_GUILD = 1n << 5n;

// ✅ lib/discord/commands.js — paste these additions

// 1) Add a helper for formatting help text
function helpText({ spaceUrl, daoId, threadId, voiceGateOn, voiceGateChannelId }) {
  const lines = [];
  lines.push(`🌱 **OG Reputation Bot — Help**`);
  lines.push(``);

  // Space / config
  if (daoId) {
    lines.push(`• Space: ${spaceUrl || `https://vine.governance.so/dao/${daoId}`}`);
    lines.push(`• DAO: \`${daoId}\``);
  } else {
    lines.push(`• Space: _not configured_ (admin: \`/setspace space:<SPACE_PUBLIC_KEY>\`)`);
  }

  // Voice gating
  if (voiceGateOn) {
    lines.push(
      `• Voice gate: **ON**` +
        (voiceGateChannelId ? ` (required channel: \`${voiceGateChannelId}\`)` : ` (must be in a voice/stage channel)`)
    );
  } else {
    lines.push(`• Voice gate: **OFF**`);
  }

  lines.push(``);
  lines.push(`**Quick start (participation thread)**`);
  lines.push(`1) Mod runs: \`/startparticipation\``);
  lines.push(`2) Members check in: \`/checkin wallet:<YOUR_SOLANA_WALLET>\``);
  lines.push(`   • Fix wallet (before awards): \`/checkin wallet:<CORRECT_WALLET> fix:true\``);
  lines.push(`   • Or: \`/checkinwithlastwallet\``);
  lines.push(`3) Mod awards: \`/award_participation\``);
  lines.push(``);

  lines.push(`**Useful commands**`);
  lines.push(`• \`/whoami\` — show your wallet on record (today + last seen)`);
  lines.push(`• \`/participants\` — list eligible participants for today (thread-only)`);
  lines.push(`• \`/points\` — show your OG Reputation Spaces points balance`);
  lines.push(`• \`/leaderboard\` — top wallets by points`);
  lines.push(`• \`/getspace\` — show default + current channel Space`);
  lines.push(`• \`/setspace\` — set default Space for this server`);
  lines.push(`• \`/setthreadspace\` — set Space override for this channel/thread (admin)`);
  lines.push(`• \`/clearthreadspace\` — clear this channel/thread override (admin)`);
  lines.push(`• \`/setauthority\` — open secure authority setup panel (admin)`);
  lines.push(`• \`/getauthority\` — show authority signer pubkeys (admin)`);
  lines.push(`• \`/feepayer\` — show fee payer wallet + SOL balance (admin)`);
  lines.push(``);

  lines.push(`**Notes**`);
  lines.push(`• Participation is **one award per day per thread** (UTC).`);
  lines.push(`• Commands that interact with participation may require you to be in the active call.`);

  return lines.join("\n");
}

// 2) Add a handler
async function handleHelp(interaction, res) {
  const daoId = await resolveDaoIdForContext({
    guildId: interaction.guild_id,
    threadId: interaction.channel_id,
  });

  const spaceUrl = daoId ? `https://vine.governance.so/dao/${daoId}` : null;

  const voiceGateOn = true; // your gating logic exists; we always enforce requireActiveCall on key commands
  const voiceGateChannelId = ACTIVE_VOICE_CHANNEL_ID || null;

  return reply(
    res,
    helpText({
      spaceUrl,
      daoId,
      threadId: interaction.channel_id || null,
      voiceGateOn,
      voiceGateChannelId,
    }),
    true
  );
}


function awardInProgressMarker(day, nonce) {
  return (
    `⏳ Award run in progress for **${day}**.\n` +
    `VINE_AWARD_IN_PROGRESS:${day}:${nonce}`
  );
}

function awardInProgressDoneMarker(day, nonce) {
  return `VINE_AWARD_IN_PROGRESS_DONE:${day}:${nonce}`;
}

function parseAwardInProgress(content) {
  const m = String(content || "").match(/^VINE_AWARD_IN_PROGRESS:(\d{4}-\d{2}-\d{2}):(.+)$/m);
  if (!m) return null;
  return { day: m[1], nonce: m[2] };
}

function parseAwardInProgressDone(content) {
  const m = String(content || "").match(/^VINE_AWARD_IN_PROGRESS_DONE:(\d{4}-\d{2}-\d{2}):(.+)$/m);
  if (!m) return null;
  return { day: m[1], nonce: m[2] };
}

function lockTimestampMsFromNonce(nonce) {
  const m = String(nonce || "").match(/^(\d+)-/);
  if (!m) return null;
  const ms = Number(m[1]);
  return Number.isFinite(ms) ? ms : null;
}

function isLockStale(nonce) {
  const maxAgeMs = Math.max(
    60 * 1000,
    Math.floor(Number(process.env.VINE_AWARD_LOCK_MAX_AGE_MS || 20 * 60 * 1000))
  );
  const ts = lockTimestampMsFromNonce(nonce);
  if (!ts) return false;
  return Date.now() - ts > maxAgeMs;
}

async function hasAwardInProgressForDay(threadId, day) {
  const msgs = await fetchThreadMessages(threadId, THREAD_HISTORY_LIMIT);
  const doneNonces = new Set(
    msgs
      .map((m) => parseAwardInProgressDone(m.content))
      .filter((x) => x && x.day === day)
      .map((x) => x.nonce)
  );

  // messages are newest -> oldest, so first active lock is the one we should honor
  for (const m of msgs) {
    const active = parseAwardInProgress(m.content);
    if (!active || active.day !== day) continue;

    if (doneNonces.has(active.nonce)) continue;
    if (isLockStale(active.nonce)) continue;
    return true;
  }

  return false;
}

async function releaseAwardLock(threadId, day, nonce) {
  if (!threadId || !day || !nonce) return;
  await discordPostMessage(threadId, awardInProgressDoneMarker(day, nonce), true);
}

/**
 * Acquire a best-effort distributed lock using a Discord marker message.
 * Returns { ok: true, nonce } if we own the lock, else { ok: false, reason }
 */
async function acquireAwardLock(threadId, day) {
  const nonce =
    `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  // 0) Fast-path: if already awarded, stop
  if (await hasAwardMarkerForDay(threadId, day)) {
    return { ok: false, reason: "already_awarded" };
  }

  // 1) If another lock exists, stop
  if (await hasAwardInProgressForDay(threadId, day)) {
    return { ok: false, reason: "in_progress" };
  }

  // 2) Post our lock marker
  await discordPostMessage(threadId, awardInProgressMarker(day, nonce), true);

  // 3) Re-fetch and confirm the newest in-progress marker belongs to us
  const msgs = await fetchThreadMessages(threadId, THREAD_HISTORY_LIMIT);

  // Messages are newest -> oldest, so first hit is newest lock
  for (const m of msgs) {
    const p = parseAwardInProgress(m.content);
    if (!p) continue;
    if (p.day !== day) continue;

    // newest lock for the day is whoever "won"
    if (p.nonce === nonce) return { ok: true, nonce };
    return { ok: false, reason: "race_lost" };
  }

  // If we don't even see it, treat as failure
  return { ok: false, reason: "lock_not_found" };
}

function getOption(interaction, name) {
  return interaction.data?.options?.find((o) => o.name === name)?.value;
}

function hasGuildConfigPermission(interaction) {
  const raw = interaction?.member?.permissions;
  if (raw == null) return false;

  let bits = 0n;
  try {
    bits = BigInt(raw);
  } catch {
    return false;
  }

  return (
    (bits & PERM_ADMINISTRATOR) === PERM_ADMINISTRATOR ||
    (bits & PERM_MANAGE_GUILD) === PERM_MANAGE_GUILD
  );
}

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(x)));
}

function chunkLines(lines, maxChars = 1800) {
  const out = [];
  let buf = [];
  let len = 0;

  for (const line of lines) {
    const add = (buf.length ? 1 : 0) + line.length;
    if (len + add > maxChars) {
      if (buf.length) out.push(buf.join("\n"));
      buf = [line];
      len = line.length;
    } else {
      buf.push(line);
      len += add;
    }
  }
  if (buf.length) out.push(buf.join("\n"));
  return out;
}

async function handleWhoAmI(interaction, res) {
  const guildId = interaction.guild_id;
  const userId = interaction.member?.user?.id || interaction.user?.id;

  if (!guildId) return reply(res, "❌ `/whoami` must be used in a server.", true);

  const daoId = await resolveDaoIdForContext({
    guildId,
    threadId: interaction.channel_id,
  });
  if (!daoId) {
    return reply(
      res,
      "❌ No OG Reputation Space is configured for this server/channel yet. Ask an admin to run `/setspace` or `/setthreadspace`.",
      true
    );
  }

  const threadId = interaction.channel_id;
  if (!threadId) return reply(res, "❌ `/whoami` must be used inside the participation thread.", true);

  const day = todayUTC();

  let lastWallet = null;
  let todayWallet = null;
  let startedToday = false;

  try {
    const msgs = await fetchThreadMessages(threadId, THREAD_HISTORY_LIMIT);

    // last wallet in history (best effort)
    lastWallet = findLastWalletForUser(msgs, userId);

    // today wallet (only if started today)
    const startMsgId = findTodayStartMessageId(msgs, day);
    if (startMsgId) {
      startedToday = true;
      const finalByUser = buildFinalWalletByUserSince(msgs, startMsgId, day);
      todayWallet = finalByUser.get(userId) || null;
    }
  } catch {
    // ignore
  }

  const url = `https://vine.governance.so/dao/${daoId}`;

  const lines = [];
  lines.push(`🌱 **Who Am I (OG Reputation Spaces)**`);
  lines.push(`• Space: ${url}`);
  lines.push(`• Today (UTC): **${day}**`);

  if (startedToday) {
    lines.push(`• Session started today: **yes**`);
    lines.push(`• Today’s wallet on record: ${todayWallet ? `\`${todayWallet}\`` : `_none_`}`);
  } else {
    lines.push(`• Session started today: **no**`);
    lines.push(`• Today’s wallet on record: _n/a_`);
  }

  lines.push(`• Last wallet seen in thread: ${lastWallet ? `\`${lastWallet}\`` : `_none_`}`);
  lines.push(
    `\nIf this is wrong:\n` +
      `• Check in: \`/checkin wallet:<YOUR_WALLET>\`\n` +
      `• Fix (before awards): \`/checkin wallet:<CORRECT_WALLET> fix:true\``
  );

  return reply(res, lines.join("\n"), true);
}

async function handleParticipants(interaction, res) {
  const threadId = interaction.channel_id;
  const userId = interaction.member?.user?.id || interaction.user?.id;

  if (!threadId) {
    return reply(res, "❌ `/participants` must be used inside the participation thread.", true);
  }

  const format = String(getOption(interaction, "format") || "wallets");
  const limitOpt = getOption(interaction, "limit");
  const showAll = Boolean(getOption(interaction, "show_all"));

  const limit = clampInt(limitOpt, 1, 50, 25);
  const day = todayUTC();

  // require started today (same logic you already use)
  const startedGate = await requireStartedToday(interaction, res, "`/participants`");
  if (startedGate) return startedGate;

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

    if (!finalByUser.size) {
      return reply(res, `ℹ️ No participants found for **${day}** yet.`, true);
    }

    const entries = Array.from(finalByUser.entries()); // [discordUserId, wallet]
    const total = entries.length;

    // build display lines
    const lines = entries.map(([uid, wallet], i) => {
      const mention = `<@${uid}>`;
      const w = `\`${wallet}\``;
      if (format === "mentions") return `• ${mention}`;
      if (format === "both") return `• ${mention} — ${w}`;
      return `• ${w}`; // wallets default
    });

    const header =
      `👥 **Participants (eligible) — ${day}**\n` +
      `• Total: **${total}**\n` +
      `• Showing: **${showAll ? total : Math.min(limit, total)}**\n`;

    if (!showAll) {
      const shown = lines.slice(0, limit);
      const remaining = Math.max(0, total - shown.length);
      return reply(
        res,
        header + "\n" + shown.join("\n") + (remaining ? `\n…and **${remaining}** more.` : ""),
        true
      );
    }

    // show_all => chunk into multiple messages in-thread (suppress embeds)
    const chunks = chunkLines(lines, 1800);
    await discordPostMessage(threadId, header, true);

    for (let i = 0; i < chunks.length; i++) {
      await discordPostMessage(threadId, chunks[i], true);
    }

    return reply(res, `✅ Posted **${total}** participant(s) for **${day}** in this thread.`, true);
  } catch (e) {
    return reply(res, `❌ Failed to list participants: ${e.message}`, true);
  }
}

async function handleLeaderboard(interaction, res) {
  const guildId = interaction.guild_id;
  if (!guildId) return reply(res, "❌ `/leaderboard` must be used in a server.", true);

  const daoId = await resolveDaoIdForContext({
    guildId,
    threadId: interaction.channel_id,
  });
  if (!daoId) {
    return reply(
      res,
      "❌ No OG Reputation Space is configured for this server/channel yet. Ask an admin to run `/setspace` or `/setthreadspace`.",
      true
    );
  }

  const limit = clampInt(getOption(interaction, "limit"), 1, 25, 10);
  const seasonOpt = getOption(interaction, "season");
  const ephemeralOpt = getOption(interaction, "ephemeral");
  const ephemeral = ephemeralOpt == null ? true : Boolean(ephemeralOpt);

  try {
    const lb = await getLeaderboard({
      daoId,
      season: seasonOpt == null ? null : Number(seasonOpt),
      limit,
    });

    const url = `https://vine.governance.so/dao/${lb.daoId}`;

    if (!lb.hasConfig) {
      return reply(
        res,
        `📊 **Leaderboard**\n` +
          `• Space: ${url}\n` +
          `• Status: _No config account for this DAO yet._`,
        ephemeral
      );
    }

    if (!lb.rows.length) {
      return reply(
        res,
        `📊 **Leaderboard** (Season **${lb.season}**)\n` +
          `• Space: ${url}\n` +
          `• No reputation accounts found yet.`,
        ephemeral
      );
    }

    const lines = lb.rows.map(
      (r) => `**${r.rank}.** \`${r.wallet}\` — **${r.points.toString()}**`
    );

    return reply(
      res,
      `📊 **OG Reputation Spaces Leaderboard** (Season **${lb.season}**)\n` +
        `• Space: ${url}\n\n` +
        lines.join("\n"),
      ephemeral
    );
  } catch (e) {
    return reply(res, `❌ Failed to fetch leaderboard: ${e.message}`, true);
  }
}

async function handlePoints(interaction, res) {
  const guildId = interaction.guild_id;
  const userId = interaction.member?.user?.id || interaction.user?.id;

  if (!guildId) return reply(res, "❌ `/points` must be used in a server.", true);

  const daoId = await resolveDaoIdForContext({
    guildId,
    threadId: interaction.channel_id,
  });
  if (!daoId) {
    return reply(
      res,
      "❌ No OG Reputation Space is configured for this server/channel yet. Ask an admin to run `/setspace` or `/setthreadspace`.",
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
      `🌱 **OG Reputation Spaces Points Balance**\n` +
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
  const threadId = interaction.channel_id;

  if (!guildId) return reply(res, "❌ `/getspace` must be used in a server.", true);

  const [defaultDaoId, threadDaoId] = await Promise.all([
    getDaoIdForGuild(guildId),
    threadId ? getDaoIdForThread(threadId) : null,
  ]);
  const effectiveDaoId =
    threadDaoId || defaultDaoId || (process.env.VINE_DAO_ID ? String(process.env.VINE_DAO_ID).trim() : null);

  if (!effectiveDaoId) {
    return reply(
      res,
      "ℹ️ No OG Reputation Space is configured for this server/channel yet.\n" +
        "Ask an admin/mod to run `/setspace space:<SPACE_PUBLIC_KEY>` (or `/setthreadspace` in this channel).",
      true
    );
  }

  const url = `https://vine.governance.so/dao/${effectiveDaoId}`;
  const source = threadDaoId
    ? "this channel/thread override"
    : defaultDaoId
      ? "server default"
      : "global env fallback";

  return reply(
    res,
    `✅ Current OG Reputation Space for this context:\n` +
      `• Server default: ${defaultDaoId ? `\`${defaultDaoId}\`` : "_not set_"}\n` +
      `• Channel/thread override: ${threadDaoId ? `\`${threadDaoId}\`` : "_not set_"}\n` +
      `• Effective DAO: \`${effectiveDaoId}\` (${source})\n` +
      `• Link: ${url}`,
    true
  );
}

async function handleSetAuthority(interaction, res) {
  const guildId = interaction.guild_id;

  if (!guildId) return reply(res, "❌ `/setauthority` must be used in a server.", true);
  if (!hasGuildConfigPermission(interaction)) {
    return reply(
      res,
      "❌ You need **Manage Server** or **Administrator** permission to run `/setauthority`.",
      true
    );
  }

  const panelUrl = authorityPanelUrl(guildId);
  if (!panelUrl) {
    return reply(
      res,
      "❌ Missing `VINE_WEB_BASE_URL` in server env. Set it to your app URL first.",
      true
    );
  }

  return reply(
    res,
    `🔐 Open the secure setup panel for this server:\n${panelUrl}\n\n` +
      `Use Discord OAuth there to save signer secrets to KV.`,
    true
  );
}

async function handleGetAuthority(interaction, res) {
  const guildId = interaction.guild_id;
  if (!guildId) return reply(res, "❌ `/getauthority` must be used in a server.", true);
  if (!hasGuildConfigPermission(interaction)) {
    return reply(
      res,
      "❌ You need **Manage Server** or **Administrator** permission to run `/getauthority`.",
      true
    );
  }

  try {
    const meta = await getSignerMetaForGuild(guildId);
    if (!meta) {
      return reply(
        res,
        "ℹ️ No authority signer is configured for this server yet.\n" +
          "Run `/setauthority` to open the secure setup panel.",
        true
      );
    }

    const updatedBy = meta.updatedBy ? `<@${meta.updatedBy}>` : "_unknown_";

    return reply(
      res,
      `🔐 **Authority Config**\n` +
        `• Authority: \`${meta.authorityPublicKey || "_unknown_"}\`\n` +
        `• Payer: \`${meta.payerPublicKey || "_unknown_"}\`\n` +
        `• RPC: ${meta.rpcUrl || "_default (`SOLANA_RPC_URL`)_"}\n` +
        `• Updated at: ${meta.updatedAt || "_unknown_"}\n` +
        `• Updated by: ${updatedBy}`,
      true
    );
  } catch (e) {
    return reply(res, `❌ Failed to load authority config: ${e.message}`, true);
  }
}

async function handleClearAuthority(interaction, res) {
  const guildId = interaction.guild_id;
  if (!guildId) return reply(res, "❌ `/clearauthority` must be used in a server.", true);
  if (!hasGuildConfigPermission(interaction)) {
    return reply(
      res,
      "❌ You need **Manage Server** or **Administrator** permission to run `/clearauthority`.",
      true
    );
  }

  try {
    await clearSignerForGuild(guildId);
    return reply(res, "✅ Authority signer config cleared for this server.", true);
  } catch (e) {
    return reply(res, `❌ Failed to clear authority config: ${e.message}`, true);
  }
}

async function handleFeePayer(interaction, res) {
  const guildId = interaction.guild_id;
  if (!guildId) return reply(res, "❌ `/feepayer` must be used in a server.", true);
  if (!hasGuildConfigPermission(interaction)) {
    return reply(
      res,
      "❌ You need **Manage Server** or **Administrator** permission to run `/feepayer`.",
      true
    );
  }

  const txCountRaw = getOption(interaction, "tx_count");
  const txCount = txCountRaw == null ? null : Math.max(0, Math.floor(Number(txCountRaw) || 0));
  const estPerTxLamports = 10000;
  const estSafetyLamports = 10000;

  try {
    const status = await getFeePayerStatus({ guildId });

    let estimateBlock = "";
    if (txCount && txCount > 0) {
      const neededLamports = estPerTxLamports * txCount + estSafetyLamports;
      const neededSol = (neededLamports / 1_000_000_000).toFixed(6).replace(/\.?0+$/, "");
      const enough = status.balanceLamports >= neededLamports;
      estimateBlock =
        `\n• Estimated for ${txCount} tx: **${neededSol} SOL**` +
        `\n• Coverage: ${enough ? "✅ Enough" : "❌ Insufficient"}`;
    }

    return reply(
      res,
      `⛽ **Fee Payer Status**\n` +
        `• Authority: \`${status.authority}\`\n` +
        `• Payer: \`${status.payer}\`\n` +
        `• Balance: **${status.balanceSol} SOL**\n` +
        `• Cluster: ${status.cluster}\n` +
        `• RPC: ${status.rpcUrl}` +
        estimateBlock,
      true
    );
  } catch (e) {
    return reply(res, `❌ Failed to load fee payer status: ${e.message}`, true);
  }
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
      `✅ Default DAO configured for this server: \`${String(daoId).trim()}\`\n(by <@${userId}>)`,
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

async function handleSetThreadDao(interaction, res) {
  const guildId = interaction.guild_id;
  const threadId = interaction.channel_id;
  const userId = interaction.member?.user?.id || interaction.user?.id;
  const daoId = interaction.data?.options?.find((o) => o.name === "space")?.value;

  if (!guildId || !threadId) {
    return reply(res, "❌ `/setthreadspace` must be used in a server channel/thread.", true);
  }
  if (!hasGuildConfigPermission(interaction)) {
    return reply(
      res,
      "❌ You need **Manage Server** or **Administrator** permission to run `/setthreadspace`.",
      true
    );
  }
  if (!daoId) {
    return reply(
      res,
      "❌ Missing Reputation Space id. Example: `/setthreadspace space:<SPACE_PUBLIC_KEY>`",
      true
    );
  }
  if (!isValidSolanaPubkey(daoId)) return reply(res, "❌ Invalid Reputation Space public key.", true);

  try {
    const current = (await getDaoIdForThread(threadId)) || null;
    if (current && String(current) === String(daoId).trim()) {
      return reply(
        res,
        `ℹ️ This channel/thread is already configured with that Space:\n• DAO: \`${current}\`\nNo changes were made.`,
        true
      );
    }

    await setDaoIdForThread(guildId, threadId, daoId);
    return reply(
      res,
      `✅ Channel/thread Space override set:\n` +
        `• Channel: \`${threadId}\`\n` +
        `• DAO: \`${String(daoId).trim()}\`\n` +
        `(by <@${userId}>)`,
      true
    );
  } catch (e) {
    if (String(e.message || "").toLowerCase().includes("already assigned")) {
      return reply(
        res,
        `⛔ That Space is already configured as a default in another server.\n` +
          `If this is expected, remove it there first.`,
        true
      );
    }
    return reply(res, `❌ Failed to set thread Space: ${e.message}`, true);
  }
}

async function handleClearThreadDao(interaction, res) {
  const guildId = interaction.guild_id;
  const threadId = interaction.channel_id;

  if (!guildId || !threadId) {
    return reply(res, "❌ `/clearthreadspace` must be used in a server channel/thread.", true);
  }
  if (!hasGuildConfigPermission(interaction)) {
    return reply(
      res,
      "❌ You need **Manage Server** or **Administrator** permission to run `/clearthreadspace`.",
      true
    );
  }

  try {
    const current = await getDaoIdForThread(threadId);
    if (!current) {
      return reply(res, "ℹ️ This channel/thread has no Space override set.", true);
    }

    await clearDaoIdForThread(guildId, threadId);
    const fallbackDao = await resolveDaoIdForContext({ guildId, threadId });
    return reply(
      res,
      `✅ Cleared channel/thread Space override.\n` +
        `• Removed: \`${current}\`\n` +
        `• Effective now: ${fallbackDao ? `\`${fallbackDao}\`` : "_none configured_"}`,
      true
    );
  } catch (e) {
    return reply(res, `❌ Failed to clear thread Space: ${e.message}`, true);
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
  // Best-effort REST checks with a short timeout so slash commands still answer Discord on time.
  const [perUserResult, listResult] = await Promise.allSettled([
    discordFetch(`/guilds/${guildId}/voice-states/${userId}`, {
      timeoutMs: VOICE_STATE_TIMEOUT_MS,
      timeoutRetries: 0,
    }),
    discordFetch(`/guilds/${guildId}/voice-states`, {
      timeoutMs: VOICE_STATE_TIMEOUT_MS,
      timeoutRetries: 0,
    }),
  ]);

  if (perUserResult.status === "fulfilled") {
    const vs = perUserResult.value;
    if (vs && (vs.channel_id || vs.channelId)) return vs.channel_id || vs.channelId;
  }

  if (listResult.status === "fulfilled") {
    const list = listResult.value;
    if (Array.isArray(list)) {
      const hit = list.find((v) => String(v?.user_id) === String(userId));
      if (hit && (hit.channel_id || hit.channelId)) return hit.channel_id || hit.channelId;
    }
  }

  return null;
}

async function requireActiveCall(interaction, res, labelForUser) {
  const guildId = interaction.guild_id;
  const userId = interaction.member?.user?.id || interaction.user?.id;

  if (!guildId || !userId) {
    // DM / missing context; block because we can't determine voice state
    const message = `❌ ${labelForUser} is only available inside the server thread while you are in the active call.`;
    return res ? reply(res, message, true) : message;
  }

  // Prefer interaction payload (fast)
  let channelId = safeGetInteractionVoiceChannelId(interaction);

  // Fallback to REST (best effort)
  if (!channelId) {
    channelId = await fetchUserVoiceChannelId(guildId, userId);
  }

  if (!channelId) {
    const message =
      `❌ You must be in the active voice/stage call to use ${labelForUser}.` +
      (ACTIVE_VOICE_CHANNEL_ID ? `\n(Required channel: \`${ACTIVE_VOICE_CHANNEL_ID}\`)` : "");
    return res ? reply(res, message, true) : message;
  }

  if (ACTIVE_VOICE_CHANNEL_ID && String(channelId) !== String(ACTIVE_VOICE_CHANNEL_ID)) {
    const message =
      `❌ You must be in the active voice/stage call to use ${labelForUser}.\n` +
      `Join the required channel: \`${ACTIVE_VOICE_CHANNEL_ID}\``;
    return res ? reply(res, message, true) : message;
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

async function resolveDaoIdForContext({ guildId, threadId } = {}) {
  const configuredDao = await getEffectiveDaoIdForContext({ guildId, threadId });
  const envDao = process.env.VINE_DAO_ID ? String(process.env.VINE_DAO_ID).trim() : null;
  const daoId = configuredDao || envDao || null;
  return daoId ? String(daoId).trim() : null;
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
  const daoId = await resolveDaoIdForContext({
    guildId: interaction?.guild_id,
    threadId: interaction?.channel_id,
  });
  return daoId ? `https://vine.governance.so/dao/${daoId}` : null;
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

function hasStartMarkerInMessages(messages, day) {
  const marker = startMarker(day);
  return messages.some((m) => String(m?.content || "").includes(marker));
}

function hasAwardMarkerForDayInMessages(messages, day) {
  const marker = awardDayMarker(day);
  return messages.some((m) => String(m?.content || "").includes(marker));
}

function reply(res, content, ephemeral = true) {
  const payload = { type: 4, data: { content } };
  if (ephemeral) payload.data.flags = 64; // EPHEMERAL
  return res.status(200).json(payload);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DISCORD_HTTP_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e?.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
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
  const {
    timeoutMs = DISCORD_HTTP_TIMEOUT_MS,
    timeoutRetries = DISCORD_TIMEOUT_RETRIES,
    ...fetchOpts
  } = opts;

  let res;
  try {
    res = await fetchWithTimeout(`${DISCORD_API}${path}`, {
      ...fetchOpts,
      headers: {
        Authorization: `Bot ${token}`,
        ...(fetchOpts.headers || {}),
      },
    }, timeoutMs);
  } catch (e) {
    const msg = String(e?.message || "");
    const timedOut = msg.includes("timed out");
    if (timedOut && attempt < timeoutRetries) {
      const waitMs = 250 * (attempt + 1);
      await new Promise((r) => setTimeout(r, waitMs));
      return discordFetch(path, { timeoutMs, timeoutRetries, ...fetchOpts }, attempt + 1);
    }
    throw e;
  }

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

// Fetch messages in this thread (paginated in chunks of 100).
async function fetchThreadMessages(threadId, maxMessages = THREAD_HISTORY_LIMIT, requestOptions = {}) {
  const target = Math.max(1, Math.min(500, maxMessages || THREAD_HISTORY_LIMIT));
  const out = [];
  let before = null;

  while (out.length < target) {
    const pageLimit = Math.min(100, target - out.length);
    const qs = new URLSearchParams({ limit: String(pageLimit) });
    if (before) qs.set("before", before);

    const page =
      (await discordFetch(`/channels/${threadId}/messages?${qs.toString()}`, requestOptions)) || [];
    if (page.length === 0) break;

    out.push(...page);
    if (page.length < pageLimit) break;

    before = page[page.length - 1]?.id || null;
    if (!before) break;
  }

  return out;
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
  const msgs = await fetchThreadMessages(threadId, THREAD_HISTORY_LIMIT);
  return hasAwardMarkerForDayInMessages(msgs, day);
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
    `Use \`/checkin wallet:<YOUR_SOLANA_WALLET>\` to check in for participation points.\n` +
    `Use \`/checkinwithlastwallet\` to check in for participation points with the last wallet used in this thread.` +
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

  const msgsPromise = fetchThreadMessages(threadId, THREAD_HISTORY_LIMIT, {
    timeoutMs: 1800,
    timeoutRetries: 0,
  });

  const gate = await requireActiveCall(interaction, res, "`/checkin`");
  if (gate) {
    void msgsPromise.catch(() => {});
    return gate;
  }

  const day = todayUTC();

  try {
    const msgs = await msgsPromise;
    if (!hasStartMarkerInMessages(msgs, day)) {
      return reply(
        res,
        `❌ No participation session has been started **today** in this thread.\n` +
          `Ask a moderator to run \`/startparticipation\` first.`,
        true
      );
    }

    if (hasAwardMarkerForDayInMessages(msgs, day)) {
      return reply(res, `⛔ Awards have already been issued **today** in this thread. Check-in is closed.`, true);
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

  const msgsPromise = fetchThreadMessages(threadId, CHECKIN_LAST_WALLET_HISTORY_LIMIT, {
    timeoutMs: 1800,
    timeoutRetries: 0,
  });

  const gate = await requireActiveCall(interaction, res, "`/checkinwithlastwallet`");
  if (gate) {
    void msgsPromise.catch(() => {});
    return gate;
  }

  const day = todayUTC();

  try {
    const msgs = await msgsPromise;
    if (!hasStartMarkerInMessages(msgs, day)) {
      return reply(
        res,
        `❌ No participation session has been started **today** in this thread.\n` +
          `Ask a moderator to run \`/startparticipation\` first.`,
        true
      );
    }

    if (hasAwardMarkerForDayInMessages(msgs, day)) {
      return reply(res, `⛔ Awards have already been issued **today** in this thread. Check-in is closed.`, true);
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
  const msgs = await fetchThreadMessages(threadId, THREAD_HISTORY_LIMIT);
  return hasStartMarkerInMessages(msgs, day);
}

async function requireStartedToday(interaction, res, labelForUser) {
  const threadId = interaction.channel_id;
  if (!threadId) {
    const message = `❌ ${labelForUser} must be used inside the participation thread.`;
    return res ? reply(res, message, true) : message;
  }

  const started = await hasStartMarkerToday(threadId);
  if (!started) {
    const message =
      `❌ No participation session has been started **today** in this thread.\n` +
      `Ask a moderator to run \`/startparticipation\` first.`;
    return res ? reply(res, message, true) : message;
  }

  return null; // OK
}

async function runAwardParticipationJob({ guildId, threadId, day }) {
  const runDay = day || todayUTC();
  const amount = 1;
  const awardTimeoutMs = Math.max(
    30000,
    Math.min(280000, Math.floor(Number(process.env.AWARD_SEND_TIMEOUT_MS || 240000)))
  );

  const post = async (content) => {
    try {
      await discordPostMessage(threadId, content, true);
    } catch (e) {
      console.error("award_participation: thread post failed:", e.message);
    }
  };
  
  const withStepTimeout = async (promise, label, ms = 20000) => {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  try {
    await post(`⏳ [1/4] Collecting check-ins for **${runDay}**...`);

    const msgs = await withStepTimeout(
      fetchThreadMessages(threadId, AWARD_HISTORY_LIMIT),
      "fetchThreadMessages"
    );
    await post(`✅ [1/4] Loaded **${msgs.length}** thread message(s).`);

    const awardedMarker = awardDayMarker(runDay);
    if (msgs.some((m) => String(m?.content || "").includes(awardedMarker))) {
      await post(
        `⛔ Participation was already awarded for **${runDay}** in this thread.\n(One award per day)`
      );
      return { ok: true, status: "already_awarded" };
    }

    const startMsgId = findTodayStartMessageId(msgs, runDay);
    if (!startMsgId) {
      await post(
        `❌ No participation session has been started **today** in this thread.\n` +
          `Ask a moderator to run \`/startparticipation\` first.`
      );
      return { ok: true, status: "not_started" };
    }

    const finalByUser = buildFinalWalletByUserSince(msgs, startMsgId, runDay);
    if (finalByUser.size === 0) {
      await post("ℹ️ No wallets found in this thread yet.");
      return { ok: true, status: "no_wallets" };
    }

    const wallets = Array.from(finalByUser.values());
    await post(`✅ [2/4] Found **${wallets.length}** eligible wallet(s). Loading configuration...`);

    const daoId = await withStepTimeout(
      resolveDaoIdForContext({ guildId, threadId }),
      "resolveDaoIdForContext"
    );
    if (!daoId) {
      await post(
        "❌ No OG Space is configured for this server/channel yet. Ask an admin to run `/setspace` or `/setthreadspace`."
      );
      return { ok: true, status: "missing_dao" };
    }

    await post(`🛰️ [3/4] Sending transactions for **${wallets.length}** wallet(s)...`);
    const results = await withStepTimeout(
      awardOnePoint(wallets, { daoId, guildId }),
      "awardOnePoint",
      awardTimeoutMs
    );
    const payer = results?.payer || null;

    const ok = results.filter((r) => r.ok);
    const bad = results.filter((r) => !r.ok);

    if (ok.length === 0) {
      const failPreview = bad
        .slice(0, 3)
        .map((r) => `• \`${r.wallet}\` → ${r.error}`)
        .join("\n");

      await post(
        `❌ Award failed for **${runDay}** (0 successes).\n` +
          (payer ? `Fee payer: \`${payer.payer}\` (${payer.balanceSol} SOL)\n` : "") +
          (payer ? `Estimated needed: ${payer.estimatedTotalSol} SOL\n` : "") +
          (failPreview ? `\nFirst errors:\n${failPreview}` : "")
      );
      return { ok: false, status: "award_failed", errors: bad };
    }

    const dayMarker = awardDayMarker(runDay);
    await discordPostMessage(
      threadId,
      `✅ Participation awarded for **${runDay}** — **${amount}** point per participant.\n` +
        `• Participants: **${wallets.length}**\n` +
        `${dayMarker}`,
      true
    );

    const successLinesAll = ok.map((r) => `• \`${r.wallet}\` → ${r.url}`);
    const failureLinesAll = bad.map((r) => `• \`${r.wallet}\` → ${r.error}`);
    const MAX_SUCCESS_CHARS = 1400;
    const MAX_FAIL_CHARS = 700;

    const successBlock = formatSampleBlock(
      "Success",
      successLinesAll,
      successLinesAll.length,
      MAX_SUCCESS_CHARS
    );
    const failBlock = formatSampleBlock(
      "Failures",
      failureLinesAll,
      failureLinesAll.length,
      MAX_FAIL_CHARS
    );

    const summary =
      `✅ Award complete for **${runDay}**\n` +
      `• Eligible wallets: **${wallets.length}**\n` +
      `• Success: **${ok.length}**\n` +
      `• Failed: **${bad.length}**` +
      (payer ? `\n• Fee payer: \`${payer.payer}\`` : "") +
      (payer ? `\n• Fee payer balance: **${payer.balanceSol} SOL**` : "") +
      (payer ? `\n• Estimated fee needed: **${payer.estimatedTotalSol} SOL**` : "");

    const spaceUrl = daoId ? `https://vine.governance.so/dao/${daoId}` : null;
    await discordPostMessage(
      threadId,
      summary + (spaceUrl ? `\n\n📌 View the Space: ${spaceUrl}` : "") + successBlock + failBlock,
      true
    );

    await post(`✅ [4/4] Award run finished: **${ok.length}/${wallets.length}** success.`);
    return { ok: true, status: "completed", total: wallets.length, success: ok.length, failed: bad.length };
  } catch (e) {
    console.error("award_participation:error", e);
    await post(`❌ Award error: ${e.message}`);
    return { ok: false, status: "error", error: e.message };
  }
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

  // distributed lock to prevent double-awards
  const lock = await acquireAwardLock(threadId, day);
  if (!lock.ok) {
    if (lock.reason === "already_awarded") {
      return reply(
        res,
        `⛔ Participation was already awarded for **${day}** in this thread.\n(One award per day.)`,
        true
      );
    }

    return reply(
      res,
      `⛔ Awards are already **in progress** for **${day}** in this thread.\n` +
        `Please wait for the current run to finish.`,
      true
    );
  }

  const lockNonce = lock.nonce;
  try {
    const alreadyToday = await hasAwardMarkerForDay(threadId, day);
    if (alreadyToday) {
      return reply(
        res,
        `⛔ Participation was already awarded for **${day}** in this thread.\n(One award per day.)`,
        false
      );
    }

    // Build eligible list from thread messages.
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
    if (finalByUser.size === 0) {
      return reply(res, "No wallets found in this thread yet.", false);
    }

    const wallets = Array.from(finalByUser.values());

    const daoId = await resolveDaoIdForContext({
      guildId: interaction.guild_id,
      threadId: interaction.channel_id,
    });
    if (!daoId) {
      return reply(
        res,
        "❌ No OG Space is configured for this server/channel yet. Ask an admin to run `/setspace` or `/setthreadspace`.",
        true
      );
    }

    const results = await awardOnePoint(wallets, { daoId, guildId: interaction.guild_id });
    const payer = results?.payer || null;

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
          (payer ? `Fee payer: \`${payer.payer}\` (${payer.balanceSol} SOL)\n` : "") +
          (payer ? `Estimated needed: ${payer.estimatedTotalSol} SOL\n` : "") +
          (failPreview ? `\nFirst errors:\n${failPreview}` : ""),
        true
      );
    }

    const dayMarker = awardDayMarker(day);

    // 1) Lock/marker message
    await discordPostMessage(
      threadId,
      `✅ Participation awarded for **${day}** — **${amount}** point per participant.\n` +
        `• Participants: **${wallets.length}**\n` +
        `${dayMarker}`,
      true
    );

    // 2) Detailed summary message
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
      `• Failed: **${bad.length}**` +
      (payer ? `\n• Fee payer: \`${payer.payer}\`` : "") +
      (payer ? `\n• Fee payer balance: **${payer.balanceSol} SOL**` : "") +
      (payer ? `\n• Estimated fee needed: **${payer.estimatedTotalSol} SOL**` : "");

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
  } catch (e) {
    return reply(res, `❌ Error: ${e.message}`, true);
  } finally {
    try {
      await releaseAwardLock(threadId, day, lockNonce);
    } catch (e) {
      console.error("award_participation: failed to release lock:", e.message);
    }
  }
}

async function handleSlashCommand(interaction, res) {
  const name = interaction.data?.name;

  if (name === "startparticipation") return handleStartParticipation(interaction, res);
  if (name === "checkin") return handleCheckin(interaction, res);
  if (name === "checkinwithlastwallet") return handleCheckinWithLastWallet(interaction, res);
  if (name === "award_participation") return handleAwardParticipation(interaction, res);
  if (name === "setspace") return handleSetDao(interaction, res);
  if (name === "setthreadspace") return handleSetThreadDao(interaction, res);
  if (name === "clearthreadspace") return handleClearThreadDao(interaction, res);
  if (name === "getspace") return handleGetSpace(interaction, res);
  if (name === "setauthority") return handleSetAuthority(interaction, res);
  if (name === "getauthority") return handleGetAuthority(interaction, res);
  if (name === "clearauthority") return handleClearAuthority(interaction, res);
  if (name === "feepayer") return handleFeePayer(interaction, res);
  if (name === "points") return handlePoints(interaction, res); 
  if (name === "whoami") return handleWhoAmI(interaction, res);
  if (name === "participants") return handleParticipants(interaction, res);
  if (name === "leaderboard") return handleLeaderboard(interaction, res);
  if (name === "help") return handleHelp(interaction, res);

  return reply(res, `Unknown command: ${name}`, true);
}

module.exports = { handleSlashCommand, runAwardParticipationJob };
