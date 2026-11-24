// /api/forecasts — every forecast ForecastLog bought from Telegraph, scored against what was recorded.
//
// For each forecast: Telegraph's answer (who answered, peak rain chance, high, low) and, once the policy
// has settled, the two recorded answers the policy paid on (Open-Meteo archive and NASA POWER).
// Scores:
//   rain call   the forecast "said rain" if its peak chance was 50% or more; the day "was wet" if the
//               average of the two records is 1 mm or more. Right or wrong.
//   Brier       (chance - wet)^2. 0 is perfect, 0.25 is what always saying 50% gets.
//   high / low  forecast minus the average of the two records, °C.
//   warning     hours between buying the forecast and the start of the covered day (UTC).
// Policy 0 is a test purchase with no policy behind it; it is shown but not scored.
import { V2, read, pub, forecastAsks, jobRecord, FORECAST, forecastAbi } from "./_lib.js";

const num = (v) => (v === null || v === undefined || v === "" || isNaN(Number(v)) ? null : Number(v));
const r2 = (v) => (v === null ? null : Math.round(v * 100) / 100);
const avg = (a, b) => (a === null || b === null ? null : (a + b) / 2);

function chanceOf(raw) {
  if (!raw) return null;
  const direct = num(raw.precipitation_probability_pct ?? raw.precip_prob_pct);
  if (direct !== null) return direct;
  const m = /(\d{1,3})\s*%/.exec(raw.content || raw.summary || "");
  return m ? Number(m[1]) : null;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=300");
  try {
    const asks = await forecastAsks();
    const rows = await Promise.all(asks.map(async (a) => {
      const packed = await pub.readContract({ address: FORECAST, abi: forecastAbi, functionName: "answers", args: [a.jobId] });
      const rec = a.record;
      const raw = rec && typeof rec.raw_response === "object" ? rec.raw_response : null;
      const row = {
        policy: Number(a.policyId), location: raw && raw.lat !== undefined ? `${raw.lat},${raw.lon}` : null,
        window_hours: a.windowHours === null ? null : Number(a.windowHours),
        asked_at: a.askedAt, record_url: `https://devnode.telegraphprotocol.com/engine/v1/job/${a.jobId}/result`, job: Number(a.jobId),
        answered: (packed >> 255n) === 1n, answered_by: rec?.miner_slug || null,
        forecast: raw ? { chance_pct: chanceOf(raw), rain_mm: num(raw.precipitation_mm ?? raw.precip_mm), high_c: num(raw.temp_max_c), low_c: num(raw.temp_min_c),
          condition: raw.condition || null, when: raw.when || null } : null,
      };
      if (!row.policy) return { ...row, note: "test purchase, no policy" };

      const p = await read("getPolicy", [a.policyId], V2);
      row.date = p.date;
      row.location = p.location;
      row.warning_hours = Math.round((Date.parse(p.date + "T00:00:00Z") / 1000 - row.asked_at) / 3600);
      if (!p.jobA || !p.jobB) return { ...row, note: "the day has not been settled yet" };
      const [A, B] = await Promise.all([jobRecord(p.jobA), jobRecord(p.jobB)]);
      const ra = A?.raw_response || {}, rb = B?.raw_response || {};
      const rain = avg(num(ra.precipitation_mm), num(rb.precipitation_mm));
      row.recorded = { jobA: Number(p.jobA), jobB: Number(p.jobB), rain_a: num(ra.precipitation_mm), rain_b: num(rb.precipitation_mm),
        high_c: r2(avg(num(ra.temp_max_c), num(rb.temp_max_c))), low_c: r2(avg(num(ra.temp_min_c), num(rb.temp_min_c))) };
      if (rain === null || !row.forecast) return { ...row, note: "waiting for both records" };
      const wet = rain >= 1 ? 1 : 0, c = row.forecast.chance_pct;
      row.score = {
        wet: Boolean(wet),
        rain_call_right: c === null ? null : (c >= 50 ? 1 : 0) === wet,
        brier: c === null ? null : r2((c / 100 - wet) ** 2),
        high_error_c: row.forecast.high_c === null || row.recorded.high_c === null ? null : r2(row.forecast.high_c - row.recorded.high_c),
        low_error_c: row.forecast.low_c === null || row.recorded.low_c === null ? null : r2(row.forecast.low_c - row.recorded.low_c),
      };
      return row;
    }));
    const scored = rows.filter((r) => r.score);
    const mean = (k) => { const v = scored.map((r) => r.score[k]).filter((x) => x !== null && x !== undefined); return v.length ? r2(v.reduce((s, x) => s + Math.abs(x), 0) / v.length) : null; };
    const calls = scored.filter((r) => r.score.rain_call_right !== null);
    res.status(200).json({
      contract: FORECAST,
      summary: { forecasts: rows.length, scored: scored.length,
        rain_calls_right: calls.filter((r) => r.score.rain_call_right).length, rain_calls: calls.length,
        mean_brier: mean("brier"), mean_abs_high_error_c: mean("high_error_c"), mean_abs_low_error_c: mean("low_error_c") },
      rows: rows.sort((x, y) => y.asked_at - x.asked_at),
    });
  } catch (e) {
    res.status(500).json({ error: (e.shortMessage || e.message || "").slice(0, 200) });
  }
}
