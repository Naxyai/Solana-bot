# ⚡ Solana High-Frequency Arbitrage Bot v2.0

> **⚠️ WARNING: This bot trades with REAL funds. Always test on devnet first.**

## What It Does

Scans Raydium, Orca, Meteora, and Lifinity every 150ms for price discrepancies across:
- **2-leg arbitrage**: Buy token on DEX-A, sell on DEX-B at a higher price
- **Triangular arbitrage**: SOL → USDC → TOKEN → SOL circular profit

Executes trades atomically via **Jito bundles** (MEV-protected) using **Jupiter v6** routing. Includes a real-time browser dashboard, full risk management with circuit breakers, and detailed trade logging.

---

## Architecture

```
index.js          ← Bot entry, main scan loop
scanner.js        ← Price fetching from Raydium/Orca/Meteora APIs
executor.js       ← Jupiter v6 quotes + Jito bundle submission
riskManager.js    ← Daily loss limit, circuit breaker, trade validation
profitTracker.js  ← Logs trades to logs/trades-YYYY-MM-DD.ndjson
blockhashManager.js ← Keeps fresh blockhash for fast tx submission
dashboardEmitter.js ← Socket.IO bridge to browser UI
dashboard/        ← Real-time browser dashboard
scripts/          ← test-connection.js, check-balance.js
```

---

## Quick Start

### 1. Prerequisites
- Node.js ≥ 18
- A Solana wallet with SOL (minimum 0.1 SOL for gas)
- (Recommended) A premium RPC: [Helius](https://helius.dev), [Triton](https://triton.one), or [QuickNode](https://quicknode.com)

### 2. Install
```bash
npm install
```

### 3. Configure
```bash
cp .env.example .env
```
Edit `.env`:
- Set `WALLET_PRIVATE_KEY` (base58 private key from Phantom → Settings → Export)
- Set `RPC_ENDPOINT` (premium RPC strongly recommended)
- Review trading parameters (start conservative)

### 4. Test connections
```bash
npm test
```
All 7 checks should pass before going live.

### 5. Check your balance
```bash
npm run check-balance
```

### 6. Dry run first (no real trades)
```bash
npm run simulate
```
Open http://localhost:3000 in your browser to see the dashboard.

### 7. Go live on devnet
```bash
npm run devnet
```

### 8. Go live on mainnet
```bash
npm start
```

### Start with dashboard (both together)
```bash
npm run start:all
```
Then open http://localhost:4000

---

## Configuration Reference (`.env`)

| Variable | Default | Description |
|---|---|---|
| `NETWORK` | `mainnet` | `mainnet` or `devnet` |
| `RPC_ENDPOINT` | public | Your RPC URL |
| `WALLET_PRIVATE_KEY` | — | Base58 private key (**required**) |
| `MIN_PROFIT_BPS` | `40` | Min profit in basis points (1 bps = 0.01%) |
| `MAX_TRADE_SOL` | `0.5` | Max SOL per single trade |
| `MIN_TRADE_SOL` | `0.05` | Min SOL per single trade |
| `SLIPPAGE_BPS` | `50` | Slippage tolerance (0.5%) |
| `MAX_CONCURRENT` | `2` | Simultaneous open trades |
| `SCAN_INTERVAL_MS` | `150` | Scan loop frequency |
| `MAX_DAILY_LOSS_SOL` | `0.3` | Daily loss circuit breaker |
| `MAX_CONSECUTIVE_LOSSES` | `5` | Consecutive fail circuit breaker |
| `JITO_TIP_LAMPORTS` | `10000` | Tip to Jito validators (0.00001 SOL) |
| `DRY_RUN` | `false` | Simulate without sending txs |
| `DEBUG` | `false` | Verbose logging |

---

## Risk Management

The bot has several built-in safety systems:

1. **Daily loss limit** — Stops trading when cumulative daily losses exceed `MAX_DAILY_LOSS_SOL`
2. **Circuit breaker** — Pauses after `MAX_CONSECUTIVE_LOSSES` failed trades in a row
3. **Profit sanity check** — Rejects opportunities with >20% profit (likely stale/bad data)
4. **Size cap** — Limits trade size to 0.3% of the smallest pool's TVL to minimize slippage
5. **Quote validation** — Re-quotes via Jupiter before executing to verify profit still exists
6. **Atomic bundles** — Jito bundles ensure all legs of a trade execute or none do

---

## Improving Profitability

### Use a Premium RPC
Public RPC has severe rate limits (10 req/s). A premium RPC gives you:
- 1000+ req/s
- WebSocket subscriptions for real-time price updates
- Lower latency (10-50ms vs 200-500ms)

**Helius** (recommended): https://helius.dev  
Cost: ~$50-150/month for production usage.

### Tune `MIN_PROFIT_BPS`
Start at 50 bps. After observing actual trades, you can lower to 30-40 bps as you get confident in execution.

### Jito Tips
Higher `JITO_TIP_LAMPORTS` = higher probability your bundle lands in the next block. During congested periods, raise to 50,000-100,000 lamports.

### Add More Token Pairs
Edit `tokenPairs` in `bot/index.js` to scan more pairs. Each pair adds DEX API load — balance scan coverage vs RPC costs.

### WebSocket Pool Subscriptions (Advanced)
For true sub-100ms execution, subscribe to on-chain AMM pool accounts via WebSocket and process updates in real-time rather than polling REST APIs. This requires Raydium/Orca SDK integration.

---

## Trade Log Format

Trades are logged to `logs/trades-YYYY-MM-DD.ndjson`:
```json
{"ts":"2025-01-15T10:23:45.123Z","sig":"5xK...","pair":"SOL/USDC","type":"2-leg","profitSol":"0.000342000","profitBps":"68.40","latencyMs":87,"cumSol":"0.001234000"}
```

---

## Common Issues

**`WALLET_PRIVATE_KEY not set`**  
→ Copy `.env.example` to `.env` and set your key.

**`Insufficient balance`**  
→ Fund your wallet with SOL. Need ≥0.1 SOL minimum.

**`No quote for leg`**  
→ Normal — opportunity was stale by the time quotes were fetched. Not a bug.

**`Bundle poll timeout`**  
→ Jito bundle expired. Bot falls back to direct RPC submission.

**`Rate limited`**  
→ Upgrade to a premium RPC. Public RPC won't work at scale.

**All scans show 0 opportunities**  
→ This is normal in stable markets. Real arb windows are brief (50-500ms). The bot is working — it's just waiting for price divergence. Try lowering `MIN_PROFIT_BPS` to 20 to see more (less profitable) opportunities.

---

## Disclaimer

This software is provided for educational purposes. Cryptocurrency trading involves significant financial risk. You can lose all your funds. The authors are not responsible for any losses. Always test on devnet before deploying real capital.
