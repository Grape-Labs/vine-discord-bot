// lib/discord/dao_store.js
const { kv } = require("@vercel/kv");

const HASH_KEY = "dao_by_guild";

async function getDaoIdForGuild(guildId) {
  if (!guildId) return null;
  try {
    const v = await kv.hget(HASH_KEY, String(guildId));
    return v ? String(v) : null;
  } catch (e) {
    // If KV not configured, fail gracefully
    console.log("dao_store get error:", e?.message || e);
    return null;
  }
}

async function setDaoIdForGuild(guildId, daoId) {
  if (!guildId) throw new Error("Missing guildId");
  if (!daoId) throw new Error("Missing daoId (space public key)");

  try {
    await kv.hset(HASH_KEY, { [String(guildId)]: String(daoId).trim() });
    return true;
  } catch (e) {
    throw new Error(e?.message || "KV write failed");
  }
}

module.exports = { getDaoIdForGuild, setDaoIdForGuild };