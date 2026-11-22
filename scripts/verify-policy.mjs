// Check any SecondSky v2 policy yourself, without trusting us. Read-only: no keys, no transactions.
//   cd scripts && npm install && node verify-policy.mjs <policyId>
// It reads the policy from the contract, the two answers Telegraph delivered on-chain, and Telegraph's own
// record of each job (which miner answered). Then it applies the payout rule itself and compares.
import { createPublicClient, http, parseAbi } from "viem";
import { sepolia } from "viem/chains";

const V2 = "0x0136e904ef5df658588c84d95f520a338b3bbcff";
const RPC = process.env.RPC || "https://ethereum-sepolia-rpc.publicnode.com";
const DEVNODE = "https://devnode.telegraphprotocol.com";
const STATUS = ["None", "Active", "Settling", "Paid", "PaidHalf", "NotPaid", "Refunded"];
const abi = parseAbi([
  "function getPolicy(uint256) view returns ((address holder,uint96 payout,uint96 premium,uint96 jobReserve,uint64 settleAfter,uint64 thresholdE6,uint8 status,uint64 jobA,uint64 jobB,string location,string date))",
  "function answers(uint256) view returns (uint256)",
  "function sourceA() view returns (uint256)",
  "function sourceB() view returns (uint256)",
  "event Finalized(uint256 indexed policyId, uint8 status, uint256 rainA, uint256 rainB, uint256 paid)",
]);
const UA = { headers: { "User-Agent": "secondsky-verify/1.0" } };
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
const read = (functionName, args = []) => pub.readContract({ address: V2, abi, functionName, args });
const id = BigInt(process.argv[2] || 0);
if (!id) { console.log("usage: node verify-policy.mjs <policyId>"); process.exit(1); }

const p = await read("getPolicy", [id]);
if (!p.status) { console.log(`policy #${id} does not exist on ${V2}`); process.exit(1); }
const lim = Number(p.thresholdE6) / 1e6, payout = Number(p.payout) / 1e6;
console.log(`policy #${id}  ${p.location}  ${p.date}`);
console.log(`  pays ${payout} USDC if both sources record >= ${lim} mm (50% if they split)`);
console.log(`  status on-chain: ${STATUS[p.status]}`);
if (!p.jobA) { console.log("  not settled yet: no Telegraph jobs bought for it."); process.exit(0); }

const [sA, sB] = await Promise.all([read("sourceA"), read("sourceB")]);
const minerAddr = async (reg) => ((await (await fetch(`${DEVNODE}/api/miners/${reg}`, UA)).json()).miner?.miner_address || "").toLowerCase();
const record = async (job) => { const r = await fetch(`${DEVNODE}/engine/v1/job/${job}/result`, UA); return r.ok ? r.json() : null; };
const [expA, expB, recA, recB, ansA, ansB] = await Promise.all([minerAddr(sA), minerAddr(sB), record(p.jobA), record(p.jobB), read("answers", [p.jobA]), read("answers", [p.jobB])]);
const unpack = (v) => (v >> 255n) === 0n ? null : ((v >> 254n) & 1n) === 0n ? "failed" : Number(v & ((1n << 64n) - 1n)) / 1e6;
const rows = [["A", sA, expA, p.jobA, recA, unpack(ansA)], ["B", sB, expB, p.jobB, recB, unpack(ansB)]];
let allRight = true;
for (const [k, reg, exp, job, rec, mm] of rows) {
  const got = (rec?.miner_address || "").toLowerCase();
  const right = got && got === exp;
  if (!right) allRight = false;
  console.log(`  source ${k}: job ${job}, named miner ${reg}`);
  console.log(`    answer on-chain: ${mm === null ? "not delivered yet" : mm === "failed" ? "failed" : mm + " mm"}`);
  console.log(`    Telegraph's record: answered by ${rec?.miner_slug || "?"} ${right ? "(the named miner)" : "(NOT the named miner)"}`);
  console.log(`    record: ${DEVNODE}/engine/v1/job/${job}/result`);
}
const [a, b] = [rows[0][5], rows[1][5]];
if (typeof a === "number" && typeof b === "number") {
  const wa = a >= lim, wb = b >= lim;
  const rule = wa && wb ? "Paid" : wa || wb ? "PaidHalf" : "NotPaid";
  const share = rule === "Paid" ? 1 : rule === "PaidHalf" ? 0.5 : 0;
  console.log(`  the rule says: ${rule} (${payout * share} USDC)`);
  if (["Paid", "PaidHalf", "NotPaid"].includes(STATUS[p.status])) {
    console.log(`  the contract did: ${STATUS[p.status]}  ->  ${STATUS[p.status] === rule ? "MATCHES" : "DOES NOT MATCH"}`);
  } else {
    console.log(`  the contract has not finalized it yet (${STATUS[p.status]}).`);
  }
}
if (!allRight) console.log("  note: a job answered by a miner other than the named one is sent back to be bought again (see RECEIPTS.md, job 14).");
