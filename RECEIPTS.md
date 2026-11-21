# Receipts: first live run (2026-11-21, Ethereum Sepolia)

Testnet, test USDC. Policies bought by our own test wallet (`0xaE11B21cC16223E359acFCde5AD86A9a03286e61`) on days that had already passed, to exercise settlement against real recorded weather. Not customers.

- SecondSky contract: [`0x75e0129d3c30045d72a90676f24a63e2a1e6752f`](https://sepolia.etherscan.io/address/0x75e0129d3c30045d72a90676f24a63e2a1e6752f)
- Telegraph Diamond: `0x72a70e949362670Bf8bceAd24eFC5b8f950aa08b`
- Source A: OathCast, registration 5130 (Open-Meteo archive). Pays to `0xe9d1c5bd004cd8dfbad164a06f131791eebdc70a`.
- Source B: SecondSky NASA Rainfall, registration 6151 (NASA POWER). Pays to `0x91112e36acdd70d81ecf179abf225005e8798e75`.

| # | Place, day | Limit | Job A → mm | Job B → mm | Result | Buy | Settle | Finalize |
|---|---|---|---|---|---|---|---|---|
| 1 | London, 2026-11-17 | 10 mm | #3 → 26.3 | #4 → 13.98 | **Paid** 20 USDC | [tx](https://sepolia.etherscan.io/tx/0x344ecabc5090346893b7e2f089c3077d2bc935e1c3c76604d8d8a5873d745fac) | [tx](https://sepolia.etherscan.io/tx/0x777e8b600d279d51e46a186117d81a96fab40ca952448c5a087f13608dbc752a) | [tx](https://sepolia.etherscan.io/tx/0x4e1174b82bcba9e1543bafba77fa7973236313c86de05ef413165412239c0e23) |
| 2 | Mumbai, 2026-11-14 | 5 mm | #5 → 0 | #6 → 0 | **Not paid** | [tx](https://sepolia.etherscan.io/tx/0x7b2281f0802f15d497170bce76617ecafddc2d09e2ade009c16c9853fcbc6c2c) | [tx](https://sepolia.etherscan.io/tx/0x35126d2be50043db334277e8d2e82284e72c5aa356d270c159fcaefff1e5a1e0) | [tx](https://sepolia.etherscan.io/tx/0x58222dfe6cd0e05c83fa646f3f00be865d70d961bb16455863e20a7a79366c93) |
| 3 | Lagos, 2026-11-10 | 10 mm | #7 → 17.6 | #8 → 2.65 | **Disputed** | [tx](https://sepolia.etherscan.io/tx/0x1dd0f27d78d3096239a98317525b1a03715f779460dc109de6ecb5a2a6cedd23) | [tx](https://sepolia.etherscan.io/tx/0xc0d40fa65940a01754e7d766aa48497208d9f0ce669a2d690939af4c8e403477) | [tx](https://sepolia.etherscan.io/tx/0x70413b7c70dac64cc13c179171bbf6cc76d2043ad96b5b982929b883a8a1991b) |

## How to check it yourself
1. **Answers:** call `answers(jobId)` on the contract. Bit 255 means done, bit 254 means ok, and the low 64 bits are rain in mm × 1e6.
2. **Which miner answered:** in each job's resolve transaction, the Diamond's payment event (topic `0x26ba2ff1…`) names the wallet that was paid. All odd jobs paid OathCast's wallet; all even jobs paid the NASA miner's wallet. No job fell back to another miner.
3. **The numbers are real:**
   - Open-Meteo archive: `https://archive-api.open-meteo.com/v1/archive?latitude=51.50853&longitude=-0.12574&start_date=2026-11-17&end_date=2026-11-17&daily=precipitation_sum&timezone=auto` returns 26.3 for London.
   - NASA POWER (`PRECTOTCORR`) gives 13.98 for the same place and day.
4. **Live view:** https://secondsky-phi.vercel.app

---

# v2 run (2026-11-21, Ethereum Sepolia)

Contract [`0x0136e904ef5df658588c84d95f520a338b3bbcff`](https://sepolia.etherscan.io/address/0x0136e904ef5df658588c84d95f520a338b3bbcff). Rules: both sources reach the limit → 100%, split → 50%, neither → 0. Replays bought through the live quote API, which charges payout + 2 USDC, so they cannot make money. Test wallet as before.

Latency: from settle to both answers on-chain, **about 8 minutes** (485 s for all six jobs).

| # | Place, day | Limit | Job A → mm (miner) | Job B → mm (miner) | Result | Settle | Final |
|---|---|---|---|---|---|---|---|
| 1 | Lagos `6.4541,3.3947`, 2026-11-10 | 10 mm | [#11](https://devnode.telegraphprotocol.com/engine/v1/job/11/result) → 17.6 (OathCast) | [#12](https://devnode.telegraphprotocol.com/engine/v1/job/12/result) → 2.65 (SecondSky NASA) | **PaidHalf**, 10 USDC | [tx](https://sepolia.etherscan.io/tx/0x25a11f9f759ab7a50f51d19e6c6a10a8582c0cfc4d8ee8d8a0eefc79811c1fa1) | [tx](https://sepolia.etherscan.io/tx/0x891b3d9ecb0192c25b8514a97baf522cb72aacd40db43d73169bb15766f2526f) |
| 2 | London `51.5085,-0.1257`, 2026-11-19 | 10 mm | [#13](https://devnode.telegraphprotocol.com/engine/v1/job/13/result) → 8.2 (OathCast) | [#14](https://devnode.telegraphprotocol.com/engine/v1/job/14/result) → 8.2 (**OathCast**, not the named miner) | **Wrong miner → sent back to Active** | [tx](https://sepolia.etherscan.io/tx/0xbc58f1bf19ffd031e178965884d7a7920eca9c75e3478c20959d2faf3ffc24b4) | [rejectWrongMiner](https://sepolia.etherscan.io/tx/0x2dffb0498685cd2bf09c09b724889de62d78a3f9b154de2e2a8700f73fb97144) |
| 3 | Nairobi `-1.2833,36.8167`, 2026-11-12 | 5 mm | [#15](https://devnode.telegraphprotocol.com/engine/v1/job/15/result) → 15.9 (OathCast) | [#16](https://devnode.telegraphprotocol.com/engine/v1/job/16/result) → 7.28 (SecondSky NASA) | **Paid**, 20 USDC | [tx](https://sepolia.etherscan.io/tx/0x148b9bd6712ae87e6bc22f8e5c18439701a516365a7f3e928d460f3f8b2da0f2) | [tx](https://sepolia.etherscan.io/tx/0x20329b3b26f6c811b0b582895863d07762daf9e8f268c699c05b05e4757f9f1c) |

## The failure case: what happened on policy #2
1. **The test.** The covered day (19 Nov) was only 2 days old. NASA POWER publishes daily values a few days late, so our NASA miner refused, as designed:
   `GET /api/verify?location=51.5085,-0.1257&date=2026-11-19` returns HTTP 422 `no_archive_value`.
2. **Telegraph rerouted.** It sent job #14, which the contract had bought **for miner 6151**, to a fallback miner. Telegraph's record of the job names `oathcast-forecast-verify`. The answer, 8.2 mm, is the same Open-Meteo number as job #13.
3. **Nothing on-chain said so.** The callback marked job #14 successful. Without a check, the contract would have read "both sources agree", when really one source had been counted twice.
4. **The keeper caught it.** Before finalizing, it compares the miner in Telegraph's job record with the registered address of the named miner. It found a mismatch and called `rejectWrongMiner`. The policy went back to Active, and the evidence will be bought again once NASA has published the day.
5. **What it cost:** 2 USDC of evidence, wasted by the reroute. Nothing was paid out wrongly.

Feedback for Telegraph: when a job created with `createJobForMiner` falls back to another miner, the agent is not told on-chain. Exposing the resolving miner in the callback, or failing the job instead, would let contracts enforce source independence without an off-chain check.
