// Shared NASA POWER helpers for the SecondSky miner.
const GEO = "https://geocoding-api.open-meteo.com/v1/search"; // place lookup only, not weather data
const POWER = "https://power.larc.nasa.gov/api/temporal/daily/point";

export async function getJson(url, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "SecondSky-miner/1.1" } });
    if (!r.ok) throw new Error(`upstream ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// "Nairobi", "Kerman, California", "Lagos, Nigeria" or "lat,lon". The most populous match wins,
// narrowed by any hint after the comma.
export async function resolvePlace(location) {
  const m = location.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m) {
    const lat = Number(m[1]), lon = Number(m[2]);
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return { error: "coordinates_out_of_range" };
    return { lat, lon, name: `${lat},${lon}`, timezone: null };
  }
  const name = location.split(",")[0].trim();
  const hint = location.includes(",") ? location.split(",").slice(1).join(",").trim().toLowerCase() : "";
  if (!name) return { error: "place_not_found" };
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

// The day must have ended in the place's own calendar (fallback: UTC+14, the latest zone).
export function dayIsOver(date, timezone) {
  const now = new Date();
  const local = timezone
    ? new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now)
    : new Date(now.getTime() - 14 * 3600e3).toISOString().slice(0, 10);
  return date < local;
}

export const validDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d + "T00:00:00Z"));

// One day of NASA POWER. Returns { rain, tmax, tmin } or { error }.
export async function dayRecord(place, date) {
  const ymd = date.replaceAll("-", "");
  let p;
  try {
    p = await getJson(`${POWER}?parameters=PRECTOTCORR,T2M_MAX,T2M_MIN&community=AG&latitude=${place.lat}&longitude=${place.lon}&start=${ymd}&end=${ymd}&format=JSON`, 12000);
  } catch {
    return { error: "provider_unavailable" };
  }
  const par = p?.properties?.parameter;
  const rain = par?.PRECTOTCORR?.[ymd], tmax = par?.T2M_MAX?.[ymd], tmin = par?.T2M_MIN?.[ymd];
  const missing = (v) => v === undefined || v === null || v <= -998; // NASA uses -999 for "no value yet"
  if (missing(rain) || missing(tmax) || missing(tmin)) return { error: "no_archive_value" };
  return { rain: r2(rain), tmax: r2(tmax), tmin: r2(tmin) };
}

export const r2 = (v) => Math.round(v * 100) / 100;
export const condition = (rain) => (rain >= 10 ? "heavy rain" : rain >= 2.5 ? "rain" : rain >= 0.2 ? "light rain" : "dry");
export const SOURCE = "NASA POWER daily (PRECTOTCORR, T2M_MAX, T2M_MIN), satellite and MERRA-2 reanalysis for the location's grid cell, not a station reading";
