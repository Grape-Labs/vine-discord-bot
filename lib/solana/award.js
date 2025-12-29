// lib/solana/award.js
const { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } = require("@solana/web3.js");

// ✅ bs58 in Node/Next can be ESM-shaped; normalize it
const bs58Mod = require("bs58");
const bs58 = bs58Mod?.default ?? bs58Mod;

let vineClientModPromise;

async function getVineClient() {
  if (!vineClientModPromise) {
    vineClientModPromise = import("@grapenpm/vine-reputation-client");
  }
  const mod = await vineClientModPromise;
  // ✅ also normalize in case the package is ESM default-exported
  return mod?.default ?? mod;
}

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function keypairFromEnv(name) {
  const raw = mustEnv(name).trim();

  // 1) JSON array secret (Solana default keypair file format)
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) throw new Error(`${name} JSON is not an array`);
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }

  // 2) base58 (your current expected format)
  try {
    const bytes = bs58.decode(raw);
    return Keypair.fromSecretKey(bytes);
  } catch (_) {
    // fall through
  }

  // 3) base64 (common in env vars)
  try {
    const bytes = Buffer.from(raw, "base64");
    return Keypair.fromSecretKey(new Uint8Array(bytes));
  } catch (_) {
    // fall through
  }

  throw new Error(
    `${name} is not valid base58 / base64 / JSON-array secret. Check for quotes, spaces, or wrong format.`
  );
}

function txUrl(sig) {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

async function awardOnePoint(wallets) {
  const vine = await getVineClient();
  const { buildAddReputationIx, buildAddReputationPointsIx, VINE_REP_PROGRAM_ID } = vine;

  const rpc = mustEnv("SOLANA_RPC_URL");
  const daoId = new PublicKey(mustEnv("VINE_DAO_ID"));

  const authorityKp = keypairFromEnv("VINE_AUTHORITY_SECRET");
  const payerKp = authorityKp; // same kp

  const conn = new Connection(rpc, "confirmed");

  const results = [];
  for (const w of wallets) {
    try {
        const user = new PublicKey(w);
        const amt = BigInt(Math.floor(Number(1)));
        const { ix } = await buildAddReputationPointsIx({
            conn,
            daoId,
            authority: authorityKp.publicKey,
            payer: payerKp.publicKey,
            user,
            amount: amt,
            programId: VINE_REP_PROGRAM_ID,
        });

      const tx = new Transaction().add(ix);
    
      // ✅ only sign once (payerKp === authorityKp)
      const sig = await sendAndConfirmTransaction(conn, tx, [authorityKp], {
        commitment: "confirmed",
      });

      results.push({ wallet: w, ok: true, sig, url: txUrl(sig) });
    } catch (e) {
      results.push({ wallet: w, ok: false, error: e?.message || String(e) });
    }
  }

  return results;
}

module.exports = { awardOnePoint };