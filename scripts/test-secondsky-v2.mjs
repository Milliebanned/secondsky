// Local tests for SecondSky v2 against a mock Telegraph Diamond.
// Needs a local chain:  npx hardhat node --port 8545 --config hardhat.config.cjs   (then)  node test-secondsky-v2.mjs
import { readFileSync } from "node:fs";
import solc from "solc";
import { createPublicClient, createWalletClient, http, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hardhat } from "viem/chains";

const RPC = "http://127.0.0.1:8545";
// Hardhat's public default test keys (not secrets)
const OWNER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const HOLDER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const STRANGER = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const OPERATOR = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
const pub = createPublicClient({ chain: hardhat, transport: http(RPC) });
const w = (a) => createWalletClient({ account: a, chain: hardhat, transport: http(RPC) });

const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const out = JSON.parse(solc.compile(JSON.stringify({
  language: "Solidity",
  sources: { "SecondSkyV2.sol": { content: src("../contracts/SecondSkyV2.sol") }, "Mocks.sol": { content: src("../contracts/test/Mocks.sol") } },
  settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
})));
const errs = (out.errors || []).filter((e) => e.severity === "error");
if (errs.length) { console.error(errs.map((e) => e.formattedMessage).join("\n")); process.exit(1); }
const art = (f, n) => ({ abi: out.contracts[f][n].abi, bytecode: "0x" + out.contracts[f][n].evm.bytecode.object });

async function deploy(a, c, args = []) { const h = await w(a).deployContract({ ...c, args }); return (await pub.waitForTransactionReceipt({ hash: h })).contractAddress; }
async function send(a, address, abi, functionName, args = []) {
  const h = await w(a).writeContract({ address, abi, functionName, args });
  const r = await pub.waitForTransactionReceipt({ hash: h });
  if (r.status !== "success") throw new Error(functionName + " reverted");
  return r;
}
const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });
let passed = 0, failed = 0;
const ok = (m) => { passed++; console.log("  ✓", m); };
const fail = (m) => { failed++; console.log("  ✗", m); };
const eq = (a, b, m) => (a === b ? ok(m) : fail(`${m} (got ${a}, want ${b})`));
async function expectRevert(p, msg, label) {
  try { await p; } catch (e) {
    const t = (e.shortMessage || "") + " " + (e.details || "") + " " + (e.message || "");
    return !msg || t.includes(msg) ? ok(label) : fail(`${label} (wrong revert: ${t.slice(0, 140)})`);
  }
  fail(label + " (did not revert)");
}
const time = async (s) => { await pub.request({ method: "evm_increaseTime", params: [s] }); await pub.request({ method: "evm_mine", params: [] }); };
const now = async () => Number((await pub.getBlock()).timestamp);

const U = art("Mocks.sol", "MockUSDC"), DM = art("Mocks.sol", "MockDiamond"), S = art("SecondSkyV2.sol", "SecondSkyV2");
const usdc = await deploy(OWNER, U);
const diamond = await deploy(OWNER, DM, [usdc]);
const sky = await deploy(OWNER, S, [diamond, usdc, 5130n, 6151n, 1_500_000n, 50_000_000n, OPERATOR.address]);
await send(OWNER, usdc, U.abi, "mint", [sky, 300_000_000n]);
await send(OWNER, usdc, U.abi, "mint", [HOLDER.address, 100_000_000n]);
await send(HOLDER, usdc, U.abi, "approve", [sky, 2n ** 255n]);
const bal = (a) => read(usdc, U.abi, "balanceOf", [a]);
const ST = { Active: 1, Settling: 2, Paid: 3, PaidHalf: 4, NotPaid: 5, Refunded: 6 };
const status = async (id) => Number((await read(sky, S.abi, "getPolicy", [id])).status);

async function quote({ thresholdE6 = 10_000_000n, payout = 20_000_000n, premium = 3_000_000n, signer = OPERATOR, settleOffset = 0 } = {}) {
  const t = await now();
  const args = ["6.4541,3.3947", "2026-11-10", BigInt(t + settleOffset), thresholdE6, payout, premium, BigInt(t + 3600)];
  const h = await read(sky, S.abi, "quoteHash", [HOLDER.address, ...args]);
  return [...args, await signer.signMessage({ message: { raw: h } })];
}
async function buy(q) { await send(HOLDER, sky, S.abi, "buyCover", q); return await read(sky, S.abi, "policyCount"); }
async function answer(id, a, b) {
  const p = await read(sky, S.abi, "getPolicy", [id]);
  await send(OWNER, diamond, DM.abi, "resolve", [p.jobA, a !== null, a ?? 0n]);
  eq(await read(diamond, DM.abi, "lastCallbackOk"), true, "callback A landed");
  await send(OWNER, diamond, DM.abi, "resolve", [p.jobB, b !== null, b ?? 0n]);
  eq(await read(diamond, DM.abi, "lastCallbackOk"), true, "callback B landed");
}
async function run(id, a, b, finalizer = OPERATOR) {
  await send(STRANGER, sky, S.abi, "settle", [id]);
  await answer(id, a, b);
  await send(finalizer, sky, S.abi, "finalize", [id]);
}

console.log("\n1. Both sources over the limit -> pays 100%");
{ const id = await buy(await quote()); const b0 = await bal(HOLDER.address);
  await run(id, 14_200_000n, 12_000_000n);
  eq(await status(id), ST.Paid, "status Paid"); eq((await bal(HOLDER.address)) - b0, 20_000_000n, "holder +20 USDC"); }

console.log("\n2. Sources split -> pays 50% automatically, no human");
{ const id = await buy(await quote()); const b0 = await bal(HOLDER.address);
  await run(id, 17_600_000n, 2_650_000n);
  eq(await status(id), ST.PaidHalf, "status PaidHalf"); eq((await bal(HOLDER.address)) - b0, 10_000_000n, "holder +10 USDC"); }

