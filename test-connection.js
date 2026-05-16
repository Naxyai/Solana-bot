#!/usr/bin/env node
/**
 * scripts/test-connection.js
 * Run: node scripts/test-connection.js
 * Tests RPC connectivity, wallet access, and Jupiter API.
 */
require('dotenv').config();
const { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } = require('@solana/web3.js');
const fetch  = require('node-fetch');
const bs58   = require('bs58');

const OK  = '\x1b[32m✓\x1b[0m';
const ERR = '\x1b[31m✗\x1b[0m';
const INF = '\x1b[36mℹ\x1b[0m';

async function run() {
  console.log('\n🔍 Solana Arb Bot — Connection Test\n');

  // 1. RPC
  const rpc = process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';
  process.stdout.write(`[1] RPC connectivity (${rpc.slice(0, 50)})… `);
  try {
    const conn    = new Connection(rpc, 'confirmed');
    const slot    = await conn.getSlot();
    const version = await conn.getVersion();
    console.log(`${OK}  slot: ${slot} | solana-core: ${version['solana-core']}`);

    // 2. Wallet
    process.stdout.write('[2] Wallet… ');
    const pk = process.env.WALLET_PRIVATE_KEY;
    if (!pk) { console.log(`${ERR}  WALLET_PRIVATE_KEY not set`); }
    else {
      const kp      = Keypair.fromSecretKey(bs58.decode(pk));
      const lamports = await conn.getBalance(kp.publicKey);
      const sol      = (lamports / LAMPORTS_PER_SOL).toFixed(6);
      console.log(`${OK}  ${kp.publicKey.toBase58()} | ${sol} SOL`);
      if (lamports < 0.1 * LAMPORTS_PER_SOL)
        console.log(`      ${INF} Balance low — need ≥0.1 SOL for gas`);
    }

    // 3. Jupiter
    process.stdout.write('[3] Jupiter v6 API… ');
    const jup = await fetch('https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=100000000&slippageBps=50', { timeout: 5000 });
    if (jup.ok) { console.log(`${OK}  responding`); }
    else        { console.log(`${ERR}  HTTP ${jup.status}`); }

    // 4. Raydium
    process.stdout.write('[4] Raydium API… ');
    const ray = await fetch('https://api-v3.raydium.io/pools/info/list?poolType=all&pageSize=1', { timeout: 5000 });
    console.log(ray.ok ? `${OK}  responding` : `${ERR}  HTTP ${ray.status}`);

    // 5. Orca
    process.stdout.write('[5] Orca API… ');
    const orc = await fetch('https://api.mainnet.orca.so/v1/whirlpool/list', { timeout: 5000 });
    console.log(orc.ok ? `${OK}  responding` : `${ERR}  HTTP ${orc.status}`);

    // 6. Meteora
    process.stdout.write('[6] Meteora API… ');
    const met = await fetch('https://dlmm-api.meteora.ag/pair/all_with_pagination?page=0&limit=1', { timeout: 5000 });
    console.log(met.ok ? `${OK}  responding` : `${ERR}  HTTP ${met.status}`);

    // 7. Jito
    process.stdout.write('[7] Jito block engine… ');
    const jitoUrl = process.env.JITO_ENDPOINT || 'https://mainnet.block-engine.jito.labs.io';
    const jito = await fetch(`${jitoUrl}/api/v1/bundles`, {
      method: 'POST', timeout: 5000,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTipAccounts', params: [] }),
    });
    console.log(jito.ok ? `${OK}  responding` : `${ERR}  HTTP ${jito.status}`);

  } catch (err) {
    console.log(`${ERR}  ${err.message}`);
  }

  console.log('\n✅ Test complete. Fix any ✗ errors above before running the bot.\n');
}

run().catch(console.error);
