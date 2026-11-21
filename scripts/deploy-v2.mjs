// Deploys SecondSky v2 to Sepolia. Owner = OPERATOR_KEY (cold, stays local). Operator = HOT_KEY (quotes + keeper,
// created here if missing). Funds the pool with test USDC and the hot key with a little ETH. Writes ../deployment-v2.json.
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import solc from "solc";
import { createPublicClient, createWalletClient, http, parseAbi, parseEther, formatEther } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { sepolia } from "viem/chains";

const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const DIAMOND = "0x72a70e949362670Bf8bceAd24eFC5b8f950aa08b";
const USDC = "0xcc194e1a843B658526D0D5C431f670028582Ae17";
const SOURCE_A = 5130n, SOURCE_B = 6151n, MAX_JOB = 1_500_000n, MAX_PAYOUT = 50_000_000n, POOL = 300_000_000n;

const envPath = new URL("../.env", import.meta.url);
const env = () => Object.fromEntries(readFileSync(envPath, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const acct = (k) => privateKeyToAccount(k.startsWith("0x") ? k : "0x" + k);
if (!env().HOT_KEY) appendFileSync(envPath, `HOT_KEY=${generatePrivateKey()}\n`);
const owner = acct(env().OPERATOR_KEY), hot = acct(env().HOT_KEY);
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
const wal = createWalletClient({ account: owner, chain: sepolia, transport: http(RPC) });

const solInput = { language: "Solidity", sources: { "SecondSkyV2.sol": { content: readFileSync(new URL("../contracts/SecondSkyV2.sol", import.meta.url), "utf8") } },
  settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "metadata"] } } } };
const out = JSON.parse(solc.compile(JSON.stringify(solInput)));
const errs = (out.errors || []).filter((e) => e.severity === "error");
if (errs.length) { console.error(errs.map((e) => e.formattedMessage).join("\n")); process.exit(1); }
const c = out.contracts["SecondSkyV2.sol"].SecondSkyV2;

console.log("owner", owner.address, formatEther(await pub.getBalance({ address: owner.address })), "ETH; operator (hot)", hot.address);
const hash = await wal.deployContract({ abi: c.abi, bytecode: "0x" + c.evm.bytecode.object, args: [DIAMOND, USDC, SOURCE_A, SOURCE_B, MAX_JOB, MAX_PAYOUT, hot.address] });
const rc = await pub.waitForTransactionReceipt({ hash });
const address = rc.contractAddress;
console.log("SecondSky v2:", `https://sepolia.etherscan.io/address/${address}`);
const erc = parseAbi(["function mint(address,uint256)"]);
await pub.waitForTransactionReceipt({ hash: await wal.writeContract({ address: USDC, abi: erc, functionName: "mint", args: [address, POOL] }) });
await pub.waitForTransactionReceipt({ hash: await wal.sendTransaction({ to: hot.address, value: parseEther("0.006") }) });
console.log("pool 300 test USDC, hot key 0.006 ETH");
writeFileSync(new URL("../deployment-v2.json", import.meta.url), JSON.stringify({
  network: "sepolia", chainId: 11155111, version: 2, address, deployTx: hash, deployBlock: Number(rc.blockNumber),
  diamond: DIAMOND, usdc: USDC, sourceA: 5130, sourceB: 6151, maxJobBudget: 1500000, maxPayout: 50000000,
  owner: owner.address, operator: hot.address, compiler: solc.version(), abi: c.abi, metadata: c.metadata,
}, null, 2));
console.log("saved deployment-v2.json");
