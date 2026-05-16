/**
 * SOLANA HIGH-FREQUENCY ARBITRAGE BOT v2.0
 * Strategy: 2-leg cross-DEX + triangular arbitrage
 * Execution: Jito bundles + Jupiter v6 routing
 * ⚠️  REAL FUNDS — test on devnet first (NETWORK=devnet)
 */
require('dotenv').config();
const { Connection, Keypair, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const bs58 = require('bs58');

const { ArbitrageScanner }  = require('./scanner');
const { ArbitrageExecutor } = require('./executor');
const { RiskManager }       = require('./riskManager');
const { ProfitTracker }     = require('./profitTracker');
const { logger }            = require('./logger');
const { DashboardEmitter }  = require('./dashboardEmitter');
const { BlockhashManager }  = require('./blockhashManager');

const CONFIG = {
  network:         process.env.NETWORK || 'mainnet',
  rpcEndpoint:     process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com',
  rpcWsEndpoint:   process.env.RPC_WS_ENDPOINT || 'wss://api.mainnet-beta.solana.com',
  jitoEndpoint:    process.env.JITO_ENDPOINT || 'https://mainnet.block-engine.jito.labs.io',
  jitoTipLamports: parseInt(process.env.JITO_TIP_LAMPORTS || '10000'),
  privateKey:      process.env.WALLET_PRIVATE_KEY,
  minProfitBps:    parseInt(process.env.MIN_PROFIT_BPS || '40'),
  maxTradeSol:     parseFloat(process.env.MAX_TRADE_SOL || '0.5'),
  minTradeSol:     parseFloat(process.env.MIN_TRADE_SOL || '0.05'),
  slippageBps:     parseInt(process.env.SLIPPAGE_BPS || '50'),
  maxConcurrent:   parseInt(process.env.MAX_CONCURRENT || '2'),
  scanIntervalMs:  parseInt(process.env.SCAN_INTERVAL_MS || '150'),
  maxDailyLossSol: parseFloat(process.env.MAX_DAILY_LOSS_SOL || '0.3'),
  maxPositionSol:  parseFloat(process.env.MAX_POSITION_SOL || '1.0'),
  maxConsecLosses: parseInt(process.env.MAX_CONSECUTIVE_LOSSES || '5'),
  priorityFee:     process.env.PRIORITY_FEE_MICROLAMPORTS || 'auto',
  dryRun:          process.env.DRY_RUN === 'true',
  debug:           process.env.DEBUG === 'true',
  useJupiterOnly:  process.env.USE_JUPITER_ONLY !== 'false',
  txRetryCount:    parseInt(process.env.TX_RETRY_COUNT || '2'),
  dashboardPort:   parseInt(process.env.DASHBOARD_PORT || '3000'),
  tokenPairs: [
    { base: 'SOL',  quote: 'USDC' }, { base: 'SOL',  quote: 'USDT' },
    { base: 'RAY',  quote: 'USDC' }, { base: 'RAY',  quote: 'SOL'  },
    { base: 'BONK', quote: 'SOL'  }, { base: 'BONK', quote: 'USDC' },
    { base: 'WIF',  quote: 'SOL'  }, { base: 'WIF',  quote: 'USDC' },
    { base: 'JTO',  quote: 'SOL'  }, { base: 'JTO',  quote: 'USDC' },
    { base: 'PYTH', quote: 'USDC' }, { base: 'JUP',  quote: 'USDC' },
    { base: 'JUP',  quote: 'SOL'  }, { base: 'MSOL', quote: 'SOL'  },
    { base: 'USDC', quote: 'USDT' },
  ],
  dexes: ['raydium', 'orca', 'meteora', 'lifinity'],
  triangularPaths: [
    ['SOL','USDC','RAY'], ['SOL','USDC','JUP'],  ['SOL','USDC','BONK'],
    ['SOL','USDC','WIF'], ['SOL','USDC','JTO'],  ['SOL','USDT','USDC'],
    ['SOL','MSOL','USDC'],['RAY','USDC','BONK'], ['JUP','USDC','WIF'],
  ],
};

class SolanaArbBot {
  constructor(cfg) {
    this.cfg = cfg;
    this.isRunning = false;
    this.isPaused  = false;
    this.activeTrades = new Map();
    this.stats = {
      scans: 0, opportunitiesFound: 0,
      tradesAttempted: 0, tradesSucceeded: 0,
      profitLamports: BigInt(0), startTime: Date.now(),
      lastTradeTime: null, bestTradeBps: 0, recentTrades: [],
    };
  }

  async initialize() {
    logger.banner();
    logger.info(`Network: ${this.cfg.network.toUpperCase()}`);
    if (this.cfg.dryRun) logger.warn('DRY RUN — no real transactions');

    if (!this.cfg.privateKey) throw new Error('WALLET_PRIVATE_KEY not set in .env');
    if (this.cfg.rpcEndpoint.includes('api.mainnet-beta.solana.com'))
      logger.warn('Public RPC detected — use a premium RPC for production!');

    this.connection = new Connection(this.cfg.rpcEndpoint, {
      commitment: 'confirmed', wsEndpoint: this.cfg.rpcWsEndpoint,
      confirmTransactionInitialTimeout: 60000,
    });

    const secretKey = bs58.decode(this.cfg.privateKey);
    this.wallet = Keypair.fromSecretKey(secretKey);
    logger.info(`Wallet: ${this.wallet.publicKey.toBase58()}`);

    const lamports   = await this.connection.getBalance(this.wallet.publicKey);
    const balanceSol = lamports / LAMPORTS_PER_SOL;
    logger.info(`Balance: ${balanceSol.toFixed(6)} SOL`);
    if (balanceSol < 0.05) throw new Error(`Insufficient balance (${balanceSol} SOL)`);

    this.blockhashMgr  = new BlockhashManager(this.connection);
    this.scanner       = new ArbitrageScanner(this.connection, this.cfg);
    this.executor      = new ArbitrageExecutor(this.connection, this.wallet, this.cfg, this.blockhashMgr);
    this.riskManager   = new RiskManager(this.cfg, balanceSol);
    this.profitTracker = new ProfitTracker();
    this.dashboard     = new DashboardEmitter(this.cfg.dashboardPort);

    await this.blockhashMgr.start();
    await this.scanner.initialize();
    await this.executor.initialize();
    await this.dashboard.start();

    logger.info(`Scanning ${this.cfg.tokenPairs.length} pairs × ${this.cfg.dexes.length} DEXes`);
    logger.info(`Min profit: ${this.cfg.minProfitBps/100}% | Max trade: ${this.cfg.maxTradeSol} SOL`);
    logger.info(`Dashboard: http://localhost:${this.cfg.dashboardPort}`);
    logger.success('Bot initialized — starting scan loop');
  }

  async start() {
    this.isRunning = true;
    while (this.isRunning) {
      const t0 = Date.now();
      if (!this.isPaused) {
        try { await this._scanCycle(); }
        catch (err) { logger.error('Scan error:', err.message); }
      }
      this.stats.scans++;
      if (this.stats.scans % 10  === 0) this.dashboard.emit('stats', this._buildStats());
      if (this.stats.scans % 200 === 0) this._printStats();
      const wait = Math.max(0, this.cfg.scanIntervalMs - (Date.now() - t0));
      if (wait > 0) await sleep(wait);
    }
  }

  async _scanCycle() {
    const risk = this.riskManager.getStatus();
    if (risk.blocked) {
      if (!this._lastBlockLog || Date.now() - this._lastBlockLog > 10000) {
        logger.warn(`Risk gate: ${risk.reason}`);
        this._lastBlockLog = Date.now();
        this.dashboard.emit('risk', risk);
      }
      return;
    }

    const opps = await this.scanner.findOpportunities();
    if (!opps.length) return;

    this.stats.opportunitiesFound += opps.length;
    this.dashboard.emit('opportunities', opps.slice(0, 10));

    opps.sort((a, b) => b.profitBps - a.profitBps);
    const slots = this.cfg.maxConcurrent - this.activeTrades.size;
    await Promise.allSettled(opps.slice(0, slots).map(o => this._executeTrade(o)));
  }

  async _executeTrade(opp) {
    const v = this.riskManager.validate(opp);
    if (!v.ok) { logger.debug(`Blocked: ${v.reason}`); return; }

    const id = `${opp.pair}-${Date.now()}`;
    this.activeTrades.set(id, opp);
    this.stats.tradesAttempted++;

    try {
      logger.trade(`⚡ ${opp.type.padEnd(11)} | ${opp.pair.padEnd(22)} | ${(opp.profitBps/100).toFixed(3).padStart(7)}% | ${opp.tradeSize.toFixed(4)} SOL`);

      const result = this.cfg.dryRun
        ? { success: true, profitLamports: Math.floor(opp.tradeSize * LAMPORTS_PER_SOL * opp.profitBps / 10000),
            profitBps: opp.profitBps, latencyMs: Math.random()*80+20|0, signature: 'DRY_RUN_'+Math.random().toString(36).slice(2) }
        : await this.executor.execute(opp);

      if (result.success) {
        this.stats.tradesSucceeded++;
        this.stats.profitLamports += BigInt(Math.max(0, result.profitLamports));
        this.stats.lastTradeTime   = Date.now();
        if (result.profitBps > this.stats.bestTradeBps) this.stats.bestTradeBps = result.profitBps;
        this.riskManager.recordWin(result);
        this.profitTracker.record({ ...result, opp });
        const ps = (result.profitLamports / LAMPORTS_PER_SOL).toFixed(6);
        logger.success(`✅ +${ps} SOL | ${result.latencyMs}ms | ${result.signature?.slice(0,16)}…`);
        const t = { ...result, opp, status: 'success', ts: Date.now() };
        this.stats.recentTrades.unshift(t);
        if (this.stats.recentTrades.length > 50) this.stats.recentTrades.pop();
        this.dashboard.emit('trade', t);
      } else {
        logger.warn(`❌ Failed: ${result.error}`);
        this.riskManager.recordLoss(result);
        this.dashboard.emit('trade', { ...result, opp, status: 'failed', ts: Date.now() });
      }
    } catch (err) {
      logger.error(`Trade error: ${err.message}`);
      this.riskManager.recordLoss({ error: err.message });
    } finally {
      this.activeTrades.delete(id);
    }
  }

  _buildStats() {
    const runtime = Date.now() - this.stats.startTime;
    const profitSol = Number(this.stats.profitLamports) / LAMPORTS_PER_SOL;
    const winRate = this.stats.tradesAttempted > 0
      ? (this.stats.tradesSucceeded / this.stats.tradesAttempted * 100).toFixed(1) : '0.0';
    return {
      uptime: runtime, scans: this.stats.scans,
      opportunitiesFound: this.stats.opportunitiesFound,
      tradesAttempted: this.stats.tradesAttempted,
      tradesSucceeded: this.stats.tradesSucceeded,
      winRate, profitSol: profitSol.toFixed(6),
      bestTradeBps: this.stats.bestTradeBps,
      tradesPerMin: (this.stats.tradesAttempted / (runtime / 60000)).toFixed(2),
      riskStatus: this.riskManager.getStatus(),
      recentTrades: this.stats.recentTrades.slice(0, 20),
      activeTrades: this.activeTrades.size,
      dryRun: this.cfg.dryRun, network: this.cfg.network,
      walletAddress: this.wallet?.publicKey.toBase58(),
    };
  }

  _printStats() {
    const s = this._buildStats();
    const r = Math.floor(s.uptime / 1000);
    logger.info('─'.repeat(65));
    logger.info(`📊  ${Math.floor(r/3600)}h ${Math.floor(r%3600/60)}m ${r%60}s | Scans: ${s.scans.toLocaleString()}`);
    logger.info(`    Trades: ${s.tradesSucceeded}/${s.tradesAttempted} | Win: ${s.winRate}% | Profit: ${s.profitSol} SOL`);
    logger.info('─'.repeat(65));
  }

  pause()  { this.isPaused = true;  logger.warn('Bot paused'); }
  resume() { this.isPaused = false; logger.info('Bot resumed'); }
  stop()   { this.isRunning = false; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const bot = new SolanaArbBot(CONFIG);
  process.on('SIGINT',  () => { bot.stop(); setTimeout(() => process.exit(0), 1500); });
  process.on('SIGTERM', () => { bot.stop(); setTimeout(() => process.exit(0), 1500); });
  process.on('uncaughtException',  e => logger.error('Uncaught:', e.message));
  process.on('unhandledRejection', e => logger.error('Unhandled:', e));
  await bot.initialize();
  await bot.start();
}

main();
