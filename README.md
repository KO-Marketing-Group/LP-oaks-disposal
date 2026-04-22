# LP-oaks-disposal

Oaks Disposal Service pre-launch landing page with lead capture.

## Stack
- Static HTML + vanilla CSS + vanilla JS
- Express.js backend (`server.js`) — lead API + SendGrid mailer
- MySQL (`leads` table auto-created on server startup)
- Docker: nginx:alpine + Node.js
- Deployment: Sevalla (Application, not Static Site)

## Lead flow
Both signup forms (hero + CTA-bottom) POST to `/api/lead`. On submit:
1. Client validates and masks inputs (phone → `(XXX) XXX-XXXX`, zipcode → 5 digits)
2. GTM `generate_lead` + `form_completion` dataLayer events fire (for GA4/Google Ads/Meta conversions)
3. `fetch('/api/lead')` → Node fans out to three independent, parallel persistence paths via `Promise.allSettled`:
   - **MySQL** `leads` table (insert row)
   - **SendGrid** transactional email to `SENDGRID_TO`
   - **Mailchimp** Marketing API v3 upsert to the audience (tagged `OaksDisposal`)
4. Any one path failing does not cancel the others. The request returns 200 with `{db, email, mailchimp}` booleans indicating which succeeded, or 500 only if all three failed.

## Env vars (set in Sevalla Application dashboard)
```
# SendGrid
SENDGRID_FROM=no-reply@oaksdisposal.com
SENDGRID_KEY=<sendgrid api key>
SENDGRID_TO=info@oaksdisposal.com

# MySQL
DB_HOST=<sevalla mysql host>
DB_PORT=3306
DB_USER=<mysql user>
DB_PASSWORD=<mysql password>
DB_DB=<database name>

# Mailchimp
MC_API_KEY=<mailchimp api key, format abc123...-us14>
MC_LIST_ID=f31112e9ba
MC_DC=us14
MC_TAG=OaksDisposal

# Dashboard — Microsoft SSO at /dashboard (mirrors the Oaks Reporting project)
AUTH_URL=<public base URL, e.g. https://oaksdisposal.com>
AUTH_SECRET=<random 32+ char string; rotate to invalidate all sessions>
AUTH_MICROSOFT_ENTRA_ID_ID=<Azure Application (client) ID>
AUTH_MICROSOFT_ENTRA_ID_SECRET=<Azure Client Secret>
# optional:
# AUTH_MICROSOFT_ENTRA_ID_TENANT=common   # default "common" (multi-tenant)
# AUTH_ALLOWED_DOMAINS=oaksinc.com,komarketingco.com,gravesbros.com   # default
```

## Mailchimp CSV Import
One-off script to backfill existing Mailchimp subscribers into the `leads` table:

```bash
# Dry run first (no DB connection needed) — verifies CSV parses cleanly
node scripts/import_mailchimp_csv.js path/to/export.csv --dry-run

# Real import — requires the same DB env vars the app uses
npm install  # if not already done
DB_HOST=... DB_PORT=3306 DB_USER=... DB_PASSWORD=... DB_DB=... \
  node scripts/import_mailchimp_csv.js path/to/export.csv
```

CSV format (no header): `email,zipcode,M/D/YY HH:MM`.

Imported rows are tagged `form_location='mailchimp_import'` so they're distinguishable from real form submissions in the dashboard. Missing fields (name, street, city, state) are inserted as empty strings. Re-runs are idempotent — rows with the same `(email, created_at)` are skipped.

## Dashboard
Admin view of captured leads at `/dashboard`, protected by **Microsoft Entra ID SSO** (same pattern as the Oaks Reporting project, adapted to Express via `openid-client`).

