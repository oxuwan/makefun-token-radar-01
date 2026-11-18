[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/oxuwan/makefun-token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/oxuwan/makefun-token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

# Token Radar

Token Radar ranks 200 pre-token DeFi protocols by implied token value, calibrated on the snapshot itself: each category's sector multiple is the median market-cap / TVL of its tokenized peers in the same DefiLlama snapshot, shrunk toward the global median and clamped, then adjusted for seven-day TVL growth, age with no token, and chain reach. All 40 watchlist protocols are covered, plus the 160 strongest pre-token protocols below the floor; already-launched protocols are set aside in a separate live-token view with their market caps. Every row carries a six-step farm plan with costs and durations, and the dashboard is sortable and filterable by text, category and chain, with a detail view for every protocol.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot>
```

This writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json` into `out/`. Node 22, standard library only, no network.

<sub>Entered on [make.fun](https://make.fun/?ref=xk6tgtt0&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
