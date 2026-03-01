// lib/discord/dao_store.js
const { kv } = require("@vercel/kv");

function legacyKeyByGuild(guildId) {
  return `vine:daoByGuild:${String(guildId).trim()}`;
}

function keyDefaultByGuild(guildId) {
  return `vine:daoDefaultByGuild:${String(guildId).trim()}`;
}

function keyByThread(threadId) {
  return `vine:daoByThread:${String(threadId).trim()}`;
}

function keyByDao(daoId) {
  return `vine:guildByDao:${String(daoId).trim()}`;
}

async function getDaoIdForGuild(guildId) {
  if (!guildId) return null;
  const byDefault = await kv.get(keyDefaultByGuild(guildId));
  if (byDefault) return String(byDefault).trim();

  // Backward-compatible read for older installs.
  const byLegacy = await kv.get(legacyKeyByGuild(guildId));
  return byLegacy ? String(byLegacy).trim() : null;
}

function parseThreadRecord(raw) {
  if (!raw) return null;

  if (typeof raw === "string") {
    return { guildId: null, daoId: String(raw).trim() };
  }

  if (typeof raw === "object" && raw.daoId) {
    return {
      guildId: raw.guildId ? String(raw.guildId).trim() : null,
      daoId: String(raw.daoId).trim(),
    };
  }

  return null;
}

async function getThreadRecord(threadId) {
  if (!threadId) return null;
  const raw = await kv.get(keyByThread(threadId));
  return parseThreadRecord(raw);
}

async function getDaoIdForThread(threadId) {
  const record = await getThreadRecord(threadId);
  return record?.daoId || null;
}

async function getGuildIdForDao(daoId) {
  if (!daoId) return null;
  return await kv.get(keyByDao(daoId));
}

/**
 * Sets default daoId for a guild.
 * A daoId can only be assigned to ONE guild globally.
 */
async function setDaoIdForGuild(guildId, daoId) {
  if (!guildId) throw new Error("Missing guildId");
  if (!daoId) throw new Error("Missing daoId (space public key)");

  const g = String(guildId).trim();
  const d = String(daoId).trim();

  // 1) Is this dao already assigned to some other guild?
  const existingGuild = await kv.get(keyByDao(d));
  if (existingGuild && String(existingGuild) !== g) {
    throw new Error(`This Space is already assigned to another server (guildId: ${existingGuild})`);
  }

  // 2) If this guild already had a default dao, unlink its reverse mapping
  const prevDao = await getDaoIdForGuild(g);
  if (prevDao && String(prevDao).trim() !== d) {
    await kv.del(keyByDao(String(prevDao).trim()));
  }

  // 3) Write both mappings
  await kv.set(keyDefaultByGuild(g), d);
  // Keep legacy key synced for older readers during migration.
  await kv.set(legacyKeyByGuild(g), d);
  await kv.set(keyByDao(d), g);

  return true;
}

/**
 * Sets a dao override for a specific thread/channel in a guild.
 * Ownership checks are based on default guild mappings; thread overrides do not
 * claim global ownership for a daoId.
 */
async function setDaoIdForThread(guildId, threadId, daoId) {
  if (!guildId) throw new Error("Missing guildId");
  if (!threadId) throw new Error("Missing threadId");
  if (!daoId) throw new Error("Missing daoId (space public key)");

  const g = String(guildId).trim();
  const t = String(threadId).trim();
  const d = String(daoId).trim();

  const existingGuild = await kv.get(keyByDao(d));
  if (existingGuild && String(existingGuild) !== g) {
    throw new Error(`This Space is already assigned to another server (guildId: ${existingGuild})`);
  }

  await kv.set(keyByThread(t), { guildId: g, daoId: d });
  return true;
}

async function clearDaoIdForThread(guildId, threadId) {
  if (!threadId) throw new Error("Missing threadId");

  const g = guildId ? String(guildId).trim() : null;
  const t = String(threadId).trim();
  const prev = await getThreadRecord(t);
  if (!prev?.daoId) return false;

  if (g && prev.guildId && prev.guildId !== g) {
    throw new Error("Thread override belongs to a different guild.");
  }

  await kv.del(keyByThread(t));
  return true;
}

async function getEffectiveDaoIdForContext({ guildId, threadId } = {}) {
  if (threadId) {
    const byThread = await getDaoIdForThread(threadId);
    if (byThread) return byThread;
  }
  if (guildId) {
    const byGuild = await getDaoIdForGuild(guildId);
    if (byGuild) return byGuild;
  }
  return null;
}

module.exports = {
  getDaoIdForGuild,
  getDaoIdForThread,
  getEffectiveDaoIdForContext,
  getGuildIdForDao,
  setDaoIdForGuild,
  setDaoIdForThread,
  clearDaoIdForThread,
};
