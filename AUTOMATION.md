# Wiring up daily auto-updates for the Toronto Flight Tracker

This package makes the dashboard update itself once a day instead of waiting
for a manual rebuild, using **FlightAPI.io**'s Round Trip endpoint — a real,
self-serve flight-search API with a free tier.

*(Revision note: the original version of this package used Amadeus's free
Self-Service API. That portal was decommissioned July 17, 2026 — what's left
is a sales-gated Enterprise product, not a fit for a personal project, so
this was rebuilt around FlightAPI.io instead.)*

```
your-repo/
├── .github/workflows/update-prices.yml   <- new
├── scripts/update-prices.mjs             <- new
├── data/prices.json                      <- new (seed file, gets overwritten daily)
└── index.html                            <- your existing dashboard, needs one small edit (below)
```

## 1. Get a FlightAPI.io key (a couple of minutes, free)

1. Go to [flightapi.io](https://www.flightapi.io) and register — no sales
   call, instant signup.
2. Copy your **API key** from the dashboard.

**Free-tier budget — read this before setting expectations**: the free plan
allows 100 requests per rolling 30 days, and a round-trip search costs 2
credits, so the real budget is roughly 45–50 searches/month. Checking all 5
routes with every date combo daily would blow through that in under a week.
So the script **rotates** — it checks exactly ONE route/date-combo per run,
cycling through a fixed list (SFO gets 3 date combos, SJC gets 2, and
FLL/Japan/Seoul get one near-term check each — 8 entries total). At one
request/day that's ~30/month, comfortably under quota. Every other route
keeps its last-known value between its turns. A full rotation takes 8 days.
If you'd rather check more routes per day and accept hitting quota sooner,
or spread it out further to bank more headroom, that's a one-line change in
`scripts/update-prices.mjs` (see the `CHECKS` array and the schedule cron).

## 2. Copy the files in

Copy `.github/workflows/update-prices.yml`, `scripts/update-prices.mjs`, and
`data/prices.json` into the matching paths in your repo. Add a
`package.json` if you don't have one:

```json
{
  "name": "flight-tracker",
  "private": true,
  "type": "module"
}
```

No dependencies to install — the script only uses Node's built-in `fetch`.

## 3. Add your API key as a GitHub secret

Repo → **Settings → Secrets and variables → Actions → New repository
secret**. Add: `FLIGHTAPI_KEY`

## 4. Enable Actions to push back to the repo

The workflow commits `data/prices.json` after each run, so it needs write
access: **Settings → Actions → General → Workflow permissions → "Read and
write permissions"**. (The `permissions: contents: write` line in the
workflow file handles the rest.)

## 5. Point the dashboard at the JSON

The `index.html` I sent you already has this wired in for SFO and SJC (with
matching `id`s on the relevant elements) — nothing to add there if you're
using that file. If you're using a different copy, add this near the top of
its `<script>` (or a new `<script>` block right before `</body>`):

```html
<script>
  fetch('/data/prices.json')
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((data) => {
      const sfo = data.routes?.sfo;
      if (sfo?.cash?.ok) {
        const el = document.getElementById('sfo-cash-figure');
        if (el) el.textContent = `$${sfo.cash.roundTripCAD} CAD`;
      }
    })
    .catch((err) => console.warn('prices.json not loaded, showing static figures:', err));
</script>
```

## 6. First run

Trigger it once by hand before trusting the schedule: repo's **Actions** tab
→ "Update flight prices" → **Run workflow**. Check the run log carefully —
see the limitation below, this is the step most likely to need a small fix.

## Known limitations — read before relying on this

- **The response-parsing logic is unverified against a real API response.**
  I could not call FlightAPI.io from the sandbox that wrote this script — its
  outbound network is blocked for third-party API calls generally (confirmed
  against multiple unrelated services, not specific to FlightAPI.io). The
  script is written against FlightAPI.io's *documented* request/response
  shape and tries a couple of plausible field-name variants defensively, but
  if the real response doesn't match, it will log a clear warning (with the
  raw top-level keys it saw) instead of writing garbage — check the Actions
  run log for that on the first run, and I'm happy to fix the parsing once
  you paste me a real response or the warning output.
- **No reliable carry-on/baggage data.** FlightAPI.io's docs mention fare
  basis and booking codes, not baggage specifics — the script always marks
  API-sourced fares `carryOnConfirmed: false`. Per the project's
  baggage-floor rule, treat every automated figure as unconfirmed for
  baggage until checked manually — never promote it to a locked headline
  price on the API result alone.
- **Rotation means most routes are stale most days** — by design, to stay
  inside the free quota (see above). `checkedAt` on each route tells you how
  fresh that specific figure is.
- **Google Flights and aeroplan.com stay the dashboard's *booking* links**,
  per the project's booking-channel rule — FlightAPI.io is a data source for
  the number shown, never a link the user clicks to book.
- **If you see 429 errors**, you're over quota — the rotation should prevent
  that, but if your account has a different limit than documented, reduce
  the `CHECKS` list or change the cron to every 2nd day.

## What I couldn't do without your repo

I have your repo URL now (`https://github.com/rianaismail/Toronto-Flight-Watch`)
but this session's GitHub access is gated at a level I can't unlock myself —
API calls and raw file fetches to it both failed with an access-not-enabled
error, unrelated to whether the repo is public or private. So this is still
a manual copy-paste rather than something I pushed for you. If you'd rather
I place these files precisely against your actual `index.html`, attach that
file directly to the chat and I'll adjust the `id`s/script to match instead
of relying on the copy I generated in an earlier turn.
