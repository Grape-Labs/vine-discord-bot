// lib/solana/award.js
const bs58 = require("bs58");
const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} = require("@solana/web3.js");

let vineClientModPromise;

async function getVineClient() {
  if (!vineClientModPromise) {
    vineClientModPromise = import("@grapenpm/vine-reputation-client");
  }
  return vineClientModPromise;
}

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function keypairFromBs58Env(name) {
  const secret = mustEnv(name);
  const bytes = bs58.decode(secret);
  return Keypair.fromSecretKey(bytes);
}

function txUrl(sig) {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

async function awardOnePoint(wallets) {
  const vine = await getVineClient();
  const { buildAddReputationIx } = vine;

  // safest: hardcode program id you know is correct (or move to env)
  const VINE_REP_PROGRAM_ID = new PublicKey(
    "V1NE6WCWJPRiVFq5DtaN8p87M9DmmUd2zQuVbvLgQwX"
  );

  const rpc = mustEnv("SOLANA_RPC_URL");
  const daoId = new PublicKey(mustEnv("VINE_DAO_ID"));

  const authorityKp = keypairFromBs58Env("VINE_AUTHORITY_SECRET");

  // payer == authority for now
  const authorityPubkey = authorityKp.publicKey;

  const conn = new Connection(rpc, "confirmed");

  const results = [];
  for (const w of wallets) {
    try {
      const user = new PublicKey(w);

      const { ix } = await buildAddReputationIx({
        conn,
        daoId,
        authority: authorityPubkey,
        payer: authorityPubkey,
        user,
        amount: 1n,
        programId: VINE_REP_PROGRAM_ID,
      });

      const tx = new Transaction().add(ix);

      // sign once (authority == payer)
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