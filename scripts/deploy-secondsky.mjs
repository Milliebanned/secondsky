// Deploys SecondSky to Ethereum Sepolia with the operator wallet (.env OPERATOR_KEY) and funds its
// underwriting pool with test USDC. Writes ../deployment.json.
// Usage: cd /Users/Apple/Telegraph/scripts && node deploy-secondsky.mjs
import { readFileSync, writeFileSync } from "node:fs";
import solc from "solc";
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const DIAMOND = "0x72a70e949362670Bf8bceAd24eFC5b8f950aa08b";   // Telegraph (since 17 Nov 2026)
const USDC = "0xcc194e1a843B658526D0D5C431f670028582Ae17";      // Telegraph test USDC
const SOURCE_A = 5130n;   // OathCast forecast-verify (Open-Meteo archive)
const SOURCE_B = 6151n;   // SecondSky NASA Rainfall (NASA POWER)
const MAX_JOB = 1_500_000n; // 1.5 USDC cap per job (price today: 1 USDC)
const POOL = 200_000_000n;  // 200 test USDC

const env = Object.fromEntries(readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")
  .filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const key = env.OPERATOR_KEY.startsWith("0x") ? env.OPERATOR_KEY : "0x" + env.OPERATOR_KEY;
const account = privateKeyToAccount(key);
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: sepolia, transport: http(RPC) });

const out = JSON.parse(solc.compile(JSON.stringify({
  language: "Solidity",
  sources: { "SecondSky.sol": { content: readFileSync(new URL("../contracts/SecondSky.sol", import.meta.url), "utf8") } },
  settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
})));
const errs = (out.errors || []).filter((e) => e.severity === "error");
if (errs.length) { console.error(errs.map((e) => e.formattedMessage).join("\n")); process.exit(1); }
const { abi, evm } = out.contracts["SecondSky.sol"].SecondSky;

console.log("Operator", account.address);
const hash = await wallet.deployContract({ abi, bytecode: "0x" + evm.bytecode.object, args: [DIAMOND, USDC, SOURCE_A, SOURCE_B, MAX_JOB] });
const rc = await pub.waitForTransactionReceipt({ hash });
const address = rc.contractAddress;
console.log("SecondSky deployed:", `https://sepolia.etherscan.io/address/${address}`);

const erc = parseAbi(["function mint(address,uint256)", "function balanceOf(address) view returns (uint256)"]);
const m = await wallet.writeContract({ address: USDC, abi: erc, functionName: "mint", args: [address, POOL] });
await pub.waitForTransactionReceipt({ hash: m });
console.log("Pool funded:", Number(await pub.readContract({ address: USDC, abi: erc, functionName: "balanceOf", args: [address] })) / 1e6, "USDC");

writeFileSync(new URL("../deployment.json", import.meta.url), JSON.stringify({
  network: "sepolia", chainId: 11155111, address, deployTx: hash, deployBlock: Number(rc.blockNumber),
  diamond: DIAMOND, usdc: USDC, sourceA: Number(SOURCE_A), sourceB: Number(SOURCE_B), maxJobBudget: Number(MAX_JOB),
  owner: account.address, abi,
}, null, 2));
console.log("Saved deployment.json");
