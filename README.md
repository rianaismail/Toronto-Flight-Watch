# Toronto Flight Watch

A daily-tracked dashboard of cheap flights from Toronto (YYZ/YTZ) — cash fares and Aeroplan points for San Francisco, San Jose, Fort Lauderdale, Japan, and Seoul, plus opportunistic deals.

This is a single static HTML file (`index.html`). No build step, no dependencies — Vercel serves it as-is.

## How to update it

Whenever the flight data changes, replace `index.html` with the new version and push the change (or upload the new file through GitHub's web interface). Vercel automatically redeploys within a few seconds of any push to this repo's main branch — the live site always matches whatever is here.
