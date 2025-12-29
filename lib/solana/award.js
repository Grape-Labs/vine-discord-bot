// lib/solana/award.js
const bs58 = require("bs58");
const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
} = require("@solana/web3.js");

// dynamic import (keeps Next/Vercel happy)
let vineClientPromise;
async function vine() {
  if (!vineClientPromise) vineClientPromise = import("@grapenpm/vine-reputation-client");
  return vineClientPromise;
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

function readU16LE(buf, off) {
  return buf[off] | (buf[off + 1] << 8);
}
function readU64LE(buf, off) {
  let x = 0n;
  for (let i = 7; i >= 0; i--) x = (x << 8n) + BigInt(buf[off + i]);
  return x;
}
function writeU64LE(n) {
  const b = Buffer.alloc(8);
  let x = BigInt(n);
  for (let i = 0; i < 8; i++) {
    b[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return b;
}

// Detect & decode reputation points for BOTH layouts
function decodeRepPoints(data, daoIdExpected) {
  // new layout:
  // disc(8) + version(1) + dao(32) + user(32) + season(2) + points(8) + slot(8) + bump(1) = 92
  if (data.length >= 92) {
    const dao = new PublicKey(data.subarray(9, 9 + 32));
    // If it matches our dao, trust new layout offsets
    if (!daoIdExpected || dao.equals(daoIdExpected)) {
      const season = readU16LE(data, 73 + 0); // season at offset 73
      const points = readU64LE(data, 75);     // points at offset 75
      return { season, points };
    }
  }

  // old layout:
  // disc(8) + version(1) + user(32) + season(2) + points(8) + slot(8) + bump(1)
  if (data.length >= 64) {
    const season = readU16LE(data, 41);
    const points = readU64LE(data, 43);
    return { season, points };
  }

  return { season: null, points: 0n };
}

async function awardOnePoint(wallets) {
  const mod = await vine();
  const {
    VINE_REP_PROGRAM_ID,
    getConfigPda,
    getReputationPda,
    decodeReputationConfig,
    ixDiscriminator,
  } = mod;

  const rpc = mustEnv("SOLANA_RPC_URL");
  const daoId = new PublicKey(mustEnv("VINE_DAO_ID"));

  const authorityKp = keypairFromBs58Env("VINE_AUTHORITY_SECRET");
  const payerKp = authorityKp; // same signer

  const conn = new Connection(rpc, "confirmed");

  // 1) load config to get currentSeason + configPda
  const [configPda] = getConfigPda(daoId, VINE_REP_PROGRAM_ID);
  const cfgAi = await conn.getAccountInfo(configPda, "confirmed");
  if (!cfgAi?.data) throw new Error("Config PDA not found for this DAO.");
  const cfg = await decodeReputationConfig(cfgAi.data);
  const season = Number(cfg.currentSeason);

  // 2) discriminator once
  const disc = await ixDiscriminator("addReputation");

  const results = [];
  for (const w of wallets) {
    try {
      const user = new PublicKey(w);

      const [repPda] = getReputationPda(configPda, user, season, VINE_REP_PROGRAM_ID);

      // Read current points safely (new or old layout)
      const repAi = await conn.getAccountInfo(repPda, "confirmed");
      let current = 0n;
      if (repAi?.data?.length) {
        const decoded = decodeRepPoints(repAi.data, daoId);
        current = decoded.points ?? 0n;
      }

      const nextTotal = current + 1n;

      // Instruction data = disc(8) + total(u64)
      const data = Buffer.concat([Buffer.from(disc), writeU64LE(nextTotal)]);

      const ix = new TransactionInstruction({
        programId: VINE_REP_PROGRAM_ID,
        keys: [
          { pubkey: configPda,               isSigner: false, isWritable: false },
          { pubkey: authorityKp.publicKey,   isSigner: true,  isWritable: false },
          { pubkey: user,                    isSigner: false, isWritable: false },
          { pubkey: repPda,                  isSigner: false, isWritable: true  },
          { pubkey: payerKp.publicKey,       isSigner: true,  isWritable: true  },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data,
      });

      const tx = new Transaction().add(ix);

      const sig = await sendAndConfirmTransaction(conn, tx, [authorityKp], {
        commitment: "confirmed",
      });

      results.push({ wallet: w, ok: true, sig, url: txUrl(sig), nextTotal: String(nextTotal) });
    } catch (e) {
      results.push({ wallet: w, ok: false, error: e?.message || String(e) });
    }
  }

  return results;
}

module.exports = { awardOnePoint };