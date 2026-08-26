#!/usr/bin/env node
/**
 * Daily flight-price refresh for the Toronto Flight Tracker dashboard,
 * powered by FlightAPI.io's Round Trip endpoint.
 *
 * WHY FLIGHTAPI.IO (revised 2026-08-26)
 *   The original plan used Amadeus's free Self-Service API. That portal was
 *   decommissioned July 17, 2026 - what's left ("Amadeus Enterprise API
 *   Portal") is a sales-gated enterprise product, not a free self-serve
 *   signup, so it doesn't fit a personal project like this. FlightAPI.io
 *   offers real round-trip fare data (aggregated from multiple vendors,
 *   similar in shape to a metasearch engine) with an instant self-serve
 *   signup and a genuine free tier - no sales call, no card required to
 *   register (per their docs; verify at signup in case that's changed).
 *
 * FREE-TIER BUDGET (important - read this)
 *   FlightAPI.io's free plan allows 100 requests per rolling 30 days, and
 *   a round-trip search costs 2 credits each - so treat the real budget as
 *   roughly 45-50 round-trip searches/month to be safe. Checking all 5
 *   routes with every date combo every single day would blow through that
 *   in under a week. So this script ROTATES: it only makes ONE request per
 *   run, cycling through a fixed list of (route, date-combo) checks - see
 *   CHECKS below. At one request/day that's ~30/month, comfortably under
 *   quota with headroom. Every other route keeps its last-known value from
 *   the previous data/prices.json (merged in, not overwritten) until its
 *   turn comes back around. Full rotation takes CHECKS.length days.
 *
 * SETUP (see INTEGRATION.md for the full walkthrough)
 *   1. Free account at https://www.flightapi.io (register link, no sales
 *      call)
 *   2. Copy your API key from the dashboard
 *   3. Add it as a GitHub repo secret: FLIGHTAPI_KEY
 *
 * HONEST LIMITATIONS
 *   - This script could not be run against the live FlightAPI.io API from
 *     the sandbox that wrote it (that sandbox's network blocks outbound
 *     calls to third-party APIs generally - confirmed against multiple
 *     unrelated domains, not specific to this one). It's written against
 *     FlightAPI.io's documented request/response shape, but the exact
 *     response JSON has NOT been seen firsthand - the parsing logic below
 *     tries a few plausible field-name variants defensively and logs a
 *     clear warning if none match, rather than silently writing garbage.
 *     Run it once by hand (or via "Run workflow" in GitHub Actions) and
 *     check the console output + data/prices.json before trusting the
 *     schedule - you may need to adjust `extractCheapest()` below once you
 *     see a real response.
 *   - FlightAPI.io's response does not appear to include reliable
 *     carry-on/cabin-bag data (their docs mention fare basis/booking codes,
 *     not baggage specifics) - this script always marks
 *     `carryOnConfirmed: false` for API-sourced fares. Per the project's
 *     baggage-floor rule, treat every automated fare as UNCONFIRMED for
 *     baggage until checked manually, and never promote it to a locked
 *     headline price on that basis alone.
 *   - If you hit 429 errors, you're over quota - the rotation above should
 *     prevent that, but reduce CHECKS or run every 2nd day if it happens.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, "..", "data", "prices.json");

const API_KEY = process.env.FLIGHTAPI_KEY;
if (!API_KEY) {
  console.error(
    "Missing FLIGHTAPI_KEY env var. Add it as a GitHub repo secret (see INTEGRATION.md) or export it locally before running."
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Static Aeroplan partner-award chart bands (published chart - doesn't need
// live lookups). Update these only when Aeroplan republishes the chart.
// Source: Aeroplan Flight Rewards Chart PDF, cross-checked 2026-08-26.
// ---------------------------------------------------------------------------
const AEROPLAN_CHART = {
  na_1501_2750mi: { economyOneWay: 12500, feesLowCAD: 75, feesHighCAD: 175 }, // SFO, SJC
  na_501_1500mi: { economyOneWay: 10000, feesLowCAD: 60, feesHighCAD: 170 }, // FLL (no partner - AC dynamic in practice)
  pac_5001_7500mi: { economyOneWay: 50000, feesLowCAD: 118, feesHighCAD: 152 }, // Japan, Seoul nonstop
};

const ROUTE_META = {
  sfo: { label: "San Francisco", origin: "YYZ", dest: "SFO", chartBand: "na_1501_2750mi", noPartnerChart: true },
  sjc: { label: "San Jose", origin: "YYZ", dest: "SJC", chartBand: "na_1501_2750mi", noPartnerChart: true },
  fll: { label: "Fort Lauderdale", origin: "YYZ", dest: "FLL", chartBand: "na_501_1500mi", noPartnerChart: true },
  japan: { label: "Japan (NRT)", origin: "YYZ", dest: "NRT", chartBand: "pac_5001_7500mi", noPartnerChart: false },
  seoul: { label: "Seoul", origin: "YYZ", dest: "ICN", chartBand: "pac_5001_7500mi", noPartnerChart: false },
};

// One request per run, rotating through this list. SFO/SJC get more entries
// since they're the active Next Trip target with a flexible week to cover;
// FLL/Japan/Seoul get one near-term "what's the going rate" check each.
function nearTermCombo(daysOut, nights) {
  const depart = addDays(new Date(), daysOut);
  const ret = addDays(depart, nights);
  return [isoDate(depart), isoDate(ret)];
}

const CHECKS = [
  { key: "sfo", combo: ["2026-11-07", "2026-11-08"] }, // just the anchor weekend
  { key: "sfo", combo: ["2026-11-06", "2026-11-09"] }, // long weekend
  { key: "sfo", combo: ["2026-11-04", "2026-11-11"] }, // full week, midweek-to-midweek
  { key: "sjc", combo: ["2026-11-07", "2026-11-08"] },
  { key: "sjc", combo: ["2026-11-06", "2026-11-09"] },
  { key: "fll", combo: () => nearTermCombo(45, 7) },
  { key: "japan", combo: () => nearTermCombo(60, 10) },
  { key: "seoul", combo: () => nearTermCombo(60, 10) },
];

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// Pick today's check deterministically so re-running the same day (e.g. a
// manual "Run workflow" retry) hits the same route, but the day-over-day
// schedule rotates through the full list.
function pickTodaysCheck() {
  const dayIndex = Math.floor(Date.now() / (1000 * 60 * 60 * 24));
  const entry = CHECKS[dayIndex % CHECKS.length];
  const combo = typeof entry.combo === "function" ? entry.combo() : entry.combo;
  return { key: entry.key, combo };
}

// ---------------------------------------------------------------------------
// FlightAPI.io call
// ---------------------------------------------------------------------------
async function searchRoundTrip(origin, dest, departDate, returnDate) {
  const url = `https://api.flightapi.io/roundtrip/${API_KEY}/${origin}/${dest}/${departDate}/${returnDate}/1/0/0/Economy/CAD`;
  const res = await fetch(url);
  if (!res.ok) {
    return { ok: false, reason: `${res.status} ${await res.text().catch(() => "")}` };
  }
  const data = await res.json();
  return { ok: true, data };
}

// Defensive parsing: the real response shape wasn't confirmed firsthand (see
// header note). Tries a few plausible layouts before giving up.
function extractCheapest(data) {
  const candidates = [];

  // Guess 1: { itineraries: [{ pricing_options: [{ price: { amount } }] }] }
  const itineraries = data.itineraries || data.Itineraries || [];
  for (const it of itineraries) {
    const options = it.pricing_options || it.pricingOptions || [];
    for (const opt of options) {
      const amount = opt.price?.amount ?? opt.price ?? opt.total ?? null;
      if (amount != null) {
        candidates.push({
          amount: Number(amount),
          carrier: it.legs?.[0]?.carriers?.[0] || it.carrier || "unknown",
          bookingUrl: opt.url || opt.deep_link || null,
        });
      }
    }
  }

  // Guess 2: a flatter { data: [{ price, airline }] } shape
  if (!candidates.length && Array.isArray(data.data)) {
    for (const row of data.data) {
      const amount = row.price ?? row.total ?? null;
      if (amount != null) {
        candidates.push({ amount: Number(amount), carrier: row.airline || row.carrier || "unknown", bookingUrl: row.url || null });
      }
    }
  }

  if (!candidates.length) return null;
  return candidates.reduce((min, c) => (c.amount < min.amount ? c : min));
}

function computePoints(routeKey) {
  const meta = ROUTE_META[routeKey];
  const band = AEROPLAN_CHART[meta.chartBand];
  return {
    oneWayPts: band.economyOneWay,
    roundTripPts: band.economyOneWay * 2,
    feesLowCAD: band.feesLowCAD,
    feesHighCAD: band.feesHighCAD,
    partnerChartBookable: !meta.noPartnerChart,
    note: meta.noPartnerChart
      ? "No Star Alliance partner flies this route - real redemption is Air Canada's own dynamic pricing, not this fixed-chart figure. See methodology.md."
      : "Chart-bookable via a genuine Star Alliance partner award.",
  };
}

async function loadPrevious() {
  try {
    const raw = await readFile(OUTPUT_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { routes: {} };
  }
}

async function main() {
  const previous = await loadPrevious();
  const { key: routeKey, combo } = pickTodaysCheck();
  const meta = ROUTE_META[routeKey];

  console.log(`Today's check: ${meta.label} (${routeKey}), ${combo[0]} -> ${combo[1]}`);

  const result = await searchRoundTrip(meta.origin, meta.dest, combo[0], combo[1]);
  const routes = { ...previous.routes };

  // Refresh points figures for every route each run (cheap - no API call,
  // just the static chart), so those never go stale even on off-rotation days.
  for (const key of Object.keys(ROUTE_META)) {
    routes[key] = {
      ...(routes[key] || { label: ROUTE_META[key].label }),
      label: ROUTE_META[key].label,
      points: computePoints(key),
    };
  }

  if (!result.ok) {
    console.warn(`  -> request failed: ${result.reason}`);
    routes[routeKey].cash = {
      ok: false,
      reason: result.reason,
      lastAttempt: combo,
    };
  } else {
    const cheapest = extractCheapest(result.data);
    if (!cheapest) {
      console.warn("  -> response shape didn't match any known layout - see extractCheapest() in this script. Raw keys:", Object.keys(result.data));
      routes[routeKey].cash = {
        ok: false,
        reason: "unrecognized response shape - script needs a small update, see console output for raw keys",
        lastAttempt: combo,
      };
    } else {
      console.log(`  -> cheapest found: $${cheapest.amount} CAD (${cheapest.carrier})`);
      routes[routeKey].cash = {
        ok: true,
        roundTripCAD: Math.round(cheapest.amount),
        carrier: cheapest.carrier,
        dates: { depart: combo[0], return: combo[1] },
        carryOnConfirmed: false, // FlightAPI.io doesn't reliably expose this - see header note
        fareClassConfirmed: false,
        bookingUrlSeen: !!cheapest.bookingUrl, // informational only - dashboard still links to Google Flights/aeroplan.com, never this
      };
    }
  }
  routes[routeKey].checkedAt = new Date().toISOString();

  const output = {
    generatedAt: new Date().toISOString(),
    source: "flightapi.io (rotating, 1 route/day - see script header)",
    todaysCheck: { route: routeKey, combo },
    nextTrip: {
      sfo: { anchorWeekend: "2026-11-07/2026-11-08", searchWindow: "2026-11-01/2026-11-14", maxNights: 7 },
      sjc: { anchorWeekend: "2026-11-07/2026-11-08", searchWindow: "2026-11-01/2026-11-14", maxNights: 7 },
    },
    routes,
  };

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf-8");
  console.log(`\nWrote ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
