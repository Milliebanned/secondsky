// SecondSky NASA miner: EVENT_OUTCOME_RESOLUTION_GENERAL, for weather conditions only.
// POST /api/resolve  {"event": "Did at least 10 mm of rain fall in Lagos on 2026-11-10?"}
// (GET ?event=... also works.) Resolves rain / daily-high / daily-low conditions for a named place
// and past day against NASA POWER. Anything that is not a checkable weather condition is refused,
// never guessed. A day NASA has not published yet is "unresolved".
import { resolvePlace, dayIsOver, validDate, dayRecord, SOURCE } from "../lib/nasa.js";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MEASURABLE_MM = 0.2; // "did it rain" with no amount means at least 0.2 mm (measurable rain)

function parseDate(t) {
  let m = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const mon = "(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
  m = t.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${mon},?\\s+(\\d{4})\\b`, "i"));
  if (m) return iso(m[3], m[2], m[1]);
  m = t.match(new RegExp(`\\b${mon}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "i"));
  if (m) return iso(m[3], m[1], m[2]);
  return null;
}
function iso(y, mon, d) {
  const i = MONTHS.indexOf(mon.slice(0, 3).toLowerCase());
  if (i < 0) return null;
  return `${y}-${String(i + 1).padStart(2, "0")}-${String(Number(d)).padStart(2, "0")}`;
}

