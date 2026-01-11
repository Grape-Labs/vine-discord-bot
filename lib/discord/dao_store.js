// lib/discord/dao_store.js
const { kv } = require("@vercel/kv");

function key(guildId) {
  return `vine:daoByGuild:${String(guildId)}`;
}

async function getDaoIdForGuild(guildId) {
  if (!guildId) return null;
  return await kv.get(key(guildId));
}

async function setDaoIdForGuild(guildId, daoId) {
  if (!guildId) throw new Error("Missing guildId");
  if (!daoId) throw new Error("Missing daoId (space public key)");
  await kv.set(key(guildId), String(daoId).trim());
  return true;
}

module.exports = { getDaoIdForGuild, setDaoIdForGuild };