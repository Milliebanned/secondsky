// POST /api/quote  {holder, lat, lon, date, threshold_mm, payout_usdc}
// Prices one day of rain cover for SecondSky v2 and signs the quote with the operator (hot) key.
// v2 pays 100% if both sources reach the limit, 50% if they split, 0 if neither. So the price uses
// 10 years of BOTH sources at that spot, for days within a week of the covered date:
//   expected share = P(both >= limit) + 0.5 x P(exactly one >= limit)
//   Cover  (a future day):  premium = payout x expected share x 1.2 + 2 USDC evidence cost
//   Replay (a past day, >= 5 days ago): premium = payout + 2 USDC. Exists so anyone can test settlement
//          end to end today; it can never make the buyer money.
import { isAddress } from "viem";
import { V2 as ADDR, read, hot } from "./_lib.js";

const DAY = 86400;
const EVIDENCE = 2;          // two Telegraph jobs at 1 USDC
const LOAD = 1.2;            // underwriter margin on the expected payout
const MAX_P = 0.5;           // above this, rain is the normal case: not insurable as cover
const NASA_LAG_DAYS = 5;     // NASA POWER publishes daily values a few days late
const LATEST_TZ_H = 14;      // the day has ended everywhere 14h after UTC midnight of the next day

const bad = (res, code, error) => res.status(400).json({ code, error });
const r2 = (v) => Math.round(v * 100) / 100;
const pct = (v) => `${Math.round(v * 1000) / 10}%`;

function inWindow(dayIso, md) {
  const target = Date.parse(`2000-${md}T00:00:00Z`), doy = Date.parse(`2000-${dayIso.slice(5)}T00:00:00Z`);
  let diff = Math.abs(doy - target) / (DAY * 1000);
  return Math.min(diff, 366 - diff) <= 7;
}