function parsePlace(t) {
  const ll = t.match(/(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/);
  if (ll && /\b(at|in|near|for)\s+-?\d/.test(t)) return `${ll[1]},${ll[2]}`;
  // "in Lagos on ...", "in Kerman, California on ...", "at London Heathrow during ..."
  const m = t.match(/\b(?:in|at|for|over)\s+([A-Z][\p{L}.'-]*(?:[ -][A-Z][\p{L}.'-]*)*(?:,\s*[A-Z][\p{L}.'-]*(?:[ -][A-Z][\p{L}.'-]*)*)?)/u);
  if (m) return m[1].trim();
  // "Was London dry on ...", "Did Lagos get 10 mm ..."
  const s = t.match(/\b(?:[Ww]as|[Ww]ere|[Dd]id|[Ii]s)\s+([A-Z][\p{L}.'-]*(?:[ -][A-Z][\p{L}.'-]*)*(?:,\s*[A-Z][\p{L}.'-]*)?)\s+(?:dry|wet|get|see|have|record)/u);
  return s ? s[1].trim() : null;
}

// Returns { metric: "rain"|"tmax"|"tmin", op, value, unit } or { error }.
function parseCondition(t) {
  const s = t.toLowerCase();
  const metric = /\b(rain|rainfall|precipitation|precip|rained|raining|wet|dry)\b/.test(s) ? "rain"
    : /\b(low|minimum|min|overnight|frost|freez)/.test(s) ? "tmin"
    : /\b(high|maximum|max|temperature|hot|heat|exceed|warm)/.test(s) && /°|degrees?|\bc\b|\bf\b|celsius|fahrenheit/.test(s) ? "tmax"
    : null;
  if (!metric) return { error: "not_a_weather_condition" };

  const numUnit = s.match(/(-?\d+(?:\.\d+)?)\s*(mm|millimet(?:er|re)s?|cm|centimet(?:er|re)s?|inch(?:es)?|in\b|"|°\s*c|°\s*f|°|degrees?\s*(?:c(?:elsius)?|f(?:ahrenheit)?)?|celsius|fahrenheit)/);
  let value = null, unit = null;
  if (numUnit) {
    value = Number(numUnit[1]);
    const u = numUnit[2];
    if (metric === "rain") {
      if (/^cm|^centi/.test(u)) value *= 10;
      else if (/^in|"/.test(u)) value *= 25.4;
      unit = "mm";
    } else {
      if (/f/.test(u)) value = ((value - 32) * 5) / 9;
      unit = "°C";
    }
    value = Math.round(value * 100) / 100;
  }

  const above = /\b(at least|or more|minimum of|no less than|>=)\b/.test(s) ? "gte"
    : /\b(more than|over|above|exceed(?:s|ed)?|greater than|higher than|hotter than|top(?:ped)?)\b|>/.test(s) ? "gt" : null;
  const below = /\b(at most|or less|no more than|<=)\b/.test(s) ? "lte"
    : /\b(less than|under|below|lower than|colder than|drop(?:ped)? below|fall below)\b|</.test(s) ? "lt" : null;
  let op = below && !above ? below : above;

  if (metric === "rain") {
    if (/\b(dry|no rain|stay(?:ed)? dry|without rain)\b/.test(s) && value === null) return { metric, op: "lt", value: MEASURABLE_MM, unit: "mm", note: "dry means less than 0.2 mm" };
    if (value === null) return { metric, op: "gte", value: MEASURABLE_MM, unit: "mm", note: "rain with no amount means at least 0.2 mm, i.e. measurable" };
    return { metric, op: op || "gte", value, unit };
  }
  if (value === null && /frost|freez/.test(s)) return { metric: "tmin", op: "lte", value: 0, unit: "°C", note: "frost/freezing means a low at or below 0°C" };
  if (value === null) return { error: "no_threshold" };
  return { metric, op: op || "gte", value, unit };
}

export function parseEvent(text) {
  const date = parseDate(text);
  const place = parsePlace(text);
  const cond = parseCondition(text);
  if (cond.error) return cond;
  if (!date) return { error: "no_date" };
  if (!validDate(date)) return { error: "invalid_date" };
  if (!place) return { error: "no_place" };
  return { date, place, ...cond };
}

const OPS = { gte: [(a, b) => a >= b, "at least"], gt: [(a, b) => a > b, "more than"], lte: [(a, b) => a <= b, "at most"], lt: [(a, b) => a < b, "less than"] };
const LABEL = { rain: "precipitation", tmax: "daily high", tmin: "daily low" };

function send(res, status, body) { res.status(status).json(body); }

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const event = String((body && body.event) || (req.query && req.query.event) || "").slice(0, 500).trim();
  if (!event) return send(res, 400, { error: "event is required", code: "event_required" });

  const p = parseEvent(event);
  if (p.error === "not_a_weather_condition")
    return send(res, 422, { error: "this miner only resolves weather conditions (rain, daily high, daily low) for a place and past day", code: p.error, event });
  if (p.error)
    return send(res, 422, { error: { no_date: "the event needs a calendar date", invalid_date: "the date is not valid", no_place: "the event needs a place, e.g. 'in Lagos'", no_threshold: "the event needs a temperature threshold" }[p.error], code: p.error, event });

  let place;
  try { place = await resolvePlace(p.place); }
  catch { return send(res, 502, { error: "place lookup failed", code: "provider_unavailable", event }); }
  if (place.error) return send(res, 422, { error: `could not find "${p.place}"`, code: place.error, event });

  const unresolved = (reason, code) => send(res, 200, {
    content: `Unresolved: ${reason}`, event, outcome: "unresolved", resolved_yes: null, reason_code: code,
    location: place.name, date: p.date, retry_after_seconds: 86400, source: SOURCE,
  });
  if (!dayIsOver(p.date, place.timezone)) return unresolved("that day has not ended at this place yet.", "window_not_finished");

  const rec = await dayRecord(place, p.date);
  if (rec.error === "provider_unavailable") return send(res, 502, { error: "NASA POWER did not answer", code: rec.error, event });
  if (rec.error) return unresolved("NASA POWER has not published that day yet (a few days' delay).", rec.error);

  const observed = p.metric === "rain" ? rec.rain : p.metric === "tmax" ? rec.tmax : rec.tmin;
  const [cmp, words] = OPS[p.op];
  const yes = cmp(observed, p.value);
  const condition = `${LABEL[p.metric]} ${words} ${p.value} ${p.unit}`;
  send(res, 200, {
    content: `${yes ? "Yes" : "No"}. NASA POWER records a ${LABEL[p.metric]} of ${observed} ${p.unit} for ${place.name} on ${p.date}, so "${condition}" resolves ${yes ? "YES" : "NO"}.${p.note ? ` (${p.note}.)` : ""} Satellite and MERRA-2 reanalysis for the grid cell, not a station reading.`,
    event,
    outcome: yes ? "yes" : "no",
    resolved_yes: yes,
    condition,
    observed_value: observed,
    threshold: p.value,
    unit: p.unit,
    location: place.name,
    date: p.date,
    resolved_at: new Date().toISOString(),
    record: { precipitation_mm: rec.rain, temp_max_c: rec.tmax, temp_min_c: rec.tmin },
    sources: [`https://power.larc.nasa.gov/api/temporal/daily/point?parameters=PRECTOTCORR,T2M_MAX,T2M_MIN&community=AG&latitude=${place.lat}&longitude=${place.lon}&start=${p.date.replaceAll("-", "")}&end=${p.date.replaceAll("-", "")}&format=JSON`],
  });
}
