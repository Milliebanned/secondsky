// Shared bits for the SecondSky web functions (files starting with _ are not deployed as endpoints).
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

export const ADDR = "0x75e0129d3c30045d72a90676f24a63e2a1e6752f";
export const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
export const abi = parseAbi([
  "function policyCount() view returns (uint256)",
  "function freeCapital() view returns (uint256)",
  "function maxJobBudget() view returns (uint256)",
  "function answers(uint256) view returns (uint256)",
  "function quoteHash(address holder, string location, string date, uint64 settleAfter, uint64 thresholdE6, uint96 payout, uint96 premium, uint64 quoteExpiry) view returns (bytes32)",
  "function getPolicy(uint256) view returns ((address holder,uint96 payout,uint96 premium,uint96 jobReserve,uint64 settleAfter,uint64 thresholdE6,uint8 status,uint64 jobA,uint64 jobB,string location,string date))",
  "function settle(uint256)",
  "function finalize(uint256)",
]);
export const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
export function operator() {
  const k = process.env.OPERATOR_KEY || "";
  if (!k) throw new Error("operator key not configured");
  const account = privateKeyToAccount(k.startsWith("0x") ? k : "0x" + k);
  return { account, wallet: createWalletClient({ account, chain: sepolia, transport: http(RPC) }) };
}
export const read = (functionName, args = []) => pub.readContract({ address: ADDR, abi, functionName, args });
