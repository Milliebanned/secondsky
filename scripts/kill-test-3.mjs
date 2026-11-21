// Kill test 3: deploy RainProbe, give it 1 test USDC, and let it buy past rainfall on-chain by itself.
// Usage:  cd /Users/Apple/Telegraph/scripts && npm install viem solc && node kill-test-3.mjs
// Your key is read locally from ~/.telegraph/wallet.json and never printed.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import solc from "solc";
import { createWalletClient, createPublicClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const USDC = "0xcc194e1a843B658526D0D5C431f670028582Ae17";
const DIAMOND = "0x72a70e949362670Bf8bceAd24eFC5b8f950aa08b";
const LOCATION = "Nairobi", DATE = "2026-11-05";

// 1. compile
const source = readFileSync(new URL("../contracts/RainProbe.sol", import.meta.url), "utf8");
const out = JSON.parse(solc.compile(JSON.stringify({
  language: "Solidity",
  sources: { "RainProbe.sol": { content: source } },
  settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
})));
const errs = (out.errors || []).filter(e => e.severity === "error");
if (errs.length) { console.error(errs.map(e => e.formattedMessage).join("\n")); process.exit(1); }
const { abi, evm } = out.contracts["RainProbe.sol"].RainProbe;
console.log("Compiled RainProbe.");

// 2. wallet
const w = JSON.parse(readFileSync(`${homedir()}/.telegraph/wallet.json`, "utf8"));
let pk = w.privateKey ?? w.private_key ?? w.key ?? w.pk ?? w.wallet?.privateKey;
if (!pk.startsWith("0x")) pk = "0x" + pk;
const account = privateKeyToAccount(pk);
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: sepolia, transport: http(RPC) });
console.log("Wallet:", account.address);

// 3. job price (for the cap)
const base = await pub.readContract({ address: DIAMOND, abi: parseAbi(["function getJobBasePrice() view returns (uint256)"]), functionName: "getJobBasePrice" });
const cap = base * 2n > 2_000_000n ? 2_000_000n : base * 2n;
console.log("Job base price:", Number(base) / 1e6, "USDC, cap:", Number(cap) / 1e6);

// 4. deploy
const deployHash = await wallet.deployContract({ abi, bytecode: "0x" + evm.bytecode.object });
const { contractAddress } = await pub.waitForTransactionReceipt({ hash: deployHash });
console.log("RainProbe deployed:", `https://sepolia.etherscan.io/address/${contractAddress}`);

// 5. fund the contract with test USDC (it pays for its own purchase); leftovers can be withdrawn later
const t = await wallet.writeContract({ address: USDC, abi: parseAbi(["function transfer(address,uint256) returns (bool)"]), functionName: "transfer", args: [contractAddress, cap] });
await pub.waitForTransactionReceipt({ hash: t });
console.log("Sent", Number(cap) / 1e6, "test USDC to the contract.");

// 6. the contract buys past rainfall by itself
const r = await wallet.writeContract({ address: contractAddress, abi, functionName: "request", args: [LOCATION, DATE, cap] });
const rc = await pub.waitForTransactionReceipt({ hash: r });
console.log("Request tx:", `https://sepolia.etherscan.io/tx/${r}`, "status:", rc.status);
const jobId = await pub.readContract({ address: contractAddress, abi, functionName: "lastJobId" });
console.log("Job id:", jobId.toString());

writeFileSync(new URL("./kill-test-3c.json", import.meta.url), JSON.stringify({ contract: contractAddress, jobId: jobId.toString(), requestTx: r, location: LOCATION, date: DATE }, null, 2));
console.log("\nDone. Telegraph picks the job up in ~10-15 min. Tell Claude: 'check kill test 3'.");
