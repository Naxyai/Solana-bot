/**
 * ArbitrageExecutor v2
 * 
 * Builds and submits transactions via:
 *  - Jupiter v6 API (quote + swap)
 *  - Jito block engine (atomic bundles, MEV protection)
 *  - Direct RPC fallback
 */
const {
  PublicKey, VersionedTransaction, TransactionMessage,
  SystemProgram, LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const fetch  = require('node-fetch');
const { logger } = require('./logger');

const JUPITER_API   = 'https://quote-api.jup.ag/v6';
// Jito tip accounts (rotating for load balance)
const JITO_TIPS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt13iQ32He',
];

const DEX_FILTER = {
  raydium:  'Raydium,RaydiumClmm,RaydiumCp',
  orca:     'Whirlpool',
  meteora:  'Meteora,MeteoraAGLP,MeteoraDLMM',
  lifinity: 'Lifinity',
  saber:    'Saber',
};

class ArbitrageExecutor {
  constructor(connection, wallet, config, blockhashMgr) {
    this.connection   = connection;
    this.wallet       = wallet;
    this.config       = config;
    this.blockhashMgr = blockhashMgr;
  }

  async initialize() {
    logger.info('Executor ready (Jupiter v6 + Jito bundles)');
  }

  // ─── MAIN ENTRY ─────────────────────────────────────────────────────────────
  async execute(opp) {
    const t0 = Date.now();
    try {
      if (opp.type === '2-leg')      return await this._exec2Leg(opp, t0);
      if (opp.type === 'triangular') return await this._execTriangular(opp, t0);
      return { success: false, error: 'Unknown opportunity type' };
    } catch (err) {
      return { success: false, error: err.message, latencyMs: Date.now() - t0 };
    }
  }

  // ─── 2-LEG ──────────────────────────────────────────────────────────────────
  async _exec2Leg(opp, t0) {
    const inputLamports = Math.floor(opp.tradeSize * LAMPORTS_PER_SOL);

    // Get quotes for both legs simultaneously
    const [buyQuote, ] = await Promise.all([
      this._quote(opp.mintA, opp.mintB, inputLamports, opp.dexA),
    ]);
    if (!buyQuote) return { success: false, error: 'No buy quote', latencyMs: Date.now()-t0 };

    const sellQuote = await this._quote(opp.mintB, opp.mintA, +buyQuote.outAmount, opp.dexB);
    if (!sellQuote) return { success: false, error: 'No sell quote', latencyMs: Date.now()-t0 };

    // Verify actual profitability from real quotes
    const netProfit = +sellQuote.outAmount - inputLamports;
    if (netProfit <= 0)
      return { success: false, error: 'Quote shows no profit (stale opportunity)', profitLamports: 0, latencyMs: Date.now()-t0 };

    const actualBps = netProfit / inputLamports * 10000;
    if (actualBps < this.config.minProfitBps * 0.5)
      return { success: false, error: `Below min profit after quotes: ${actualBps.toFixed(1)}bps`, profitLamports: 0, latencyMs: Date.now()-t0 };

    // Build transactions
    const [buyTx, sellTx] = await Promise.all([
      this._buildSwapTx(buyQuote),
      this._buildSwapTx(sellQuote),
    ]);
    if (!buyTx || !sellTx)
      return { success: false, error: 'Transaction build failed', latencyMs: Date.now()-t0 };

    // Submit atomically via Jito
    const result = await this._submitBundle([buyTx, sellTx]);
    return { ...result, profitLamports: netProfit, profitBps: actualBps, latencyMs: Date.now()-t0 };
  }

  // ─── TRIANGULAR ─────────────────────────────────────────────────────────────
  async _execTriangular(opp, t0) {
    const inputLamports = Math.floor(opp.tradeSize * LAMPORTS_PER_SOL);
    let current = inputLamports;
    const quotes = [];

    // Sequential quotes (each leg depends on previous output)
    for (const leg of opp.path) {
      const q = await this._quote(leg.from, leg.to, current, leg.dex);
      if (!q) return { success: false, error: `No quote for leg ${leg.from}→${leg.to}`, latencyMs: Date.now()-t0 };
      quotes.push(q);
      current = +q.outAmount;
    }

    const netProfit = current - inputLamports;
    if (netProfit <= 0)
      return { success: false, error: 'Triangular quote shows no profit', profitLamports: 0, latencyMs: Date.now()-t0 };

    const txs = await Promise.all(quotes.map(q => this._buildSwapTx(q)));
    if (txs.some(tx => !tx))
      return { success: false, error: 'One or more legs failed to build', latencyMs: Date.now()-t0 };

    const result = await this._submitBundle(txs);
    return { ...result, profitLamports: netProfit, profitBps: netProfit/inputLamports*10000, latencyMs: Date.now()-t0 };
  }

