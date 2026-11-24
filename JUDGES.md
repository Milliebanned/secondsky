# Checking SecondSky

Everything runs on **Ethereum Sepolia testnet with test USDC**. Nothing here needs our keys, and nothing asks you to trust our numbers: each check reads the contract or Telegraph's own records.

A friendlier version with screenshots of expected output is at **https://secondsky.milliebanned.xyz/guide.html**.

## 1. Read a Telegraph job record (no install)

Every answer a policy paid on has a public record that names the miner that answered:

```
curl -A check https://devnode.telegraphprotocol.com/engine/v1/job/12/result
# "miner_slug":"secondsky-nasa-rainfall", "precipitation_mm":2.65, ...
```

## 2. Verify any policy end to end (read-only)

```
git clone https://github.com/Milliebanned/secondsky
cd secondsky/scripts && npm install
node verify-policy.mjs 1
```

It reads the policy, the two answers delivered on-chain, and Telegraph's record of who answered each job. Then it applies the payout rule itself and compares with what the contract did. On 22 Nov 2026, policies #1, #2 and #3 all print `MATCHES`.

## 3. Run the contract tests (local chain)

```
cd secondsky/scripts
npx hardhat node --port 8545 --config hardhat.config.cjs   # terminal 1
node test-secondsky-v2.mjs                                   # terminal 2
# 50 passed, 0 failed
```

Covered: the payout rule (100 / 50 / 0), retry after a failed answer, the wrong-miner path, the one-day finalize window, what each role can and cannot do, refunds after the grace period, pool accounting, and the gas the Telegraph callback uses (49,708). Checked on a fresh clone on 22 Nov 2026.

## 4. Repeat the disagreement study (public data, no keys)

```
python3 scripts/agreement_study.py
# limit 10 mm: split 375 (64% of days where at least one says wet)
```

This is why the contract pays 50% when the two records split, instead of trusting one.

## 5. Call our NASA source directly

Source B is our own Telegraph miner (registration 6151):

```
curl "https://secondsky-nasa.vercel.app/api/verify?location=Nairobi&date=2026-11-05"
```

For a day that has not ended it refuses (`window_not_finished`) rather than guessing.

## 6. The real failure case

Job 14 was bought for our NASA miner on a day NASA had not published. Telegraph's record shows `oathcast-forecast-verify` answered it instead, and the callback said success. The keeper compared the record with the named miner, called `rejectWrongMiner`, and the policy was bought again once NASA published (jobs 17 and 18, both by the named miners). Every link is in [RECEIPTS.md](RECEIPTS.md#the-failure-case-what-happened-on-policy-2).

```
curl -A check https://devnode.telegraphprotocol.com/engine/v1/job/14/result   # oathcast, not the named miner
node scripts/verify-policy.mjs 2                                               # the re-run: MATCHES
```

## 7. Try it yourself

Get free Sepolia ETH from a faucet, open https://secondsky.milliebanned.xyz/buy.html, connect, get 50 test USDC, choose **Replay a past day**, buy, press **Settle now**, wait about 8 minutes, press **Finish**.

| | |
|---|---|
| Cost to you | 0 real money; a replay costs the payout + 2 test USDC, so it never profits |
| Evidence cost | 2 test USDC per settlement (two 1 USDC Telegraph jobs, paid from the pool) |
| Latency | about 8 minutes from settle to both answers on-chain (measured 485 s on 21 Nov); a forecast job took 708 s |

## Contracts

| | Address |
|---|---|
| SecondSky v2 | `0x0136e904ef5df658588c84d95f520a338b3bbcff` ([Etherscan, verified](https://sepolia.etherscan.io/address/0x0136e904ef5df658588c84d95f520a338b3bbcff#code) · [Sourcify exact match](https://repo.sourcify.dev/11155111/0x0136E904eF5dF658588c84d95F520A338b3BBcfF)) |
| ForecastLog | `0x846f58e93abe4f25b843d75f6f767123e75adebf` ([Etherscan, verified](https://sepolia.etherscan.io/address/0x846f58e93abe4f25b843d75f6f767123e75adebf#code) · [Sourcify exact match](https://repo.sourcify.dev/11155111/0x846f58e93abe4f25b843d75f6f767123e75adebf)) |
| SecondSky v1 (first run) | `0x75e0129d3c30045d72a90676f24a63e2a1e6752f` |
| Telegraph Diamond | `0x72a70e949362670Bf8bceAd24eFC5b8f950aa08b` |

## What is not proven yet

- No outside customer has bought cover. Every policy so far was bought by our own test wallet and is labelled "our test" on the site.
- Forecast scoring starts once the 24–25 Nov covered days settle.
- Testnet only; the payout cap is 50 test USDC.
