// SecondSky NASA rainfall miner — WEATHER_FORECAST_VERIFY_GENERAL
// GET /api/verify?location=Nairobi&date=2026-11-05
// Returns the recorded rain, high and low for a past day from NASA POWER (satellite + MERRA-2
// reanalysis), an upstream independent of Open-Meteo. Refuses instead of guessing.

const GEO = "https://geocoding-api.open-meteo.com/v1/search"; // place lookup only, not weather data
const POWER = "https://power.larc.nasa.gov/api/temporal/daily/point";

function refuse(res, status, code, message, extra = {}) {
  res.status(status).json({ error: message, code, ...extra });
}

async function getJson(url, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "SecondSky-miner/1.0" } });
    if (!r.ok) throw new Error(`upstream ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function resolvePlace(location) {
  const m = location.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m) {
    const lat = Number(m[1]), lon = Number(m[2]);
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return { error: "coordinates_out_of_range" };
    return { lat, lon, name: `${lat},${lon}`, timezone: null };
  }
  const name = location.split(",")[0].trim();
  const hint = location.includes(",") ? location.split(",").slice(1).join(",").trim().toLowerCase() : "";
  const g = await getJson(`${GEO}?name=${encodeURIComponent(name)}&count=10&language=en&format=json`);
  let hits = g.results || [];
  if (hint) {
    const narrowed = hits.filter((h) =>
      [h.country, h.country_code, h.admin1, h.admin2].filter(Boolean).some((v) => v.toLowerCase().includes(hint) || hint.includes(v.toLowerCase())));
    if (narrowed.length) hits = narrowed;
  }
  if (!hits.length) return { error: "place_not_found" };
  const h = hits.sort((a, b) => (b.population || 0) - (a.population || 0))[0];
  return { lat: h.latitude, lon: h.longitude, name: `${h.name}, ${h.country}`, timezone: h.timezone };
}

function dayIsOver(date, timezone) {
  // the day must have ended in the place's own calendar (fallback: UTC+14, the latest zone)
  const now = new Date();
  const local = timezone
    ? new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now)
    : new Date(now.getTime() - 14 * 3600e3).toISOString().slice(0, 10);
  return date < local;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const q = req.query || {};
  const location = (q.location || "").toString().slice(0, 256);
  const date = (q.date || "").toString().slice(0, 10);

  if (!location) return refuse(res, 400, "location_required", "location is required");
  if (!date) return refuse(res, 400, "date_required", "date is required (YYYY-MM-DD)");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date + "T00:00:00Z")))
    return refuse(res, 400, "invalid_date", "date must be YYYY-MM-DD");

  let place;
  try { place = await resolvePlace(location); }
  catch { return refuse(res, 502, "provider_unavailable", "place lookup failed"); }
  if (place.error === "coordinates_out_of_range") return refuse(res, 400, place.error, "coordinates out of range");
  if (place.error) return refuse(res, 422, place.error, `could not find "${location}"`);
  if (!dayIsOver(date, place.timezone))
    return refuse(res, 422, "window_not_finished", "that day has not ended at this place yet", { retry_after_seconds: 86400 });

  const ymd = date.replaceAll("-", "");
  let p;
  try {
    p = await getJson(`${POWER}?parameters=PRECTOTCORR,T2M_MAX,T2M_MIN&community=AG&latitude=${place.lat}&longitude=${place.lon}&start=${ymd}&end=${ymd}&format=JSON`, 12000);
  } catch {
    return refuse(res, 502, "provider_unavailable", "NASA POWER did not answer");
  }
  const par = p?.properties?.parameter;
  const rain = par?.PRECTOTCORR?.[ymd], tmax = par?.T2M_MAX?.[ymd], tmin = par?.T2M_MIN?.[ymd];
  const missing = (v) => v === undefined || v === null || v <= -998; // NASA uses -999 for "no value yet"
  if (missing(rain) || missing(tmax) || missing(tmin))
    return refuse(res, 422, "no_archive_value", "NASA POWER has no value for that day yet (it publishes with a few days' delay)", { retry_after_seconds: 86400 });

  const r2 = (v) => Math.round(v * 100) / 100;
  res.status(200).json({
    content: `NASA POWER records ${r2(rain)} mm of precipitation, a high of ${r2(tmax)}°C and a low of ${r2(tmin)}°C for ${place.name} on ${date} (satellite and MERRA-2 reanalysis for the location's grid cell, not a station reading).`,
    location: place.name,
    date,
    temp_max_c: r2(tmax),
    temp_min_c: r2(tmin),
    precipitation_mm: r2(rain),
    condition: rain >= 10 ? "heavy rain" : rain >= 2.5 ? "rain" : rain >= 0.2 ? "light rain" : "dry",
    verdict: "no_forecast_supplied",
    source: "NASA POWER daily (PRECTOTCORR, T2M_MAX, T2M_MIN)",
    coordinates: { lat: place.lat, lon: place.lon },
  });
}
