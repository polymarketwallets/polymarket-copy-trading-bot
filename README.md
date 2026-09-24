# pmwallets-copytrade

A ready-to-run Polymarket copy-trading bot. It follows the traders you subscribe to on
[PMWallets](https://pmwallets.com/copy-trading) and mirrors their fills on the Polymarket CLOB with your own account.

```bash
npm install -g pmwallets-copytrade
pmwallets-copytrade init        # writes config.yaml
export PMW_API_KEY=pmw_...      # https://pmwallets.com/keys
pmwallets-copytrade run         # dry-run by default: logs every decision, trades nothing
pmwallets-copytrade status      # open positions and today's spend
```

- **Dry-run first**; live trading needs `mode: live` plus your Polymarket key, signature type and funder address.
- **At most once**: each fill is recorded as decided before any order is sent.
- BUY = fill-or-kill for an exact share count at the best ask, inside your price band, slippage, depth, time-to-
  settle, DCA, position and daily-spend limits. SELL = fill-and-kill at the best bid for what you bought following
  that trader, capped at your real balance.
- Every decision and skip reason goes to `pmw-data/decisions.<mode>.jsonl`.
- Honours `HTTPS_PROXY`.

The rules, and why each exists: see the repository README. **This software trades real money in live mode; a copied
order is not the original trade. Not financial advice. MIT.**
