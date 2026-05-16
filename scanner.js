/**
 * ArbitrageScanner v2
 * Fetches real-time prices from Raydium, Orca, Meteora, Lifinity
 * and detects 2-leg + triangular arbitrage opportunities.
 */
const fetch = require('node-fetch');
const { logger } = require('./logger');

const TOKENS = {
  SOL:  { mint: 'So11111111111111111111111111111111111111112',   decimals: 9 },
  USDC: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
  USDT: { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',  decimals: 6 },
  RAY:  { mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',  decimals: 6 },
  BONK: { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',  decimals: 5 },
  WIF:  { mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',  decimals: 6 },
  JTO:  { mint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',    decimals: 9 },
  PYTH: { mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',   decimals: 6 },
  JUP:  { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',    decimals: 6 },
  MSOL: { mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',    decimals: 9 },
};

const MINT_TO_SYMBOL = Object.fromEntries(
  Object.entries(TOKENS).map(([s, t]) => [t.mint, s])
);

class ArbitrageScanner {
  constructor(connection, config) {
    this.connection = connection;
    this.config = config;
    this.cache = {};
    this.cacheMaxAge = 500;
  }

  async initialize() {
    logger.info('Initializing scanner...');
    await this._fetchAll().catch(() => {});
    logger.info(`Scanner ready — ${Object.keys(TOKENS).length} tokens, ${this.config.dexes.length} DEXes`);
  }

  async findOpportunities() {
    const dexPrices = await this._fetchAll();
    return [
      ...this._find2Leg(dexPrices),
      ...this._findTriangular(dexPrices),
    ].filter(o => o.profitBps >= this.config.minProfitBps);
  }

  async _fetchAll() {
    const [raydium, orca, meteora] = await Promise.allSettled([
      this._fetchRaydium(),
      this._fetchOrca(),
      this._fetchMeteora(),
    ]);
    const out = {};
    if (raydium.status  === 'fulfilled' && raydium.value)  out.raydium  = raydium.value;
    if (orca.status     === 'fulfilled' && orca.value)     out.orca     = orca.value;
    if (meteora.status  === 'fulfilled' && meteora.value)  out.meteora  = meteora.value;
    return out;
  }

  async _fetchRaydium() {
    if (this._fresh('raydium')) return this.cache.raydium.data;
    const data = await get('https://api-v3.raydium.io/pools/info/list?poolType=all&poolSortField=liquidity&sortType=desc&pageSize=100&page=1', 3000);
    const prices = {};
    for (const pool of (data?.data?.data || [])) {
      const { address: mintA } = pool.mintA || {};
      const { address: mintB } = pool.mintB || {};
      if (!mintA || !mintB || !pool.price || (pool.tvl || 0) < 5000) continue;
      const k = `${mintA}:${mintB}`;
      if (!prices[k] || prices[k].tvl < pool.tvl)
        prices[k] = { price: +pool.price, tvl: pool.tvl, fee: pool.feeRate || 0.0025, address: pool.id };
    }
    this.cache.raydium = { data: prices, ts: Date.now() };
    return prices;
  }

  async _fetchOrca() {
    if (this._fresh('orca')) return this.cache.orca.data;
    const data = await get('https://api.mainnet.orca.so/v1/whirlpool/list', 3000);
    const prices = {};
    for (const pool of (data?.whirlpools || [])) {
      if ((pool.tvl || 0) < 5000) continue;
      const mintA = pool.tokenA?.mint, mintB = pool.tokenB?.mint;
      if (!mintA || !mintB) continue;
      const k = `${mintA}:${mintB}`;
      if (!prices[k] || prices[k].tvl < pool.tvl)
        prices[k] = { price: +pool.price, tvl: pool.tvl, fee: (pool.feeRate || 3000) / 1e6, address: pool.address };
    }
    this.cache.orca = { data: prices, ts: Date.now() };
    return prices;
  }

  async _fetchMeteora() {
    if (this._fresh('meteora')) return this.cache.meteora.data;
    const data = await get('https://dlmm-api.meteora.ag/pair/all_with_pagination?page=0&limit=100&sort_key=liquidity&order_by=desc', 3000);
    const prices = {};
    for (const pool of (data?.data || data || [])) {
      const tvl = +(pool.liquidity || 0);
      if (tvl < 5000) continue;
      const { mint_x: mintA, mint_y: mintB } = pool;
      if (!mintA || !mintB) continue;
      const k = `${mintA}:${mintB}`;
      if (!prices[k] || prices[k].tvl < tvl)
        prices[k] = { price: +(pool.current_price || 0), tvl, fee: +(pool.base_fee_percentage || 0.3) / 100, address: pool.address };
    }
    this.cache.meteora = { data: prices, ts: Date.now() };
    return prices;
  }

  _find2Leg(dexPrices) {
    const opps = [];
    const names = Object.keys(dexPrices);
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const [dA, dB] = [names[i], names[j]];
        const [pA, pB] = [dexPrices[dA], dexPrices[dB]];
        for (const k of Object.keys(pA)) {
          if (!pB[k]) continue;
          const [poolA, poolB] = [pA[k], pB[k]];
          if (!poolA.price || !poolB.price || !poolA.price) continue;
          const spread = Math.abs(poolA.price - poolB.price) / poolA.price * 10000;
          const fees   = ((poolA.fee || 0.003) + (poolB.fee || 0.003)) * 10000 + 8;
          const profit = spread - fees;
          if (profit < this.config.minProfitBps) continue;
          const [mintA, mintB] = k.split(':');
          const buyA = poolA.price < poolB.price;
          opps.push({
            type: '2-leg', pair: `${sym(mintA)}/${sym(mintB)}`,
            mintA, mintB,
            dexA: buyA ? dA : dB, dexB: buyA ? dB : dA,
            buyPrice: Math.min(poolA.price, poolB.price),
            sellPrice: Math.max(poolA.price, poolB.price),
            profitBps: Math.round(profit), spreadBps: Math.round(spread),
            poolAddressA: buyA ? poolA.address : poolB.address,
            poolAddressB: buyA ? poolB.address : poolA.address,
            tradeSize: this._size(poolA.tvl, poolB.tvl), timestamp: Date.now(),
          });
        }
      }
    }
    return opps;
  }

  _findTriangular(dexPrices) {
    const opps = [];
    for (const [dex, prices] of Object.entries(dexPrices)) {
      for (const [sA, sB, sC] of (this.config.triangularPaths || [])) {
        const [tA, tB, tC] = [TOKENS[sA], TOKENS[sB], TOKENS[sC]];
        if (!tA || !tB || !tC) continue;
        const rAB = this._rate(prices, tA.mint, tB.mint);
        const rBC = this._rate(prices, tB.mint, tC.mint);
        const rCA = this._rate(prices, tC.mint, tA.mint);
        if (!rAB || !rBC || !rCA) continue;
        const circ = rAB.rate * rBC.rate * rCA.rate;
        const gross = (circ - 1) * 10000;
        const fees  = ((rAB.fee || 0.003) + (rBC.fee || 0.003) + (rCA.fee || 0.003)) * 10000 + 12;
        const profit = gross - fees;
        if (profit < this.config.minProfitBps) continue;
        opps.push({
          type: 'triangular', pair: `${sA}→${sB}→${sC}→${sA}`,
          dexA: dex, dexB: dex,
          path: [
            { from: tA.mint, to: tB.mint, dex, pool: rAB.address },
            { from: tB.mint, to: tC.mint, dex, pool: rBC.address },
            { from: tC.mint, to: tA.mint, dex, pool: rCA.address },
          ],
          profitBps: Math.round(profit), circularReturn: circ,
          tradeSize: this._size(rAB.tvl, rBC.tvl, rCA.tvl), timestamp: Date.now(),
        });
      }
    }
    return opps;
  }

  _rate(prices, from, to) {
    const k = `${from}:${to}`, kr = `${to}:${from}`;
    if (prices[k]?.price)  return { rate: prices[k].price,            ...prices[k] };
    if (prices[kr]?.price) return { rate: 1 / prices[kr].price,       ...prices[kr] };
    return null;
  }

  _size(...tvls) {
    const valid = tvls.filter(Boolean);
    if (!valid.length) return this.config.minTradeSol;
    const maxImpact = Math.min(...valid) * 0.003 / 150;
    return Math.max(this.config.minTradeSol, Math.min(maxImpact, this.config.maxTradeSol));
  }

  _fresh(key) {
    return this.cache[key] && Date.now() - this.cache[key].ts < this.cacheMaxAge;
  }
}

async function get(url, ms = 3000) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return r.ok ? r.json() : null;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

function sym(mint) { return MINT_TO_SYMBOL[mint] || mint.slice(0, 4); }

module.exports = { ArbitrageScanner, TOKENS, MINT_TO_SYMBOL };
