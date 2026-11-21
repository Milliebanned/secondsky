// Local tests for SecondSky against a mock Telegraph Diamond.
// Needs a local chain:  npx hardhat node --port 8545   (then)  node test-secondsky.mjs
import { readFileSync } from "node:fs";
import solc from "solc";
import { createPublicClient, createWalletClient, http, encodePacked, keccak256, encodeAbiParameters, parseAbiParameters, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hardhat } from "viem/chains";

const RPC = "http://127.0.0.1:8545";
const OWNER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const HOLDER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const STRANGER = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const pub = createPublicClient({ chain: hardhat, transport: http(RPC) });
const w = (acct) => createWalletClient({ account: acct, chain: hardhat, transport: http(RPC) });

// ---- compile
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const out = JSON.parse(solc.compile(JSON.stringify({
  language: "Solidity",
  sources: { "SecondSky.sol": { content: src("../contracts/SecondSky.sol") }, "Mocks.sol": { content: src("../contracts/test/Mocks.sol") } },
  settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
})));
const errs = (out.errors || []).filter((e) => e.severity === "error");
if (errs.length) { console.error(errs.map((e) => e.formattedMessage).join("\n")); process.exit(1); }
for (const e of (out.errors || [])) console.log("compiler", e.severity, e.formattedMessage.split("\n")[0]);
const art = (f, n) => ({ abi: out.contracts[f][n].abi, bytecode: "0x" + out.contracts[f][n].evm.bytecode.object });

async function deploy(acct, a, args = []) {
  const hash = await w(acct).deployContract({ ...a, args });
  return (await pub.waitForTransactionReceipt({ hash })).contractAddress;
}
async function send(acct, address, abi, functionName, args = []) {
  const hash = await w(acct).writeContract({ address, abi, functionName, args });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(functionName + " reverted");
  return r;
}
async function expectRevert(p, msg, label) {
  try { await p; } catch (e) {
    const t = (e.shortMessage || "") + " " + (e.details || "") + " " + (e.message || "");
    if (!msg || t.includes(msg)) { ok(label); return; }
    fail(label + ` (wrong revert: ${t.slice(0, 160)})`); return;
  }
  fail(label + " (did not revert)");
}
const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });
let passed = 0, failed = 0;
const ok = (m) => { passed++; console.log("  ✓", m); };
const fail = (m) => { failed++; console.log("  ✗", m); };
const eq = (a, b, m) => (a === b ? ok(m) : fail(`${m} (got ${a}, want ${b})`));
const time = async (s) => { await pub.request({ method: "evm_increaseTime", params: [s] }); await pub.request({ method: "evm_mine", params: [] }); };
const now = async () => Number((await pub.getBlock()).timestamp);

// ---- setup
const U = art("Mocks.sol", "MockUSDC"), DM = art("Mocks.sol", "MockDiamond"), S = art("SecondSky.sol", "SecondSky");
const usdc = await deploy(OWNER, U);
const diamond = await deploy(OWNER, DM, [usdc]);
const SOURCE_A = 5130n, SOURCE_B = 9999n, MAXJOB = 1_500_000n;
const sky = await deploy(OWNER, S, [diamond, usdc, SOURCE_A, SOURCE_B, MAXJOB]);
await send(OWNER, usdc, U.abi, "mint", [sky, 300_000_000n]);       // 300 USDC underwriting pool
await send(OWNER, usdc, U.abi, "mint", [HOLDER.address, 50_000_000n]);
await send(HOLDER, usdc, U.abi, "approve", [sky, 2n ** 255n]);
const bal = (a) => read(usdc, U.abi, "balanceOf", [a]);
const status = async (id) => Number((await read(sky, S.abi, "getPolicy", [id])).status);
const ST = { Active: 1, Settling: 2, Paid: 3, NotPaid: 4, Disputed: 5, Refunded: 6 };

async function quote({ location = "Nairobi", date = "2026-11-05", thresholdE6 = 10_000_000n, payout = 20_000_000n, premium = 3_000_000n, signer = OWNER, settleOffset = 0 } = {}) {
  const settleAfter = BigInt((await now()) + settleOffset);
  const quoteExpiry = BigInt((await now()) + 3600);
  const h = await read(sky, S.abi, "quoteHash", [HOLDER.address, location, date, settleAfter, thresholdE6, payout, premium, quoteExpiry]);
  const sig = await signer.signMessage({ message: { raw: h } });
  return [location, date, settleAfter, thresholdE6, payout, premium, quoteExpiry, sig];
}
async function buy(q) { await send(HOLDER, sky, S.abi, "buyCover", q); return await read(sky, S.abi, "policyCount"); }
async function settleAndAnswer(id, a, b) {
  await send(STRANGER, sky, S.abi, "settle", [id]);              // anyone can trigger
  const p = await read(sky, S.abi, "getPolicy", [id]);
  await send(OWNER, diamond, DM.abi, "resolve", [p.jobA, a !== null, a ?? 0n]);
  eq(await read(diamond, DM.abi, "lastCallbackOk"), true, "callback A landed within its gas");
  await send(OWNER, diamond, DM.abi, "resolve", [p.jobB, b !== null, b ?? 0n]);
  eq(await read(diamond, DM.abi, "lastCallbackOk"), true, "callback B landed within its gas");
  await send(STRANGER, sky, S.abi, "finalize", [id]);
}

