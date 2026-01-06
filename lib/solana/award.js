// lib/solana/award.js
const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} = require("@solana/web3.js");

const bs58Mod = require("bs58");
const bs58 = bs58Mod?.default ?? bs58Mod;

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

function keypairFromEnv(name) {
  const raw = mustEnv(name).trim();

  if (raw.startsWith("[") && raw.endsWith("]")) {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) throw new Error(`${name} JSON is not an array`);
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }

  try {
    const bytes = bs58.decode(raw);
    return Keypair.fromSecretKey(bytes);
  } catch {}

  try {
    const bytes = Buffer.from(raw, "base64");
    return Keypair.fromSecretKey(new Uint8Array(bytes));
  } catch {}

  throw new Error(`${name} is not valid base58 / base64 / JSON-array secret.`);
}

function inferClusterFromRpc(rpcUrl) {
  const u = String(rpcUrl || "").toLowerCase();
  if (u.includes("devnet")) return "devnet";
  if (u.includes("testnet")) return "testnet";
  return "mainnet-beta";
}

function txUrl(sig, cluster) {
  const c = cluster || "mainnet-beta";
  return `https://explorer.solana.com/tx/${sig}?cluster=${encodeURIComponent(c)}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function toDaoPublicKey(daoIdMaybe) {
  if (!daoIdMaybe) return null;
  if (daoIdMaybe instanceof PublicKey) return daoIdMaybe;
  return new PublicKey(String(daoIdMaybe).trim());
}

/**
 * awardOnePoint(wallets, opts)
 * opts: { daoId?: string|PublicKey, amount?: bigint, rpcUrl?: string, cluster?: string }
 */
async function awardOnePoint(wallets, opts = {}) {
  const vine = await getVineClient();
  const { buildAddReputationPointsIx, VINE_REP_PROGRAM_ID } = vine;

  const rpcUrl = opts.rpcUrl || mustEnv("SOLANA_RPC_URL");
  const cluster = opts.cluster || inferClusterFromRpc(rpcUrl);

  // ✅ daoId from opts first, fallback to env for backwards compatibility
  const daoPk = toDaoPublicKey(opts.daoId) || toDaoPublicKey(process.env.VINE_DAO_ID);
  if (!daoPk) throw new Error("Missing daoId (pass opts.daoId or set VINE_DAO_ID)");

  const amount = typeof opts.amount === "bigint" ? opts.amount : 1n;

  const authorityKp = keypairFromEnv("VINE_AUTHORITY_SECRET");
  const payerKp = authorityKp;

  const conn = new Connection(rpcUrl, "confirmed");

  // ✅ dedupe + normalize
  const unique = Array.from(
    new Set((wallets || []).map((w) => String(w || "").trim()).filter(Boolean))
  );

  const results = [];
  for (const w of unique) {
    try {
      const user = new PublicKey(w);

      const { ix } = await buildAddReputationPointsIx({
        conn,
        daoId: daoPk,
        authority: authorityKp.publicKey,
        payer: payerKp.publicKey,
        user,
        amount,
        programId: VINE_REP_PROGRAM_ID,
      });

      const tx = new Transaction().add(ix);

      const { blockhash } = await conn.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = payerKp.publicKey;

      const sig = await sendAndConfirmTransaction(conn, tx, [authorityKp], {
        commitment: "confirmed",
      });

      results.push({ wallet: w, ok: true, sig, url: txUrl(sig, cluster) });

      await sleep(150);
    } catch (e) {
      results.push({ wallet: w, ok: false, error: e?.message || String(e) });
    }
  }

  return results;
}

module.exports = { awardOnePoint };