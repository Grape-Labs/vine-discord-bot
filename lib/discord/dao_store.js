// lib/discord/dao_store.js
const { kv } = require("@vercel/kv");

function key(guildId) {
  return `vine:v1:daoByGuild:${String(guildId)}`;
}

async function getDaoIdForGuild(guildId) {
  if (!guildId) return null;
  try {
    const v = await kv.get(key(guildId));
    return v ? String(v) : null;
  } catch (e) {
    // Most common cause: KV env vars missing on this deployment
    console.log("dao_store getDaoIdForGuild error:", e?.message || e);
    return null;
  }
}

async function setDaoIdForGuild(guildId, daoId) {
  if (!guildId) throw new Error("Missing guildId");
  if (!daoId) throw new Error("Missing daoId (space public key)");

  try {
    await kv.set(key(guildId), String(daoId).trim());
    return true;
  } catch (e) {
    // Give a clean message back to /setspace
    throw new Error(e?.message || "Failed to write to KV");
  }
}

module.exports = { getDaoIdForGuild, setDaoIdForGuild };