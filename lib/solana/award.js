// lib/solana/award.js
const bs58 = require("bs58");
const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} = require("@solana/web3.js");

// IMPORTANT: adjust import path to wherever you place your TS build output
// If your vine client is TS-only, you either:
// 1) compile it to JS in your package, OR
// 2) move the few functions you need into a JS module.
//
// Assuming you can import it from your package:
const {
  buildAddReputationIx,
  VINE_REP_PROGRAM_ID,
} = require("@grapenpm/vine-reputation-client");

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function loadKeypairFromBs58Env(name) {
  const secret = requireEnv(name);
  const bytes = bs58.decode(secret);
  return Keypair.fromSecretKey(bytes);
}

function explorerTx(sig) {
  // devnet explorer link
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

async function awardOnePointToWallets(wallets) {
  const rpc = requireEnv("SOLANA_RPC_URL");
  const daoId = new PublicKey(requireEnv("VINE_DAO_ID"));

  const authority = loadKeypairFromBs58Env("VINE_AUTHORITY_SECRET");

  // payer can be different; default to authority if not provided
  let payer = authority;
  if (process.env.VINE_PAYER_SECRET) {
    payer = loadKeypairFromBs58Env("VINE_PAYER_SECRET");
  }

  const conn = new Connection(rpc, "confirmed");

  const results = [];
  for (const w of wallets) {
    try {
      const user = new PublicKey(w);

      // Your builder expects:
      // - authority signer
      // - payer signer
      // - amount is u64 total; your builder computes nextTotal by fetching existing rep
      const { ix } = await buildAddReputationIx({
        conn,
        daoId,
        authority: authority.publicKey,
        payer: payer.publicKey,
        user,
        amount: 1n,
        programId: VINE_REP_PROGRAM_ID,
      });

      const tx = new Transaction().add(ix);

      // IMPORTANT: signers must match keys marked isSigner in the ix:
      // authority and payer are both signers in your ix builder.
      const sig = await sendAndConfirmTransaction(conn, tx, [authority, payer], {
        commitment: "confirmed",
      });

      results.push({ wallet: w, ok: true, sig, url: explorerTx(sig) });
    } catch (e) {
      results.push({ wallet: w, ok: false, error: e.message || String(e) });
    }
  }

  return results;
}

module.exports = { awardOnePointToWallets };