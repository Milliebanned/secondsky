// SecondSky NASA rainfall miner: WEATHER_FORECAST_VERIFY_GENERAL
// GET /api/verify?location=Nairobi&date=2026-11-05[&forecast_precipitation_mm=12&forecast_temp_max_c=28&forecast_temp_min_c=15]
// Returns the recorded rain, high and low for a past day from NASA POWER (satellite + MERRA-2
// reanalysis), an upstream independent of Open-Meteo. If a forecast is supplied, scores it.
// Refuses instead of guessing.
import { resolvePlace, dayIsOver, validDate, dayRecord, condition, SOURCE } from "../lib/nasa.js";

function refuse(res, status, code, message, extra = {}) {
  res.status(status).json({ error: message, code, ...extra });
}

// Tolerances, stated in every answer: rain within max(2 mm, 25% of the forecast) and on the same
// side of 0.2 mm (wet/dry); temperatures within 2 °C.
const RAIN_ABS = 2, RAIN_REL = 0.25, TEMP_TOL = 2, WET = 0.2;

function num(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

export function scoreForecast(rec, fc) {
  const checks = [];
  if (fc.rain !== null) {
    const tol = Math.max(RAIN_ABS, RAIN_REL * fc.rain);
    const ok = Math.abs(rec.rain - fc.rain) <= tol && (rec.rain >= WET) === (fc.rain >= WET);
    checks.push({ field: "precipitation_mm", forecast: fc.rain, observed: rec.rain, tolerance: Math.round(tol * 100) / 100, verified: ok });
  }
  if (fc.tmax !== null) checks.push({ field: "temp_max_c", forecast: fc.tmax, observed: rec.tmax, tolerance: TEMP_TOL, verified: Math.abs(rec.tmax - fc.tmax) <= TEMP_TOL });
  if (fc.tmin !== null) checks.push({ field: "temp_min_c", forecast: fc.tmin, observed: rec.tmin, tolerance: TEMP_TOL, verified: Math.abs(rec.tmin - fc.tmin) <= TEMP_TOL });
  if (!checks.length) return { verdict: "no_forecast_supplied", checks };
  return { verdict: checks.every((c) => c.verified) ? "verified" : "missed", checks };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const q = req.query || {};
  const location = (q.location || "").toString().slice(0, 256);
  const date = (q.date || "").toString().slice(0, 10);
  const fc = { rain: num(q.forecast_precipitation_mm), tmax: num(q.forecast_temp_max_c), tmin: num(q.forecast_temp_min_c) };

  if (!location) return refuse(res, 400, "location_required", "location is required");
  if (!date) return refuse(res, 400, "date_required", "date is required (YYYY-MM-DD)");
  if (!validDate(date)) return refuse(res, 400, "invalid_date", "date must be YYYY-MM-DD");
  if ([fc.rain, fc.tmax, fc.tmin].some(Number.isNaN)) return refuse(res, 400, "invalid_forecast", "forecast values must be numbers");
  if (fc.rain !== null && fc.rain < 0) return refuse(res, 400, "invalid_forecast", "forecast precipitation cannot be negative");

  let place;
  try { place = await resolvePlace(location); }
  catch { return refuse(res, 502, "provider_unavailable", "place lookup failed"); }
  if (place.error === "coordinates_out_of_range") return refuse(res, 400, place.error, "coordinates out of range");
  if (place.error) return refuse(res, 422, place.error, `could not find "${location}"`);
  if (!dayIsOver(date, place.timezone))
    return refuse(res, 422, "window_not_finished", "that day has not ended at this place yet", { retry_after_seconds: 86400 });

  const rec = await dayRecord(place, date);
  if (rec.error === "provider_unavailable") return refuse(res, 502, rec.error, "NASA POWER did not answer");
  if (rec.error) return refuse(res, 422, rec.error, "NASA POWER has no value for that day yet (it publishes with a few days' delay)", { retry_after_seconds: 86400 });

  const score = scoreForecast(rec, fc);
  const record = `NASA POWER records ${rec.rain} mm of precipitation, a high of ${rec.tmax}°C and a low of ${rec.tmin}°C for ${place.name} on ${date}`;
  const tail = " (satellite and MERRA-2 reanalysis for the location's grid cell, not a station reading).";
  const verdictText = score.verdict === "no_forecast_supplied" ? "" :
    ` The supplied forecast ${score.verdict === "verified" ? "verified" : "missed"}: ` +
    score.checks.map((c) => `${c.field} forecast ${c.forecast} vs ${c.observed} observed (±${c.tolerance}) ${c.verified ? "ok" : "off"}`).join("; ") + ".";

  res.status(200).json({
    content: record + tail + verdictText,
    location: place.name,
    date,
    temp_max_c: rec.tmax,
    temp_min_c: rec.tmin,
    precipitation_mm: rec.rain,
    condition: condition(rec.rain),
    verdict: score.verdict,
    forecast_checks: score.checks,
    source: SOURCE,
    coordinates: { lat: place.lat, lon: place.lon },
  });
}
