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
