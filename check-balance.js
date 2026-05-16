#!/usr/bin/env node
/**
 * scripts/check-balance.js
 * Shows SOL + token balances for configured wallet.
 */
require('dotenv').config();
const { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } = require('@solana/web3.js');
const { getAssociatedTokenAddress, getAccount } = require('@solana/spl-token');
const bs58 = require('bs58');

const TOKENS = {
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  RAY:  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  JUP:  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
};
const DECIMALS = { USDC: 6, USDT: 6, RAY: 6, BONK: 5, JUP: 6 };

async function run() {
  const pk  = process.env.WALLET_PRIVATE_KEY;
  if (!pk) { console.error('WALLET_PRIVATE_KEY not set'); process.exit(1); }

  const conn   = new Connection(process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com', 'confirmed');
  const wallet = Keypair.fromSecretKey(bs58.decode(pk));
  const pub    = wallet.publicKey;

  console.log(`\n💳 Wallet: ${pub.toBase58()}\n`);

  const sol = await conn.getBalance(pub);
  console.log(`   SOL   : ${(sol / LAMPORTS_PER_SOL).toFixed(6)}`);

  for (const [sym, mint] of Object.entries(TOKENS)) {
    try {
      const ata  = await getAssociatedTokenAddress(new PublicKey(mint), pub);
      const acct = await getAccount(conn, ata);
      const amt  = Number(acct.amount) / 10 ** (DECIMALS[sym] || 6);
      console.log(`   ${sym.padEnd(6)}: ${amt.toFixed(DECIMALS[sym] || 2)}`);
    } catch {
      console.log(`   ${sym.padEnd(6)}: 0 (no account)`);
    }
  }
  console.log();
}

run().catch(console.error);
