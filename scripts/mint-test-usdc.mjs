// Mints test USDC (Telegraph beta-2 token on Ethereum Sepolia) to your Telegraph CLI wallet.
// Usage:  cd /Users/Apple/Telegraph/scripts && npm install viem && node mint-test-usdc.mjs [amount]
// Your private key is read locally from ~/.telegraph/wallet.json and never printed or sent anywhere
// except to sign the transaction.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createWalletClient, createPublicClient, http, parseAbi, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const USDC = "0xcc194e1a843B658526D0D5C431f670028582Ae17";
const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const amount = Number(process.argv[2] ?? 10); // USDC, default 10

const w = JSON.parse(readFileSync(`${homedir()}/.telegraph/wallet.json`, "utf8"));
let pk = w.privateKey ?? w.private_key ?? w.key ?? w.pk ?? w.wallet?.privateKey;
if (!pk) { console.error("Could not find the key field in ~/.telegraph/wallet.json. Field names:", Object.keys(w)); process.exit(1); }
if (!pk.startsWith("0x")) pk = "0x" + pk;

const account = privateKeyToAccount(pk);
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: sepolia, transport: http(RPC) });
const abi = parseAbi(["function mint(address,uint256)", "function balanceOf(address) view returns (uint256)"]);

console.log("Wallet:", account.address);
const eth = await pub.getBalance({ address: account.address });
console.log("Sepolia ETH:", formatEther(eth));
if (eth === 0n) { console.error("You need a little Sepolia ETH for the fee first (Google Sepolia faucet)."); process.exit(1); }

const hash = await wallet.writeContract({ address: USDC, abi, functionName: "mint", args: [account.address, BigInt(amount * 1e6)] });
console.log("Mint tx:", `https://sepolia.etherscan.io/tx/${hash}`);
await pub.waitForTransactionReceipt({ hash });
const bal = await pub.readContract({ address: USDC, abi, functionName: "balanceOf", args: [account.address] });
console.log("Test USDC balance:", Number(bal) / 1e6);
