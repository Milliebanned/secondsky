// Sends 0.02 Sepolia ETH from your Telegraph CLI wallet to the SecondSky operator wallet,
// so the app can deploy and run on its own. Testnet only.
// Usage: cd /Users/Apple/Telegraph/scripts && node fund-operator.mjs
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createWalletClient, createPublicClient, http, parseEther, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const OPERATOR = "0x53e0B81ea35051B38503C1A34dd97d1558466657";
const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const w = JSON.parse(readFileSync(`${homedir()}/.telegraph/wallet.json`, "utf8"));
let pk = w.privateKey ?? w.private_key ?? w.key ?? w.pk ?? w.wallet?.privateKey;
if (!pk.startsWith("0x")) pk = "0x" + pk;
const account = privateKeyToAccount(pk);
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: sepolia, transport: http(RPC) });

console.log("From:", account.address, "balance", formatEther(await pub.getBalance({ address: account.address })), "ETH");
const hash = await wallet.sendTransaction({ to: OPERATOR, value: parseEther("0.02") });
await pub.waitForTransactionReceipt({ hash });
console.log("Sent 0.02 ETH to the operator:", `https://sepolia.etherscan.io/tx/${hash}`);
console.log("Operator balance:", formatEther(await pub.getBalance({ address: OPERATOR })), "ETH");
