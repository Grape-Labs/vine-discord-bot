// lib/solana/points.js
const { Connection, PublicKey } = require("@solana/web3.js");

let vineClientModPromise;

async function getVineClient() {
  if (!vineClientModPromise) vineClientModPromise = import("@grapenpm/vine-reputation-client");
  const mod = await vineClientModPromise;
  return mod?.default ?? mod;
}

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function toDaoPublicKey(daoIdMaybe) {
  if (!daoIdMaybe) return null;
  if (daoIdMaybe instanceof PublicKey) return daoIdMaybe;
  return new PublicKey(String(daoIdMaybe).trim());
}

function getRpcConnection() {
  const url = mustEnv("SOLANA_RPC_URL");
  return new Connection(url, "confirmed");
}

async function getPointsBalance(walletStr, { daoId } = {}) {
  const vine = await getVineClient();
  const { fetchConfig, fetchReputation } = vine;

  const conn = getRpcConnection();

  const daoPk = toDaoPublicKey(daoId) || toDaoPublicKey(process.env.VINE_DAO_ID);
  if (!daoPk) throw new Error("Missing daoId (pass daoId or set VINE_DAO_ID)");

  const userPk = new PublicKey(String(walletStr).trim());

  const cfg = await fetchConfig(conn, daoPk);
  if (!cfg) {
    return { points: 0n, season: 0, hasAccount: false };
  }

  const season = Number(cfg.currentSeason);
  const rep = await fetchReputation(conn, daoPk, userPk, season);

  if (!rep) {
    return { points: 0n, season, hasAccount: false };
  }

  return { points: rep.points ?? 0n, season, hasAccount: true };
}

module.exports = { getPointsBalance };