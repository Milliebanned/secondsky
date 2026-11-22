// Deploys ForecastLog to Sepolia. Deployer pays gas (OPERATOR_KEY). Owner = COLD_KEY's address, operator = HOT_KEY's address.
// Funds it with 30 test USDC (30 forecasts). Writes ../deployment-forecast.json. Keys never printed.
import { readFileSync, writeFileSync } from "node:fs";
import solc from "solc";
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const DIAMOND = "0x72a70e949362670Bf8bceAd24eFC5b8f950aa08b";
const USDC = "0xcc194e1a843B658526D0D5C431f670028582Ae17";
const env = Object.fromEntries(readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const acct = (k) => privateKeyToAccount(k.startsWith("0x") ? k : "0x" + k);
const deployer = acct(env.OPERATOR_KEY), cold = acct(env.COLD_KEY), hot = acct(env.HOT_KEY);
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
const wal = createWalletClient({ account: deployer, chain: sepolia, transport: http(RPC) });

const src = readFileSync(new URL("../contracts/ForecastLog.sol", import.meta.url), "utf8");
const input = { language: "Solidity", sources: { "ForecastLog.sol": { content: src } },
  settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "metadata"] } } } };
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errs = (out.errors || []).filter((e) => e.severity === "error");
if (errs.length) { console.error(errs.map((e) => e.formattedMessage).join("\n")); process.exit(1); }
const c = out.contracts["ForecastLog.sol"].ForecastLog;
if (process.argv[2] === "compile") { console.log("compiled", c.evm.bytecode.object.length / 2, "bytes"); process.exit(0); }

const hash = await wal.deployContract({ abi: c.abi, bytecode: "0x" + c.evm.bytecode.object, args: [DIAMOND, USDC, cold.address, hot.address] });
const rc = await pub.waitForTransactionReceipt({ hash });
const address = rc.contractAddress;
await pub.waitForTransactionReceipt({ hash: await wal.writeContract({ address: USDC, abi: parseAbi(["function mint(address,uint256)"]), functionName: "mint", args: [address, 30_000_000n] }) });
writeFileSync(new URL("../deployment-forecast.json", import.meta.url), JSON.stringify({
  network: "sepolia", chainId: 11155111, address, deployTx: hash, deployBlock: Number(rc.blockNumber),
  diamond: DIAMOND, usdc: USDC, owner: cold.address, operator: hot.address, abi: c.abi, metadata: c.metadata, source: "contracts/ForecastLog.sol" }, null, 2));
console.log("ForecastLog", address, "block", rc.blockNumber, "funded 30 test USDC");
