// ═══════════════════════════════════════════════════════════
//  riskManager.js
// ═══════════════════════════════════════════════════════════
class RiskManager {
  constructor(cfg, initBalSol) {
    this.cfg             = cfg;
    this.initBalSol      = initBalSol;
    this.dailyPnl        = 0;
    this.consecLosses    = 0;
    this.tradesToday     = 0;
    this.dayKey          = today();
    this._blocked        = false;
    this._blockReason    = '';
    console.log(`[Risk] Init balance: ${initBalSol} SOL | max loss/day: ${cfg.maxDailyLossSol} SOL`);
  }

  getStatus() {
    this._maybeReset();
    if (Math.abs(Math.min(this.dailyPnl, 0)) >= this.cfg.maxDailyLossSol)
      return { blocked: true, reason: `Daily loss limit (${this.cfg.maxDailyLossSol} SOL)` };
    if (this.consecLosses >= this.cfg.maxConsecLosses)
      return { blocked: true, reason: `${this.consecLosses} consecutive losses — circuit breaker` };
    return { blocked: false, dailyPnl: this.dailyPnl, consecLosses: this.consecLosses, tradesToday: this.tradesToday };
  }

  validate(opp) {
    if (opp.profitBps > 2000) return { ok: false, reason: 'Profit >20% — likely stale data' };
    if (opp.tradeSize < this.cfg.minTradeSol) return { ok: false, reason: 'Below min trade size' };
    if (opp.tradeSize > this.cfg.maxTradeSol) opp.tradeSize = this.cfg.maxTradeSol;
    return { ok: true };
  }

  recordWin(result)  {
    this._maybeReset();
    const sol = (result.profitLamports || 0) / 1e9;
    this.dailyPnl += sol; this.consecLosses = 0; this.tradesToday++;
  }

  recordLoss(result) {
    this._maybeReset();
    this.consecLosses++; this.tradesToday++;
    this.dailyPnl -= 0.000005; // small estimate for failed tx cost
  }

  _maybeReset() {
    if (today() !== this.dayKey) {
      this.dailyPnl = 0; this.tradesToday = 0; this.consecLosses = 0; this.dayKey = today();
    }
  }
}

function today() { return new Date().toDateString(); }

// ═══════════════════════════════════════════════════════════
//  profitTracker.js
// ═══════════════════════════════════════════════════════════
const fs   = require('fs');
const path = require('path');

class ProfitTracker {
  constructor() {
    this.logDir      = path.join(process.cwd(), 'logs');
    this.totalSol    = 0;
    this.totalTrades = 0;
    if (!fs.existsSync(this.logDir)) fs.mkdirSync(this.logDir, { recursive: true });
    this.file = path.join(this.logDir, `trades-${new Date().toISOString().split('T')[0]}.ndjson`);
  }

  record(result) {
    const sol = (result.profitLamports || 0) / 1e9;
    this.totalSol += sol; this.totalTrades++;
    const entry = {
      ts:        new Date().toISOString(),
      sig:       result.signature,
      pair:      result.opp?.pair,
      type:      result.opp?.type,
      profitSol: sol.toFixed(9),
      profitBps: result.profitBps?.toFixed(2),
      latencyMs: result.latencyMs,
      cumSol:    this.totalSol.toFixed(9),
    };
    try { fs.appendFileSync(this.file, JSON.stringify(entry) + '\n'); } catch {}
  }

  summary() {
    return { totalTrades: this.totalTrades, totalSol: this.totalSol };
  }
}

// ═══════════════════════════════════════════════════════════
//  logger.js
// ═══════════════════════════════════════════════════════════
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m', magenta: '\x1b[35m', gray: '\x1b[90m',
};

const logger = {
  banner() {
    console.log(`${C.cyan}${C.bold}`);
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║     SOLANA HIGH-FREQUENCY ARBITRAGE BOT v2.0        ║');
    console.log('║     Raydium · Orca · Meteora · Jito Bundles         ║');
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log(C.reset);
  },
  info:    (m, ...a) => console.log(`${C.cyan}[INFO ]${C.reset} ${m}`, ...a),
  success: (m, ...a) => console.log(`${C.green}[WIN  ]${C.reset} ${m}`, ...a),
  warn:    (m, ...a) => console.log(`${C.yellow}[WARN ]${C.reset} ${m}`, ...a),
  error:   (m, ...a) => console.log(`${C.red}[ERROR]${C.reset} ${m}`, ...a),
  trade:   (m, ...a) => console.log(`${C.magenta}[TRADE]${C.reset} ${m}`, ...a),
  debug:   (m, ...a) => { if (process.env.DEBUG === 'true') console.log(`${C.gray}[DEBUG]${C.reset} ${m}`, ...a); },
};

// ═══════════════════════════════════════════════════════════
//  blockhashManager.js
// ═══════════════════════════════════════════════════════════
class BlockhashManager {
  constructor(connection) {
    this.connection = connection;
    this.current    = { blockhash: '', lastValidBlockHeight: 0 };
    this._interval  = null;
  }

  async start() {
    await this._refresh();
    this._interval = setInterval(() => this._refresh(), 20_000);
  }

  get() { return this.current; }

  async _refresh() {
    try {
      const { blockhash, lastValidBlockHeight } =
        await this.connection.getLatestBlockhash('confirmed');
      this.current = { blockhash, lastValidBlockHeight };
    } catch (err) {
      logger.debug('Blockhash refresh error:', err.message);
    }
  }

  stop() { if (this._interval) clearInterval(this._interval); }
}

// ═══════════════════════════════════════════════════════════
//  dashboardEmitter.js  (WebSocket bridge for browser UI)
// ═══════════════════════════════════════════════════════════
const http    = require('http');
const express = require('express');
const { Server: SocketIO } = require('socket.io');

class DashboardEmitter {
  constructor(port) {
    this.port = port;
    this.io   = null;
  }

  async start() {
    const app    = express();
    const server = http.createServer(app);
    this.io      = new SocketIO(server, { cors: { origin: '*' } });

    // Serve a minimal status endpoint
    app.get('/health', (_, res) => res.json({ ok: true, ts: Date.now() }));

    server.listen(this.port, () =>
      logger.info(`Dashboard socket: ws://localhost:${this.port}`)
    );
  }

  emit(event, data) {
    if (this.io) this.io.emit(event, data);
  }
}

module.exports = { RiskManager, ProfitTracker, logger, BlockhashManager, DashboardEmitter };
