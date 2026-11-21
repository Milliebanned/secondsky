# SecondSky

Rain cover for a single day (a harvest, a spray run, a concrete pour) that settles itself.

When the day is over, the SecondSky contract buys that day's recorded rainfall from **Telegraph** through ERC-8183 on-chain jobs, from **two independent sources**:

- **Source A:** OathCast (Open-Meteo archive)
- **Source B:** SecondSky NASA Rainfall (NASA POWER satellite / MERRA-2), our own miner in [`miner/`](miner/)

The contract:
- **pays** when both sources say the threshold was crossed
- **closes** when both say it wasn't
- **refuses to settle** (Disputed) when they disagree. It never pays on one opinion.

Status: work in progress for Telegraph Hackathon Season II (Mission 06, Resources & Agriculture). Sepolia testnet only.

## What's here
| Path | What |
|---|---|
| `contracts/SecondSky.sol` | The cover contract: signed quotes, pooled capital, two-source settlement, disputes, refunds |
| `contracts/test/Mocks.sol` | Mock USDC and a mock Telegraph Diamond for local tests |
| `scripts/test-secondsky.mjs` | 8 scenarios, 35 checks (paid, dry, disagreement, source failure, guards, keeper limits, refund, callback gas) |
| `miner/` | NASA POWER rainfall miner for `WEATHER_FORECAST_VERIFY_GENERAL`, live at https://secondsky-nasa.vercel.app/api/verify?location=Nairobi&date=2026-11-05 |

## Run the tests
```
cd scripts && npm install
npx hardhat node --port 8545 --config hardhat.config.cjs   # terminal 1
node test-secondsky.mjs                                      # terminal 2
```
