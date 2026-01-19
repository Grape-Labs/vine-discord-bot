// lib/solana/leaderboard.js
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

function getRpcConnection() {
  const url = mustEnv("SOLANA_RPC_URL");
  return new Connection(url, "confirmed");
}

function toDaoPublicKey(daoIdMaybe) {
  if (!daoIdMaybe) return null;
  if (daoIdMaybe instanceof PublicKey) return daoIdMaybe;
  return new PublicKey(String(daoIdMaybe).trim());
}

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(x)));
}

function shortPk(pk, chars = 4) {
  const s = String(pk || "");
  if (s.length <= chars * 2 + 3) return s;
  return `${s.slice(0, chars)}…${s.slice(-chars)}`;
}

/**
 * getLeaderboard({ daoId, season?, limit? })
 * returns { daoId, season, rows: [{ rank, wallet, points }] }
 */
async function getLeaderboard({ daoId, season, limit }) {
  const vine = await getVineClient();
  const { fetchConfig, fetchReputationsForDaoSeason, VINE_REP_PROGRAM_ID } = vine;

  const conn = getRpcConnection();

  const daoPk = toDaoPublicKey(daoId) || toDaoPublicKey(process.env.VINE_DAO_ID);
  if (!daoPk) throw new Error("Missing daoId (pass daoId or set VINE_DAO_ID)");

  // default limit 10, max 25
  const topN = clampInt(limit, 1, 25, 10);

  // resolve season if not provided
  let useSeason = season;
  if (useSeason == null) {
    const cfg = await fetchConfig(conn, daoPk);
    if (!cfg) {
      return { daoId: daoPk.toBase58(), season: 0, rows: [], hasConfig: false };
    }
    useSeason = Number(cfg.currentSeason);
  }

  useSeason = clampInt(useSeason, 0, 65535, 0);

  const reps = await fetchReputationsForDaoSeason({
    conn,
    daoId: daoPk,
    season: useSeason,
    programId: VINE_REP_PROGRAM_ID,
    limit: 50_000,
    commitment: "confirmed",
  });

  // reps are already sorted desc by points in your NPM
  const rows = reps.slice(0, topN).map((r, i) => ({
    rank: i + 1,
    wallet: r.user.toBase58(),
    walletShort: shortPk(r.user.toBase58()),
    points: r.points,
  }));

  return { daoId: daoPk.toBase58(), season: useSeason, rows, hasConfig: true };
}

module.exports = { getLeaderboard };