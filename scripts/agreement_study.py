"""How often do Open-Meteo and NASA POWER agree on whether a day crossed a rain limit?

10 cities, 1 Nov 2025 - 31 Oct 2026, daily totals. Free public APIs, no keys.
Run: python3 scripts/agreement_study.py
Result on 2026-11-21:
  limit  5 mm: 3650 days, both wet 467, both dry 2614, split 569 (55% of days where at least one says wet)
  limit 10 mm: 3650 days, both wet 212, both dry 3063, split 375 (64%)
  limit 20 mm: 3650 days, both wet 60,  both dry 3429, split 161 (73%)
"""
import json
import urllib.request

CITIES = {
    "Nairobi": (-1.2833, 36.8167), "Lagos": (6.4541, 3.3947), "London": (51.5085, -0.1257),
    "Mumbai": (19.0728, 72.8826), "Jakarta": (-6.2146, 106.8451), "Sao Paulo": (-23.5475, -46.6361),
    "Fresno": (36.7477, -119.7724), "Accra": (5.556, -0.1969), "Dhaka": (23.7104, 90.4074),
    "Des Moines": (41.6005, -93.6091),
}
START, END = "2025-11-01", "2026-10-31"
LIMITS = (5, 10, 20)


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "SecondSky-study/1.0"})
    return json.load(urllib.request.urlopen(req, timeout=90))


def main():
    tally = {t: {"both_wet": 0, "both_dry": 0, "split": 0, "days": 0} for t in LIMITS}
    for name, (lat, lon) in CITIES.items():
        om = get(f"https://archive-api.open-meteo.com/v1/archive?latitude={lat}&longitude={lon}"
                 f"&start_date={START}&end_date={END}&daily=precipitation_sum&timezone=GMT")["daily"]
        nasa = get(f"https://power.larc.nasa.gov/api/temporal/daily/point?parameters=PRECTOTCORR&community=AG"
                   f"&latitude={lat}&longitude={lon}&start={START.replace('-', '')}&end={END.replace('-', '')}"
                   f"&format=JSON")["properties"]["parameter"]["PRECTOTCORR"]
        for day, a in zip(om["time"], om["precipitation_sum"]):
            b = nasa.get(day.replace("-", ""))
            if a is None or b is None or b <= -998:
                continue
            for t in LIMITS:
                wa, wb = a >= t, b >= t
                k = "both_wet" if wa and wb else "both_dry" if not wa and not wb else "split"
                tally[t][k] += 1
                tally[t]["days"] += 1
    for t, r in tally.items():
        rainy = r["both_wet"] + r["split"]
        print(f"limit {t:>2} mm: {r['days']} days, both wet {r['both_wet']}, both dry {r['both_dry']}, "
              f"split {r['split']} ({100 * r['split'] / max(1, rainy):.0f}% of days where at least one says wet)")


if __name__ == "__main__":
    main()