console.log("\n3. Both under the limit -> pays 0");
{ const id = await buy(await quote()); const b0 = await bal(HOLDER.address);
  await run(id, 3_300_000n, 610_000n);
  eq(await status(id), ST.NotPaid, "status NotPaid"); eq(await bal(HOLDER.address), b0, "holder unchanged"); }

console.log("\n4. A source fails -> retry, then settles");
{ const id = await buy(await quote());
  await run(id, 14_000_000n, null);
  eq(await status(id), ST.Active, "back to Active");
  await run(id, 14_000_000n, 11_000_000n);
  eq(await status(id), ST.Paid, "retry paid"); }

console.log("\n5. Public finalize waits for the operator's check window");
{ const id = await buy(await quote());
  await send(STRANGER, sky, S.abi, "settle", [id]);
  await answer(id, 12_000_000n, 1_000_000n);
  await expectRevert(send(STRANGER, sky, S.abi, "finalize", [id]), "operator check window", "stranger cannot finalize right away");
  await time(86400 + 5);
  await send(STRANGER, sky, S.abi, "finalize", [id]);
  eq(await status(id), ST.PaidHalf, "stranger finalizes after 1 day"); }

console.log("\n6. Wrong miner answered -> operator can only send it back for a fresh purchase");
{ const id = await buy(await quote());
  await send(STRANGER, sky, S.abi, "settle", [id]);
  const p = await read(sky, S.abi, "getPolicy", [id]);
  await answer(id, 20_000_000n, 20_000_000n);
  await expectRevert(send(STRANGER, sky, S.abi, "rejectWrongMiner", [id, p.jobB]), "operator only", "stranger cannot reject");
  await expectRevert(send(OWNER, sky, S.abi, "rejectWrongMiner", [id, p.jobB]), "operator only", "even the owner cannot");
  await expectRevert(send(OPERATOR, sky, S.abi, "rejectWrongMiner", [id, 999n]), "not this policy's job", "must name one of this policy's jobs");
  await send(OPERATOR, sky, S.abi, "rejectWrongMiner", [id, p.jobB]);
  eq(await status(id), ST.Active, "back to Active");
  await run(id, 20_000_000n, 20_000_000n);
  eq(await status(id), ST.Paid, "fresh purchase settles it"); }

console.log("\n7. Guards");
{ await expectRevert(send(HOLDER, sky, S.abi, "buyCover", await quote({ signer: OWNER })), "bad quote signature", "owner key cannot sign quotes (operator only)");
  await expectRevert(send(HOLDER, sky, S.abi, "buyCover", await quote({ signer: STRANGER })), "bad quote signature", "stranger's quote rejected");
  const q = await quote(); await buy(q);
  await expectRevert(send(HOLDER, sky, S.abi, "buyCover", q), "quote used", "quote cannot be reused");
  await expectRevert(send(HOLDER, sky, S.abi, "buyCover", await quote({ payout: 60_000_000n })), "payout above cap", "operator cannot promise above the cap");
  const id2 = await buy(await quote({ settleOffset: 86400 }));
  await expectRevert(send(STRANGER, sky, S.abi, "settle", [id2]), "too early", "cannot settle before settle time");
  await expectRevert(send(OWNER, sky, S.abi, "withdrawFree", [await bal(sky)]), "exceeds free capital", "owner cannot withdraw promised money");
  await expectRevert(send(OPERATOR, sky, S.abi, "withdrawFree", [1n]), "owner only", "operator cannot withdraw anything");
  await expectRevert(send(OPERATOR, sky, S.abi, "setOperator", [OPERATOR.address]), "owner only", "operator cannot change roles");
  await expectRevert(send(STRANGER, sky, S.abi, "subnetMessage", [1n, true, { addresses: [], integers: [0n, 0n, 99_000_000n], strings: [], bools: [] }, ""]), "only protocol", "only Telegraph can deliver answers"); }

console.log("\n8. Never settled -> premium refunded after grace");
{ const id = await buy(await quote({ settleOffset: 10 }));
  await expectRevert(send(HOLDER, sky, S.abi, "refund", [id]), "grace period not over", "no early refund");
  await time(8 * 86400); const b0 = await bal(HOLDER.address);
  await send(HOLDER, sky, S.abi, "refund", [id]);
  eq((await bal(HOLDER.address)) - b0, 3_000_000n, "premium returned"); eq(await status(id), ST.Refunded, "status Refunded"); }

console.log("\n9. Accounting");
{ // settle the open policies from section 7 so nothing is left locked
  for (let id = 1n; id <= await read(sky, S.abi, "policyCount"); id++) {
    if ((await status(id)) === ST.Active) await run(id, 0n, 0n);
  }
  eq(await read(sky, S.abi, "lockedPayouts"), 0n, "nothing locked once every policy is closed");
  eq(await read(sky, S.abi, "freeCapital"), await bal(sky), "free capital = balance"); }

console.log("\n10. Callback gas");
{ const id = await buy(await quote()); await send(STRANGER, sky, S.abi, "settle", [id]);
  const p = await read(sky, S.abi, "getPolicy", [id]);
  const g = await pub.estimateGas({ account: diamond, to: sky, data: encodeFunctionData({ abi: S.abi, functionName: "subnetMessage", args: [p.jobA, true, { addresses: [], integers: [24_300_000n, 15_900_000n, 3_300_000n], strings: [], bools: [] }, ""] }) });
  console.log("    callback gas estimate:", g.toString());
  g < 200_000n ? ok("callback under 200k gas") : fail("callback too heavy"); }

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
