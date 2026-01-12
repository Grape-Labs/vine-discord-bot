// lib/discord/dao_store.js
const { kv } = require("@vercel/kv");

function keyByGuild(guildId) {
  return `vine:daoByGuild:${String(guildId)}`;
}

function keyByDao(daoId) {
  return `vine:guildByDao:${String(daoId).trim()}`;
}

async function getDaoIdForGuild(guildId) {
  if (!guildId) return null;
  return await kv.get(keyByGuild(guildId));
}

async function getGuildIdForDao(daoId) {
  if (!daoId) return null;
  return await kv.get(keyByDao(daoId));
}

/**
 * Sets daoId for a guild, ensuring a daoId can only be assigned to ONE guild globally.
 * Automatically unlinks any previous dao from this guild.
 */
async function setDaoIdForGuild(guildId, daoId) {
  if (!guildId) throw new Error("Missing guildId");
  if (!daoId) throw new Error("Missing daoId (space public key)");

  const g = String(guildId);
  const d = String(daoId).trim();

  // 1) Is this dao already assigned to some other guild?
  const existingGuild = await kv.get(keyByDao(d));
  if (existingGuild && String(existingGuild) !== g) {
    throw new Error(`This Space is already assigned to another server (guildId: ${existingGuild})`);
  }

  // 2) If this guild already had a dao, unlink its reverse mapping
  const prevDao = await kv.get(keyByGuild(g));
  if (prevDao && String(prevDao).trim() !== d) {
    await kv.del(keyByDao(String(prevDao).trim()));
  }

  // 3) Write both mappings
  await kv.set(keyByGuild(g), d);
  await kv.set(keyByDao(d), g);

  return true;
}

module.exports = {
  getDaoIdForGuild,
  getGuildIdForDao,
  setDaoIdForGuild,
};