console.log("\n1. Both sources agree it rained (>= 10 mm) -> pays");
{
  const id = await buy(await quote());
  const before = await bal(HOLDER.address);
  await settleAndAnswer(id, 14_200_000n, 12_000_000n);
  eq(await status(id), ST.Paid, "status Paid");
  eq((await bal(HOLDER.address)) - before, 20_000_000n, "holder received 20 USDC");
  eq(await read(sky, S.abi, "lockedPayouts"), 0n, "nothing left locked");
}

console.log("\n2. Both sources agree it stayed dry -> no payout, closes");
{
  const id = await buy(await quote());
  const before = await bal(HOLDER.address);
  await settleAndAnswer(id, 3_300_000n, 610_000n);
  eq(await status(id), ST.NotPaid, "status NotPaid");
  eq(await bal(HOLDER.address), before, "holder balance unchanged");
  eq(await read(sky, S.abi, "lockedPayouts"), 0n, "payout released back to the pool");
}

console.log("\n3. The two skies disagree -> Disputed, never pays automatically");
{
  const id = await buy(await quote({ thresholdE6: 2_000_000n }));   // 3.3 mm vs 0.61 mm around a 2 mm limit
  const before = await bal(HOLDER.address);
  await settleAndAnswer(id, 3_300_000n, 610_000n);
  eq(await status(id), ST.Disputed, "status Disputed");
  eq(await bal(HOLDER.address), before, "no automatic payout");
  await expectRevert(send(STRANGER, sky, S.abi, "resolveDispute", [id, true]), "owner only", "a stranger cannot resolve a dispute");
  await send(OWNER, sky, S.abi, "resolveDispute", [id, false]);
  eq(await status(id), ST.NotPaid, "human review closes it");
}

console.log("\n4. A source fails -> retry, then settles");
{
  const id = await buy(await quote());
  await settleAndAnswer(id, 14_000_000n, null);
  eq(await status(id), ST.Active, "back to Active for a retry");
  await settleAndAnswer(id, 14_000_000n, 11_000_000n);
  eq(await status(id), ST.Paid, "retry paid");
  eq(await read(sky, S.abi, "lockedPayouts"), 0n, "accounting clean after retry");
}

console.log("\n5. Guards");
{
  await expectRevert(send(HOLDER, sky, S.abi, "buyCover", await quote({ signer: STRANGER })), "bad quote signature", "rejects a quote not signed by the underwriter");
  const q = await quote();
  await buy(q);
  await expectRevert(send(HOLDER, sky, S.abi, "buyCover", q), "quote used", "rejects a reused quote");
  const id2 = await buy(await quote({ settleOffset: 86400 }));
  await expectRevert(send(STRANGER, sky, S.abi, "settle", [id2]), "too early", "cannot settle before the day is over");
  await expectRevert(send(HOLDER, sky, S.abi, "buyCover", await quote({ payout: 500_000_000n })), "pool too small", "cannot sell cover the pool can't pay");
  await expectRevert(send(OWNER, sky, S.abi, "withdrawFree", [await bal(sky)]), "exceeds free capital", "underwriter cannot withdraw money promised to policies");
  await expectRevert(send(STRANGER, sky, S.abi, "subnetMessage", [1n, true, { addresses: [], integers: [0n, 0n, 99_000_000n], strings: [], bools: [] }, ""]), "only protocol", "only Telegraph can deliver answers");
}

console.log("\n6. Keeper can block a payout but never force one");
{
  const id = await buy(await quote());
  await send(STRANGER, sky, S.abi, "settle", [id]);
  await send(OWNER, sky, S.abi, "flagDispute", [id]);
  eq(await status(id), ST.Disputed, "flagged policy is Disputed");
  await expectRevert(send(OWNER, sky, S.abi, "finalize", [id]), "not settling", "flagged policy cannot auto-finalize");
}

console.log("\n7. Never settled -> premium refunded after the grace period");
{
  const id = await buy(await quote({ settleOffset: 10 }));
  await expectRevert(send(HOLDER, sky, S.abi, "refund", [id]), "grace period not over", "no early refund");
  await time(8 * 86400);
  const before = await bal(HOLDER.address);
  await send(HOLDER, sky, S.abi, "refund", [id]);
  eq((await bal(HOLDER.address)) - before, 3_000_000n, "premium returned");
  eq(await status(id), ST.Refunded, "status Refunded");
}

console.log("\n8. Callback gas");
{
  const id = await buy(await quote());
  await send(STRANGER, sky, S.abi, "settle", [id]);
  const p = await read(sky, S.abi, "getPolicy", [id]);
  const g = await pub.estimateGas({ account: diamond, to: sky, data: (await import("viem")).encodeFunctionData({ abi: S.abi, functionName: "subnetMessage", args: [p.jobA, true, { addresses: [], integers: [24_300_000n, 15_900_000n, 3_300_000n], strings: [], bools: [] }, ""] }) });
  console.log("    callback gas estimate:", g.toString());
  g < 200_000n ? ok("callback under 200k gas (Telegraph stipend 1M, real headroom ~500k)") : fail("callback too heavy");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
