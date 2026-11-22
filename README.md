# SecondSky

Rain cover for one day that has to stay dry: a concrete pour, a haul-road shift, a harvest. It settles itself.

When the day is over, the SecondSky contract buys that day's recorded rainfall from **Telegraph** through ERC-8183 on-chain jobs, from **two independent sources**:

- **Source A:** OathCast, registration 5130 (Open-Meteo archive).
- **Source B:** SecondSky NASA Rainfall, registration 6151 (NASA POWER satellite / MERRA-2). This is our own miner, in [`miner/`](miner/).

It pays by rule, with no person in the claim:

| Both sources reach the limit | They split | Neither |
|---|---|---|
| 100% | 50% | 0 |

Why the 50% rule: over a year in 10 cities, on days when at least one source reached 10 mm, the two disagreed **64%** of the time. A contract that trusts one source pays on that source's luck. See [`scripts/agreement_study.py`](scripts/agreement_study.py).

**Live:** https://secondsky.milliebanned.xyz (numbers read from the chain) · **Buy or replay:** https://secondsky.milliebanned.xyz/buy.html

Status: Telegraph Hackathon Season II, Mission 06 (Resources & Agriculture). **Sepolia testnet, test USDC.**

## Contracts
| | Address | |
|---|---|---|
| SecondSky v2 (current) | `0x0136e904ef5df658588c84d95f520a338b3bbcff` | [Sourcify exact match](https://repo.sourcify.dev/11155111/0x0136E904eF5dF658588c84d95F520A338b3BBcfF) |
| SecondSky v1 (first run) | `0x75e0129d3c30045d72a90676f24a63e2a1e6752f` | its receipts are in [RECEIPTS.md](RECEIPTS.md) |
| Telegraph Diamond | `0x72a70e949362670Bf8bceAd24eFC5b8f950aa08b` | |

## Who can do what (v2)
- **Anyone** can settle a policy whose time has come. Anyone can finalize it one day after both answers arrive.
- **Operator** (a hot key on the quote server) can:
  - sign prices, up to a 50 USDC payout cap;
  - finalize straight away, after checking Telegraph's job records that the named miner answered each job;
  - if another miner answered, send the policy back to be bought again.

  It cannot choose an outcome, move money or change settings.
- **Owner** (a cold key that never touches a server) controls the pool and sources. It can withdraw only capital not promised to open policies.
- **Buyer:** if a policy is never settled, the premium comes back after 7 days.

## What's here
| Path | What |
|---|---|
| `contracts/SecondSkyV2.sol` | The cover contract |
| `scripts/test-secondsky-v2.mjs` | 50 local checks: payout rules, retry, wrong-miner, finalize window, role limits, refund, accounting, callback gas |
| `api/quote.js` | Prices a day from 10 years of both sources at that spot and signs the quote |
| `api/keeper.js` | Daily cron plus a per-policy endpoint: settles, checks Telegraph's job records, finalizes |
| `site/` | Live stats page and buy page |
| `miner/` | NASA POWER miner for `WEATHER_FORECAST_VERIFY_GENERAL` (plus forecast scoring and weather-event resolution) |

## Run the tests
```
cd scripts && npm install
npx hardhat node --port 8545 --config hardhat.config.cjs   # terminal 1
node test-secondsky-v2.mjs                                   # terminal 2
```
