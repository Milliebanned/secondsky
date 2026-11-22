// /api/keeper
//   Cron (daily, Authorization: Bearer CRON_SECRET): walks every policy on v2 and v1.
//   Public  (?policy=N):  does the same for one v2 policy, so the buy page can finish a settlement
//                         without waiting for the cron. It can only do what the contract rules allow.
//
// For each policy:
//   Active, the day before         -> buy Telegraph's forecast for the day (ForecastLog), once
//   Active and due                 -> settle() once NASA POWER has published that day (the contract buys both answers from Telegraph)
//   Settling, both answers in      -> v2: check Telegraph's job records that the NAMED miner answered each job.
//                                         wrong miner -> rejectWrongMiner() (back to Active, bought again)
//                                         right miners -> finalize() at once (operator)
//                                     v1: finalize()  (open to anyone)
import { V1, V2, abi, read, pub, hot, minerAddress, jobMiner, nasaReady, FORECAST, forecastAbi, forecastAsks } from "./_lib.js";

const ACTIVE = 1, SETTLING = 2;
const done = (v) => (v >> 255n) === 1n;

async function step(address, id, ctx) {
  const p = await read("getPolicy", [BigInt(id)], address);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const tx = (functionName, args) => ctx.wallet.writeContract({ address, abi, functionName, args, nonce: ctx.nonce++ });

  if (p.status === ACTIVE && now >= p.settleAfter) {
    if (!(await nasaReady(p.location, p.date))) return { id, waiting: `NASA POWER has not published ${p.date} yet; not buying answers until it has` };
    await pub.simulateContract({ address, abi, functionName: "settle", args: [BigInt(id)], account: ctx.account });
    return { id, contract: address === V2 ? "v2" : "v1", action: "settle", tx: await tx("settle", [BigInt(id)]) };
  }
  if (p.status === ACTIVE && address === V2 && ctx.cron) {
    // The day before a covered day: buy Telegraph's forecast for it, once. Scored later against what was recorded.
    const dayStart = Date.parse(p.date + "T00:00:00Z") / 1000;
    const t = Number(now);
    if (t < dayStart && dayStart - t <= 36 * 3600 && !(await forecastAsks(id)).length) {
      const windowHours = Math.min(240, Math.ceil((dayStart + 86400 - t) / 3600));
      await pub.simulateContract({ address: FORECAST, abi: forecastAbi, functionName: "ask", args: [BigInt(id), p.location, BigInt(windowHours)], account: ctx.account });
      const h = await ctx.wallet.writeContract({ address: FORECAST, abi: forecastAbi, functionName: "ask", args: [BigInt(id), p.location, BigInt(windowHours)], nonce: ctx.nonce++ });
      return { id, action: "forecast", windowHours, tx: h };
    }
  }
  if (p.status !== SETTLING) return null;
  const [a, b] = await Promise.all([read("answers", [p.jobA], address), read("answers", [p.jobB], address)]);
  if (!done(a) || !done(b)) return { id, waiting: "Telegraph has not delivered both answers yet" };

  if (address === V2) {
    const expect = [await ctx.miner(ctx.sourceA), await ctx.miner(ctx.sourceB)];
    const got = await Promise.all([jobMiner(p.jobA), jobMiner(p.jobB)]);
    for (let i = 0; i < 2; i++) {
      const job = i ? p.jobB : p.jobA;
      if (!got[i] || !got[i].address) return { id, waiting: `Telegraph's record for job ${job} is not published yet` };
      if (!expect[i] || got[i].address !== expect[i]) {
        return { id, action: "rejectWrongMiner", job: Number(job), answeredBy: got[i].slug, tx: await tx("rejectWrongMiner", [BigInt(id), job]) };
      }
    }
  }
  return { id, contract: address === V2 ? "v2" : "v1", action: "finalize", tx: await tx("finalize", [BigInt(id)]) };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const { account, wallet } = hot();
  const ctx = { account, wallet, nonce: await pub.getTransactionCount({ address: account.address, blockTag: "pending" }) };
  const cache = {};
  ctx.miner = async (reg) => (cache[reg] ??= await minerAddress(reg));
  [ctx.sourceA, ctx.sourceB] = await Promise.all([read("sourceA"), read("sourceB")]);

  const one = req.query && req.query.policy;
  if (one !== undefined) {
    const id = Number(one);
    if (!Number.isInteger(id) || id < 1 || BigInt(id) > (await read("policyCount"))) return res.status(400).json({ error: "unknown policy" });
    try {
      const result = await step(V2, id, ctx);
      // wait for it to land, so the next call (often from the same page) gets a fresh nonce
      if (result && result.tx) await pub.waitForTransactionReceipt({ hash: result.tx, timeout: 45_000 }).catch(() => {});
      return res.status(200).json({ result });
    }
    catch (e) { return res.status(200).json({ result: null, note: (e.shortMessage || e.message || "").slice(0, 160) }); }
  }

  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: "cron only (or pass ?policy=N)" });
  ctx.cron = true;
  const results = [];
  for (const address of [V2, V1]) {
    const count = Number(await read("policyCount", [], address));
    for (let id = 1; id <= count && results.filter((r) => r && r.tx).length < 8; id++) {
      try { const r = await step(address, id, ctx); if (r) results.push({ contract: address === V2 ? "v2" : "v1", ...r }); }
      catch (e) { results.push({ contract: address === V2 ? "v2" : "v1", id, skipped: (e.shortMessage || e.message || "").slice(0, 120) }); }
    }
  }
  res.status(200).json({ results });
}