- **Sign-in flow**: unauthenticated request → `/auth/login` (Microsoft button) → Microsoft OAuth → `/auth/microsoft/callback` → signed JWT session cookie (24h) → redirect back to `/dashboard`.
- **Domain restriction**: only `@oaksinc.com`, `@komarketingco.com`, `@gravesbros.com` (override via `AUTH_ALLOWED_DOMAINS`). Rejected emails show a clear error on the login page.
- **Sign out**: link in the dashboard header clears the cookie.
- **Only `/dashboard` is gated.** The main site, `/api/lead`, `/health`, `/live`, `/ready` remain public.
- **If SSO env vars are missing**, `/dashboard` returns 503 — fails closed.
- Shows the 500 most recent leads, a line chart of submissions per day, and a Rochester-area zipcode map.
- Table paginates client-side at 10 rows/page.
- `robots: noindex, nofollow` + `Cache-Control: no-store` — never indexed, never cached.

### Azure app registration (one-time setup)
1. Azure Portal → **App registrations** → **New registration**
2. Supported account types: **Accounts in any organizational directory** (multi-tenant — matches `common` tenant)
3. Redirect URI (Web): `https://oaksdisposal.com/auth/microsoft/callback`
4. **Certificates & secrets** → New client secret → copy the **Value** (shown once only)
5. Copy the **Application (client) ID** from the app's Overview page
6. Set `AUTH_MICROSOFT_ENTRA_ID_ID` and `AUTH_MICROSOFT_ENTRA_ID_SECRET` in Sevalla's env vars
7. Also set `AUTH_URL=https://oaksdisposal.com` and `AUTH_SECRET=<random 32+ chars>`

## Local development (Docker staging)
- **Port:** 8082
- **Container name:** `oaks-disposal-staging`
- **Image tag:** `oaks-disposal-staging`

Copy `.env.example` → `.env` and fill in real credentials. Then use VS Code tasks:

| Task | What it does |
|------|--------------|
| `staging: build & run` | Build image + run container on :8082 (default build task) |
| `staging: stop` | Stop container |
| `staging: restart` | Restart without rebuild |
| `staging: logs` | Tail container logs |
| `staging: remove container` | Force-remove the container |

Visit http://localhost:8082/ and submit a test form. Verify:
- `SELECT * FROM leads ORDER BY id DESC LIMIT 1;` returns the row
- `SENDGRID_TO` inbox receives the email
- Mailchimp audience has the new contact tagged `OaksDisposal`

## Database schema
A single `leads` table is created on startup via `CREATE TABLE IF NOT EXISTS`. Schema in [`server.js`](server.js).

## Health Probes

| Probe | Path | Port | What it checks | Failure action |
|-------|------|------|----------------|----------------|
| Liveness | `/live` | 80 | nginx responding | Restart container |
| Readiness | `/ready` | 80 | Node responding + MySQL `SELECT 1` succeeds | Remove from LB (no restart) |

Configure both in Sevalla's probe settings. `/health` is kept as a legacy alias for `/live`.

## SendGrid Event Webhook
Register `https://<production-host>/api/sendgrid-events` in SendGrid:
**Settings → Mail Settings → Event Webhook**. Enable at minimum: *Dropped, Bounce, Deferred, Blocked, Spam Report*.

The handler writes:
- Failures (`dropped`, `bounce`, `deferred`, `blocked`, `spamreport`) → `console.error` as `[sendgrid-failure] {...}` with full event payload — shows up in Sevalla's **error log** stream.
- Non-failures → `console.log` as a short `[sendgrid-event] event=... email=... sg_message_id=...` line.

Grep container logs for `[sendgrid-failure]` to find all delivery problems. Each line includes reason, SMTP status, response, IP, category, and `sg_message_id` for cross-referencing the original send in the `[lead-received]` log.

## GTM
Container `GTM-5GCX3DVQ` (Landing Pages). Tags and triggers documented in the GTM UI.

## Sevalla deployment
The site must be deployed as an **Application** (not Static Site) so the Node server can run. Provision a managed MySQL database in Sevalla, set the env vars above, and push to `main` — the Docker build auto-deploys.
