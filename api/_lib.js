// Shared bits for the SecondSky web functions (files starting with _ are not deployed as endpoints).
// The server holds only the HOT key (v2 "operator": signs quotes, runs the keeper). The owner key,
// which controls the pool, never leaves the owner's machine.
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

export const V2 = "0x0136e904ef5df658588c84d95f520a338b3bbcff";
export const V1 = "0x75e0129d3c30045d72a90676f24a63e2a1e6752f"; // first deployment, kept running until its policies close
export const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
export const DEVNODE = "https://devnode.telegraphprotocol.com";
export const abi = parseAbi([
  "function policyCount() view returns (uint256)",
  "function freeCapital() view returns (uint256)",
  "function maxJobBudget() view returns (uint256)",
  "function maxPayout() view returns (uint256)",
  "function sourceA() view returns (uint256)",
  "function sourceB() view returns (uint256)",
  "function answers(uint256) view returns (uint256)",
  "function quoteHash(address holder, string location, string date, uint64 settleAfter, uint64 thresholdE6, uint96 payout, uint96 premium, uint64 quoteExpiry) view returns (bytes32)",
  "function getPolicy(uint256) view returns ((address holder,uint96 payout,uint96 premium,uint96 jobReserve,uint64 settleAfter,uint64 thresholdE6,uint8 status,uint64 jobA,uint64 jobB,string location,string date))",
  "function settle(uint256)",
  "function finalize(uint256)",
  "function rejectWrongMiner(uint256 policyId, uint256 jobId)",
]);
export const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
export function hot() {
  const k = process.env.HOT_KEY || "";
  if (!k) throw new Error("hot key not configured");
  const account = privateKeyToAccount(k.startsWith("0x") ? k : "0x" + k);
  return { account, wallet: createWalletClient({ account, chain: sepolia, transport: http(RPC) }) };
}
export const read = (functionName, args = [], address = V2) => pub.readContract({ address, abi, functionName, args });

const UA = { headers: { "User-Agent": "SecondSky/2.0" } };
// Payout address of a miner registration, from Telegraph's registry.
export async function minerAddress(registrationId) {
  const r = await fetch(`${DEVNODE}/api/miners/${registrationId}`, UA);
  if (!r.ok) return null;
  return ((await r.json()).miner?.miner_address || "").toLowerCase() || null;
}
// Which miner Telegraph says answered a job (null if the record is not there yet).
export async function jobMiner(jobId) {
  const r = await fetch(`${DEVNODE}/engine/v1/job/${jobId}/result`, UA);
  if (!r.ok) return null;
  const j = await r.json();
  return { address: (j.miner_address || "").toLowerCase() || null, slug: j.miner_slug || null };
}