// Same calendar window (+-7 days) in each of the last 10 full years, from both upstreams.
async function history(lat, lon, date) {
  const y = Math.min(Number(date.slice(0, 4)), new Date().getUTCFullYear());
  const start = `${y - 10}-01-01`, end = `${y - 1}-12-31`, md = date.slice(5);
  const ua = { headers: { "User-Agent": "SecondSky-quote/2.0" } };
  const [om, nasa] = await Promise.all([
    fetch(`https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${start}&end_date=${end}&daily=precipitation_sum&timezone=GMT`, ua).then((r) => { if (!r.ok) throw new Error("om"); return r.json(); }),
    fetch(`https://power.larc.nasa.gov/api/temporal/daily/point?parameters=PRECTOTCORR&community=AG&latitude=${lat}&longitude=${lon}&start=${start.replaceAll("-", "")}&end=${end.replaceAll("-", "")}&format=JSON`, ua).then((r) => { if (!r.ok) throw new Error("nasa"); return r.json(); }),
  ]);
  const n = nasa.properties.parameter.PRECTOTCORR;
  const days = [];
  om.daily.time.forEach((t, i) => {
    const a = om.daily.precipitation_sum[i], b = n[t.replaceAll("-", "")];
    if (a == null || b == null || b <= -998 || !inWindow(t, md)) return;
    days.push([a, b]);
  });
  return days;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = {}; } }
  b = b || {};
  const holder = String(b.holder || "");
  const lat = Number(b.lat), lon = Number(b.lon);
  const date = String(b.date || "");
  const limit = Number(b.threshold_mm), payout = Number(b.payout_usdc);

  if (!isAddress(holder)) return bad(res, "bad_holder", "holder must be a wallet address");
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return bad(res, "bad_place", "pick a place");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date + "T00:00:00Z"))) return bad(res, "bad_date", "date must be YYYY-MM-DD");
  if (!(limit >= 1 && limit <= 100)) return bad(res, "bad_limit", "rain limit must be 1 to 100 mm");
  if (!(payout >= 1 && payout <= 50)) return bad(res, "bad_payout", "payout must be 1 to 50 USDC on this testnet pool");

  const now = Math.floor(Date.now() / 1000);
  const dayStart = Date.parse(date + "T00:00:00Z") / 1000;
  const daysAhead = (dayStart - now) / DAY;
  let mode;
  if (daysAhead >= 1 && daysAhead <= 90) mode = "cover";
  else if (-daysAhead >= NASA_LAG_DAYS && -daysAhead <= 365) mode = "replay";
  else return bad(res, "bad_window", `cover is sold for a day 1 to 90 days ahead; replays need a day at least ${NASA_LAG_DAYS} days ago (NASA publishes late)`);

  const location = `${lat.toFixed(4)},${lon.toFixed(4)}`; // both sources read "lat,lon" the same way
  let premium, p = null, sample = 0, both = 0, split = 0;
  if (mode === "cover") {
    let days;
    try { days = await history(lat, lon, date); } catch { return res.status(502).json({ code: "history_unavailable", error: "could not load rain history, try again" }); }
    sample = days.length;
    if (sample < 60) return res.status(502).json({ code: "history_thin", error: "not enough rain history for this spot" });
    both = days.filter(([a, b]) => a >= limit && b >= limit).length / sample;
    split = days.filter(([a, b]) => (a >= limit) !== (b >= limit)).length / sample;
    p = both + 0.5 * split;
    if (p > MAX_P) return bad(res, "too_likely", `the expected payout here is ${Math.round(p * 100)}% of the cover on days like this; that is the normal weather, not a risk to insure`);
    premium = r2(payout * Math.max(p, 0.02) * LOAD + EVIDENCE);
  } else {
    premium = r2(payout + EVIDENCE);
  }
  const settleAfter = mode === "cover" ? dayStart + DAY + LATEST_TZ_H * 3600 + NASA_LAG_DAYS * DAY : now;

  const payoutU = BigInt(Math.round(payout * 1e6)), premiumU = BigInt(Math.round(premium * 1e6));
  const [free, maxJob, maxPay] = await Promise.all([read("freeCapital"), read("maxJobBudget"), read("maxPayout")]);
  if (payoutU > maxPay) return bad(res, "bad_payout", `payout is capped at ${Number(maxPay) / 1e6} USDC per policy`);
  if (free < payoutU + 2n * maxJob) return res.status(409).json({ code: "pool_full", error: "the pool cannot take this much more cover right now" });

  const expiry = now + 15 * 60;
  const thresholdE6 = BigInt(Math.round(limit * 1e6));
  const hash = await read("quoteHash", [holder, location, date, BigInt(settleAfter), thresholdE6, payoutU, premiumU, BigInt(expiry)]);
  const sig = await hot().account.signMessage({ message: { raw: hash } });

  res.status(200).json({
    mode, contract: ADDR,
    args: { location, date, settleAfter, thresholdE6: thresholdE6.toString(), payout: payoutU.toString(), premium: premiumU.toString(), quoteExpiry: expiry, sig },
    premium_usdc: premium, payout_usdc: payout, threshold_mm: limit,
    expected_share: p, p_both: both, p_split: split, sample_days: sample,
    settle_after_iso: new Date(settleAfter * 1000).toISOString(),
    explain: mode === "cover"
      ? `Over the last 10 years, on ${sample} days within a week of ${date.slice(5)} here, both sources recorded ${limit} mm or more on ${pct(both)} and they split on ${pct(split)}. Expected payout share ${pct(p)} (100% when both, 50% when split). Premium = ${payout} x ${Math.max(p, 0.02).toFixed(3)} x ${LOAD} + ${EVIDENCE} USDC to buy the two answers from Telegraph.`
      : `Replay of a past day to test settlement. Premium = payout + ${EVIDENCE} USDC, so it cannot make money; it shows the contract buying both answers and deciding.`,
  });
}
