# Local development and testing

These instructions apply to the Worker in this repository only. They do not build or run the separate `vz.gay` portal.

## Install and validate

From the repository root:

```sh
npm install
npm run check
```

`npm run check` parses the Worker source and runs focused Node tests for Access checks, public CORS, Turnstile validation, URL validation, and ticket creation. The SQLite schema can be independently checked with:

```sh
python3 - <<'PY'
import sqlite3
from pathlib import Path

db = sqlite3.connect(":memory:")
db.executescript(Path("apps/support-worker/schema.sql").read_text())
print("D1 schema loaded")
PY
```

## Run Wrangler locally

Start the Worker:

```sh
npm run dev:support -- --local
```

Wrangler may require valid resource IDs in the config even for some local operations. Use a separate untracked local config or local `.dev.vars` for development-only values rather than changing the production resource IDs to fake IDs. `.dev.vars` is gitignored.

When using local D1, apply the schema to the local database:

```sh
npx wrangler d1 execute vz_support_db --local \
  --file=apps/support-worker/schema.sql \
  --config apps/support-worker/wrangler.jsonc
```

Local public submission still needs a working Turnstile secret/verification path and an allowed `Origin`. Do not weaken production validation to make a local form easier to test. Automated tests mock Turnstile and D1 instead.

## Routes to exercise

- `POST /api/public/tickets` — public intake; requires an exact allowed Origin, JSON fields, Turnstile token, and D1.
- `OPTIONS /api/public/tickets` — browser CORS preflight from an allowed origin.
- `GET /` — public customer support portal.
- `GET /api/public/tickets/lookup?reference=VZ-YYYY-NNNNNN&email=...` — lookup one ticket after reference/email match; returns report body and status details.
- `GET /admin` — staff technician console; requires valid Cloudflare Access JWT.
- `GET /api/tickets` — staff ticket list; requires valid Cloudflare Access JWT.
- `POST /api/tickets` — staff ticket create; requires valid Cloudflare Access JWT.
- `POST /api/tickets/:id/close` — staff close action; requires valid Cloudflare Access JWT.

The public API intentionally does not implement a public ticket-list endpoint. Status lookup returns one ticket only after the reference and email match. Do not use real reporter data when testing.

## What not to test here

- Do not run `npm install`, `npm run build`, `npm run lint`, or deployment commands from the ignored `vz.gay/` clone as part of this repository’s validation.
- Do not copy output from the portal build into this repo.
- Do not deploy from local mock configuration or use test Turnstile credentials against the production endpoint.
- Do not disable Cloudflare Access in Worker code for local convenience.