  // ─── JUPITER QUOTE ──────────────────────────────────────────────────────────
  async _quote(inputMint, outputMint, amount, dex) {
    const dexFilter  = DEX_FILTER[dex?.toLowerCase()] || '';
    const dexParam   = dexFilter ? `&dexes=${encodeURIComponent(dexFilter)}` : '';
    const url = `${JUPITER_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${this.config.slippageBps}&onlyDirectRoutes=true${dexParam}`;

    try {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  // ─── BUILD SWAP TX ──────────────────────────────────────────────────────────
  async _buildSwapTx(quote) {
    try {
      const body = {
        quoteResponse:             quote,
        userPublicKey:             this.wallet.publicKey.toString(),
        wrapAndUnwrapSol:          true,
        useSharedAccounts:         true,
        asLegacyTransaction:       false,
        computeUnitPriceMicroLamports: this.config.priorityFee === 'auto' ? 'auto' : +this.config.priorityFee,
        dynamicComputeUnitLimit:   true,
      };

      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2000);
      const res   = await fetch(`${JUPITER_API}/swap`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
        signal:  ctrl.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        const errText = await res.text();
        logger.debug('Swap build error:', errText.slice(0, 100));
        return null;
      }

      const { swapTransaction } = await res.json();
      const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
      tx.sign([this.wallet]);
      return tx;
    } catch (err) {
      logger.debug('buildSwapTx error:', err.message);
      return null;
    }
  }

  // ─── JITO BUNDLE ────────────────────────────────────────────────────────────
  async _submitBundle(txs) {
    // Attach Jito tip
    const tipTx = await this._tipTx();
    const bundle = [...txs, tipTx].filter(Boolean);

    const serialized = bundle.map(tx => Buffer.from(tx.serialize()).toString('base64'));

    try {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(`${this.config.jitoEndpoint}/api/v1/bundles`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendBundle', params: [serialized] }),
        signal:  ctrl.signal,
      });
      clearTimeout(timer);

      const data = await res.json();
      if (data.error) {
        logger.debug('Jito error:', data.error.message, '— falling back to RPC');
        return await this._submitRpc(txs[0]);
      }

      const status = await this._pollBundle(data.result);
      return status;

    } catch (err) {
      logger.debug('Jito bundle failed, RPC fallback:', err.message);
      return await this._submitRpc(txs[0]);
    }
  }

  async _pollBundle(bundleId, maxTries = 12) {
    for (let i = 0; i < maxTries; i++) {
      await sleep(400);
      try {
        const res = await fetch(`${this.config.jitoEndpoint}/api/v1/bundles`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBundleStatuses', params: [[bundleId]] }),
        });
        const data = await res.json();
        const s    = data.result?.value?.[0];
        if (!s) continue;
        if (s.confirmation_status === 'confirmed' || s.confirmation_status === 'finalized')
          return { success: true, signature: s.transactions?.[0], bundleId };
        if (s.err)
          return { success: false, error: JSON.stringify(s.err), bundleId };
      } catch {}
    }
    return { success: false, error: 'Bundle poll timeout', bundleId };
  }

  async _submitRpc(tx) {
    if (!tx) return { success: false, error: 'No transaction' };
    try {
      const sig = await this.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false, preflightCommitment: 'processed', maxRetries: this.config.txRetryCount,
      });
      const { blockhash, lastValidBlockHeight } = this.blockhashMgr.get();
      const conf = await this.connection.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight }, 'confirmed'
      );
      if (conf.value.err) return { success: false, error: JSON.stringify(conf.value.err) };
      return { success: true, signature: sig };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async _tipTx() {
    try {
      const tipAccount = JITO_TIPS[Math.floor(Math.random() * JITO_TIPS.length)];
      const { blockhash } = this.blockhashMgr.get();
      const msg = new TransactionMessage({
        payerKey:       this.wallet.publicKey,
        recentBlockhash: blockhash,
        instructions:  [SystemProgram.transfer({
          fromPubkey: this.wallet.publicKey,
          toPubkey:   new PublicKey(tipAccount),
          lamports:   this.config.jitoTipLamports,
        })],
      }).compileToV0Message();
      const tx = new VersionedTransaction(msg);
      tx.sign([this.wallet]);
      return tx;
    } catch { return null; }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { ArbitrageExecutor };
