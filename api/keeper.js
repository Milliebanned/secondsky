// GET /api/keeper  (Vercel cron, daily). Settles policies whose day is due and finalizes policies
// whose two answers have arrived. Anyone can do the same from the website: settle() and finalize()
// are open to every caller. Only the cron (CRON_SECRET) can make this endpoint spend gas.
import { ADDR, abi, read, pub, operator } from "./_lib.js";

const ACTIVE = 1, SETTLING = 2;
const done = (v) => (v >> 255n) === 1n;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: "cron only" });

  const { account, wallet } = operator();
  const now = BigInt(Math.floor(Date.now() / 1000));
  const count = Number(await read("policyCount"));
  const sent = [], skipped = [];
  let nonce = await pub.getTransactionCount({ address: account.address, blockTag: "pending" });
  const maxJob = await read("maxJobBudget");
  let free = await read("freeCapital");

  for (let id = 1; id <= count && sent.length < 8; id++) {
    const p = await read("getPolicy", [BigInt(id)]);
    try {
      if (p.status === ACTIVE && now >= p.settleAfter) {
        if (p.jobReserve === 0n && free < 2n * maxJob) { skipped.push({ id, why: "pool cannot fund a retry" }); continue; }
        await pub.simulateContract({ address: ADDR, abi, functionName: "settle", args: [BigInt(id)], account });
        const h = await wallet.writeContract({ address: ADDR, abi, functionName: "settle", args: [BigInt(id)], nonce: nonce++ });
        if (p.jobReserve === 0n) free -= 2n * maxJob;
        sent.push({ id, action: "settle", tx: h });
      } else if (p.status === SETTLING) {
        const [a, b] = await Promise.all([read("answers", [p.jobA]), read("answers", [p.jobB])]);
        if (!done(a) || !done(b)) continue;
        const h = await wallet.writeContract({ address: ADDR, abi, functionName: "finalize", args: [BigInt(id)], nonce: nonce++ });
        sent.push({ id, action: "finalize", tx: h });
      }
    } catch (e) {
      skipped.push({ id, why: (e.shortMessage || e.message || "").slice(0, 120) });
    }
  }
  res.status(200).json({ policies: count, sent, skipped });
}
