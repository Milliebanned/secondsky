// Runs real SecondSky policies on Sepolia. Testnet, our own testing.
//   node policy.mjs setup                                   create + fund the test holder wallet (once)
//   node policy.mjs buy <location> <date> <limitMm> <payoutUsdc> <premiumUsdc>
//   node policy.mjs settle <id>                              buy both rainfall answers from Telegraph
//   node policy.mjs status <id>                              show the policy and both answers
//   node policy.mjs finalize <id>                            pay / close / dispute / retry
// Keys come from ../.env (OPERATOR_KEY = underwriter, HOLDER_KEY = test holder). Never printed.
import { readFileSync, appendFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, parseAbi, parseEther } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { sepolia } from "viem/chains";

const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const V2 = process.env.DEP !== "v1";   // default v2; DEP=v1 for the first deployment
const dep = JSON.parse(readFileSync(new URL(V2 ? "../deployment-v2.json" : "../deployment.json", import.meta.url), "utf8"));
const envPath = new URL("../.env", import.meta.url);
const env = () => Object.fromEntries(readFileSync(envPath, "utf8").split("\n").filter((l) => l.includes("="))
  .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const acct = (k) => privateKeyToAccount(k.startsWith("0x") ? k : "0x" + k);
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
const wal = (a) => createWalletClient({ account: a, chain: sepolia, transport: http(RPC) });
const erc = parseAbi(["function mint(address,uint256)", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const S = { address: dep.address, abi: dep.abi };
const STATUS = V2 ? ["None", "Active", "Settling", "Paid", "PaidHalf", "NotPaid", "Refunded"] : ["None", "Active", "Settling", "Paid", "NotPaid", "Disputed", "Refunded"];
const tx = (h) => `https://sepolia.etherscan.io/tx/${h}`;

async function send(a, c, functionName, args) {
  const h = await wal(a).writeContract({ ...c, functionName, args });
  const r = await pub.waitForTransactionReceipt({ hash: h });
  if (r.status !== "success") throw new Error(`${functionName} reverted: ${tx(h)}`);
  return { h, r };
}

const [cmd, ...args] = process.argv.slice(2);
const operator = acct(env().OPERATOR_KEY);          // v1 owner+signer; v2: pays gas for settle only
const signer = V2 ? acct(env().HOT_KEY) : operator;  // who signs quotes

if (cmd === "setup") {
  if (env().HOLDER_KEY) { console.log("holder already exists:", acct(env().HOLDER_KEY).address); process.exit(0); }
  const k = generatePrivateKey();
  appendFileSync(envPath, `\nHOLDER_KEY=${k}\n`);
  const holder = acct(k);
  let h = await wal(operator).sendTransaction({ to: holder.address, value: parseEther("0.004") });
  await pub.waitForTransactionReceipt({ hash: h });
  await send(operator, { address: dep.usdc, abi: erc }, "mint", [holder.address, 60_000_000n]);
  await send(holder, { address: dep.usdc, abi: erc }, "approve", [dep.address, 2n ** 255n]);
  console.log("test holder", holder.address, "funded with 0.004 ETH + 60 test USDC, approved SecondSky");
} else if (cmd === "buy") {
  const [location, date, limitMm, payout, premium] = args;
  const holder = acct(env().HOLDER_KEY);
  const now = Number((await pub.getBlock()).timestamp);
  // a future day can only be settled after it is over everywhere (+14 h for the latest time zone)
  const dayEnd = Date.parse(date + "T00:00:00Z") / 1000 + 86400 + 14 * 3600;
  const q = { location, date, settleAfter: BigInt(Math.max(now, dayEnd)), thresholdE6: BigInt(Math.round(Number(limitMm) * 1e6)),
    payout: BigInt(Math.round(Number(payout) * 1e6)), premium: BigInt(Math.round(Number(premium) * 1e6)), expiry: BigInt(now + 1800) };
  const hash = await pub.readContract({ ...S, functionName: "quoteHash", args: [holder.address, q.location, q.date, q.settleAfter, q.thresholdE6, q.payout, q.premium, q.expiry] });
  const sig = await signer.signMessage({ message: { raw: hash } });   // underwriter signs the quote
  const { h } = await send(holder, S, "buyCover", [q.location, q.date, q.settleAfter, q.thresholdE6, q.payout, q.premium, q.expiry, sig]);
  const id = await pub.readContract({ ...S, functionName: "policyCount" });
  console.log(`policy #${id} bought: ${location} ${date}, pays ${payout} USDC if rain >= ${limitMm} mm, premium ${premium} USDC\n  ${tx(h)}`);
} else if (cmd === "settle") {
  const { h } = await send(operator, S, "settle", [BigInt(args[0])]);
  const p = await pub.readContract({ ...S, functionName: "getPolicy", args: [BigInt(args[0])] });
  console.log(`policy #${args[0]} settling: Telegraph job ${p.jobA} -> source A (${dep.sourceA}), job ${p.jobB} -> source B (${dep.sourceB})\n  ${tx(h)}`);
} else if (cmd === "approve") {
  const holder = acct(env().HOLDER_KEY);
  await send(holder, { address: dep.usdc, abi: erc }, "approve", [dep.address, 2n ** 255n]);
  console.log("holder approved", dep.address);
} else if (cmd === "status") {
  const id = BigInt(args[0]);
  const p = await pub.readContract({ ...S, functionName: "getPolicy", args: [id] });
  const ans = async (j) => {
    if (!j) return "-";
    const v = await pub.readContract({ ...S, functionName: "answers", args: [j] });
    if (!(v >> 255n)) return "waiting";
    if (!((v >> 254n) & 1n)) return "FAILED";
    return `${Number(v & ((1n << 64n) - 1n)) / 1e6} mm`;
  };
  console.log(`#${id} ${p.location} ${p.date} limit ${Number(p.thresholdE6) / 1e6} mm payout ${Number(p.payout) / 1e6} — ${STATUS[p.status]}`);
  console.log(`  job ${p.jobA} (A ${dep.sourceA}): ${await ans(p.jobA)}   job ${p.jobB} (B ${dep.sourceB}): ${await ans(p.jobB)}`);
} else if (cmd === "finalize" && V2) {
  // v2: go through the keeper, which checks Telegraph's job records before finalizing
  const r = await (await fetch(`https://secondsky.milliebanned.xyz/api/keeper?policy=${args[0]}`)).json();
  console.log(JSON.stringify(r));
  if (r.result?.tx) await pub.waitForTransactionReceipt({ hash: r.result.tx });
  const p = await pub.readContract({ ...S, functionName: "getPolicy", args: [BigInt(args[0])] });
  console.log(`policy #${args[0]} -> ${STATUS[p.status]}`);
} else if (cmd === "finalize") {
  const id = BigInt(args[0]);
  const { h } = await send(operator, S, "finalize", [id]);
  const p = await pub.readContract({ ...S, functionName: "getPolicy", args: [id] });
  console.log(`policy #${id} -> ${STATUS[p.status]}\n  ${tx(h)}`);
} else {
  console.log("commands: setup | buy | settle | status | finalize");
}
