// lib/discord/dao_store.js
const fs = require("fs");
const path = require("path");

// Persist to: ./data/dao_by_guild.json
const STORE_PATH = path.join(process.cwd(), "data", "dao_by_guild.json");

function ensureDir() {
  const dir = path.dirname(STORE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readStore() {
  try {
    ensureDir();
    if (!fs.existsSync(STORE_PATH)) return {};
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, "utf8") || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    console.log("dao_store readStore error:", e.message);
    return {};
  }
}

function writeStore(obj) {
  ensureDir();
  fs.writeFileSync(STORE_PATH, JSON.stringify(obj, null, 2), "utf8");
}

function getDaoIdForGuild(guildId) {
  if (!guildId) return null;
  const store = readStore();
  return store[String(guildId)] || null;
}

function setDaoIdForGuild(guildId, daoId) {
  if (!guildId) throw new Error("Missing guildId");
  if (!daoId) throw new Error("Missing daoId (space public key)");
  const store = readStore();
  store[String(guildId)] = String(daoId).trim();
  writeStore(store);
  return true;
}

module.exports = { getDaoIdForGuild, setDaoIdForGuild };