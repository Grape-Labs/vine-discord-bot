// lib/solana/award.js
const { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } = require("@solana/web3.js");

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

function txUrl(sig) {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function awardOnePoint(wallets) {
  const vine = await getVineClient();
  const { buildAddReputationPointsIx, VINE_REP_PROGRAM_ID } = vine;

  const rpc = mustEnv("SOLANA_RPC_URL");
  const daoId = new PublicKey(mustEnv("VINE_DAO_ID"));

  const authorityKp = keypairFromEnv("VINE_AUTHORITY_SECRET");
  const payerKp = authorityKp;

  const conn = new Connection(rpc, "confirmed");

  // ✅ dedupe + normalize
  const unique = Array.from(
    new Set((wallets || []).map((w) => String(w || "").trim()).filter(Boolean))
  );

  const results = [];
  for (const w of unique) {
    try {
      // ✅ validate pubkey early (gives clear error)
      const user = new PublicKey(w);

      const { ix } = await buildAddReputationPointsIx({
        conn,
        daoId,
        authority: authorityKp.publicKey,
        payer: payerKp.publicKey,
        user,
        amount: 1n,
        programId: VINE_REP_PROGRAM_ID,
      });

      const tx = new Transaction().add(ix);

      // helpful: fresh blockhash per tx (usually not needed, but avoids edge cases)
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = payerKp.publicKey;

      const sig = await sendAndConfirmTransaction(conn, tx, [authorityKp], {
        commitment: "confirmed",
      });

      results.push({ wallet: w, ok: true, sig, url: txUrl(sig) });

      // ✅ small delay helps if RPC is rate limiting
      await sleep(150);
    } catch (e) {
      results.push({ wallet: w, ok: false, error: e?.message || String(e) });
    }
  }

  return results;
}

module.exports = { awardOnePoint };