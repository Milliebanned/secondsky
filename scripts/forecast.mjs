// Buys one WEATHER_FORECAST_GENERAL answer from Telegraph through ForecastLog (router picks the miner),
// waits for it, and prints Telegraph's record.   node forecast.mjs <policyId> <location> <windowHours>
// Signs with HOT_KEY from ../.env (ForecastLog's operator). Never printed. Testnet, test USDC.
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const dep = JSON.parse(readFileSync(new URL("../deployment-forecast.json", import.meta.url), "utf8"));
const env = Object.fromEntries(readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n").filter((l) => l.includes("="))
  .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const k = env.HOT_KEY; const account = privateKeyToAccount(k.startsWith("0x") ? k : "0x" + k);
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
const wal = createWalletClient({ account, chain: sepolia, transport: http(RPC) });
const C = { address: dep.address, abi: dep.abi };

const [policyId, location, win = "24"] = process.argv.slice(2);
const { request, result: jobId } = await pub.simulateContract({ ...C, functionName: "ask", args: [BigInt(policyId), location, BigInt(win)], account });
const h = await wal.writeContract(request);
await pub.waitForTransactionReceipt({ hash: h });
console.log("job", jobId, "tx", h);
const t0 = Date.now();
for (let i = 0; i < 40; i++) {
  await new Promise((s) => setTimeout(s, 30_000));
  const v = await pub.readContract({ ...C, functionName: "answers", args: [jobId] });
  if (v >> 255n) {
    const s64 = (x) => { x &= (1n << 64n) - 1n; return Number(x >= 1n << 63n ? x - (1n << 64n) : x) / 1e6; };
    console.log("answered after", Math.round((Date.now() - t0) / 1000), "s ok", Boolean((v >> 254n) & 1n), "high", s64(v), "low", s64(v >> 64n));
    const r = await fetch(`https://devnode.telegraphprotocol.com/engine/v1/job/${jobId}/result`, { headers: { "User-Agent": "SecondSky/2.0" } });
    console.log(r.status, (await r.text()).slice(0, 3000));
    break;
  }
}
