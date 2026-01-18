// lib/solana/points.js
const { Connection, PublicKey } = require("@solana/web3.js");
const {
  fetchConfig,
  fetchReputation,
} = require("../vine-reputation-client"); // adjust path to wherever this file lives

function getRpcConnection() {
  const url = process.env.SOLANA_RPC_URL;
  if (!url) throw new Error("Missing SOLANA_RPC_URL");
  return new Connection(url, "confirmed");
}

async function getPointsBalance(walletStr, { daoId }) {
  const conn = getRpcConnection();
  const daoPk = new PublicKey(daoId);
  const userPk = new PublicKey(walletStr);

  const cfg = await fetchConfig(conn, daoPk);
  if (!cfg) {
    // No config account for this DAO yet
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