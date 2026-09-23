# Webflow → Rentman bridge

MIT-licensed [Cloudflare Worker](https://developers.cloudflare.com/workers/) that receives a Webflow form submission and creates a Rentman **project request**.

Built for AV / event rental companies that already use Webflow for the public site and Rentman for operations. Config is generic. Secrets stay in environment variables.

## What it does

- Accepts Webflow `form_submission` webhooks, Data API–style submission JSON, flat JSON, or `application/x-www-form-urlencoded` form POSTs.
- Maps configurable field names to a Rentman project request:
  `name`, `contact_name`, `contact_person_first_name`, `contact_person_lastname`, `contact_person_email`, `contact_phone`, `location_name`, `usageperiod_start` / `usageperiod_end` (ISO), `language` (`nl` / `fr` / `en`).
- Builds `remark` from brief + type + materiaal/crew, then appends a raw field dump.
- Always sends `linked_contact: null` so Rentman staff match the contact when converting the request.
- Drops spam: if the honeypot field is filled, the worker returns **200** and does nothing.
- Optional shared secret or Webflow HMAC verification.
- `GET /` health check.

## What it does not do

These are product limits, not missing todos:

| Out of scope | Why |
| --- | --- |
| Write project equipment / full quotes | Rentman project requests are a raw inbox. Staff convert them in the UI and match gear there. `POST /projectrequests/:id/projectrequestequipment` exists but is not used here. |
| Client-side Rentman token | The browser never sees `RENTMAN_API_TOKEN`. |
| Auto-emails to customers | No mailer. Webflow can still send its own form notification to your inbox. |
| Live stock or pricing | The worker does not read equipment, availability, or rates. |

## How it works

```
Webflow form
    → POST / or POST /webhook
    → honeypot / allow-list
    → map fields
    → POST https://api.rentman.net/projectrequests
         Authorization: Bearer <RENTMAN_API_TOKEN>
```

Rentman create fields used (from the official `projectrequests` resource):

`name`, `contact_name`, `contact_person_first_name`, `contact_person_lastname`, `contact_person_email`, `contact_phone`, `location_name`, `usageperiod_start`, `usageperiod_end` (only when the form supplies dates), `planperiod_start`, `planperiod_end` (always sent — see Field mapping), `language`, `remark`, `linked_contact` (always `null`).

Other Rentman fields (`price`, mailing address, `is_paid`, …) are left unset.

## Expected payloads

The worker looks at the JSON **shape**, not a vendor header.

### 1. Native Webflow form webhook

Site webhook or API-created webhook with `triggerType: form_submission`:

```json
{
  "triggerType": "form_submission",
  "payload": {
    "name": "Contact Us",
    "siteId": "65427cf400e02b306eaa049c",
    "data": {
      "First Name": "Zaphod",
      "Last Name": "Beeblebrox",
      "email": "zaphod@heartofgold.ai",
      "Phone Number": 15550000000
    },
    "submittedAt": "2022-09-14T12:35:16.117Z",
    "id": "6321ca84df3949bfc6752327",
    "formId": "65429eadebe8a9f3a30f62d0",
    "formElementId": "4e038d2c-6a1e-4953-7be9-a59a2b453177",
    "localeId": null
  }
}
```

A payload-only body (`{ "name": "Contact", "data": { ... }, "formId": "..." }`) is accepted too.

### 2. Webflow Data API `form_submission`

`GET /v2/sites/{site_id}/form_submissions/{id}` uses **`formResponse`**, not `payload.data`:

```json
{
  "id": "6321ca84df3949bfc6752327",
  "displayName": "Sample Form",
  "siteId": "62749158efef318abc8d5a0f",
  "dateSubmitted": "2022-09-14T12:35:16.117Z",
  "formResponse": {
    "First Name": "Arthur",
    "email": "arthur@example.com"
  },
  "localeId": null
}
```

If you proxy the Data API object to this worker, it maps `formResponse` the same way as webhook `data`.

### 3. Flat JSON or HTML form POST

```json
{ "project": "Gala", "email": "ada@example.com", "website": "" }
```

Or `Content-Type: application/x-www-form-urlencoded`:

```
project=Gala&email=ada%40example.com&website=
```

`multipart/form-data` is rejected (400). File uploads are out of scope.

## Field mapping

Aliases are case-insensitive. Spaces, hyphens, and accents collapse (`Prénom` → `prenom`, `E-mail` → `e_mail`). A trailing Designer index is ignored (`First Name 4` matches `first_name`, `Email 6` matches `email`, `Message 7` matches `message`). An unnumbered field of the same name wins if both exist.

| Rentman / remark slot | Default Webflow names (first match wins) |
| --- | --- |
| `name` (project title) | `project`, `event`, `project_name`, `evenement`, `name`, … |
| `contact_name` | `company`, `bedrijf`, `organisation`, … |
| `contact_person_first_name` | `first_name`, `voornaam`, `prenom`, … |
| `contact_person_lastname` | `last_name`, `achternaam`, `nom`, … |
| `contact_phone` | `phone`, `telefoon`, `tel`, `gsm`, … |
| `contact_person_email` | `email`, `e-mail`, … |
| `location_name` | `location`, `locatie`, `lieu`, … |
| `usageperiod_start` / `_end` | `start` / `end`, `startdatum` / `einddatum`, `from` / `to`, … Date-only values become `T00:00:00Z` / `T23:59:59Z`. Omitted when the form has no dates. |
| `planperiod_start` / `_end` | Always sent (Rentman requires both). Copied from usage dates when present. If only one date is present, the other plan bound is that same UTC calendar day. If the form has no dates, today UTC `00:00:00Z`–`23:59:59Z`. |
| `language` | `language`, `taal`, `langue` → `nl`, `fr`, or `en` |
| remark **Brief** | `message`, `brief`, `opmerkingen`, … |
| remark **Type** | `type`, `soort`, `event_type` |
| remark **Materiaal/crew** | `materiaal`, `crew`, `equipment` |

If `name` is empty, the title becomes `{company or person} — {form name}` or `Website request — YYYY-MM-DD`.

`planperiod_*` is the office planning window Rentman requires on create. Contact / offerte forms often have no event dates; the Worker still succeeds by sending today UTC and leaving `usageperiod_*` unset so later optional date fields can map to usage + plan without colliding with a fabricated event.

Override defaults in one of these ways (later entries replace that slot’s aliases):

1. `FIELD_MAP_JSON` — JSON object, see `config/field-map.example.json`.
2. Per-slot env / `wrangler.toml` vars: `FIELD_NAME=evenement,project`.
3. Code defaults in `src/config.ts`.

```toml
# wrangler.toml
[vars]
FIELD_NAME = "evenement,project"
FIELD_CONTACT_PERSON_EMAIL = "email,e-mail"
HONEYPOT_FIELD = "website"
DEFAULT_LANGUAGE = "nl"
ALLOWED_FORM_NAMES = "Contact,Offerte"
```

## Environment variables

| Name | Required | Secret? | Purpose |
| --- | --- | --- | --- |
| `RENTMAN_API_TOKEN` | Yes (unless `DRY_RUN`) | Yes | Rentman Bearer token |
| `WEBHOOK_SECRET` | No | Yes | Webflow HMAC key and/or shared secret |
| `DRY_RUN` | No | No | `true` maps the payload and skips Rentman |
| `HONEYPOT_FIELD` | No | No | Default `website` |
| `DEFAULT_LANGUAGE` | No | No | Default `nl` |
| `DEFAULT_PROJECT_NAME` | No | No | Fallback title prefix |
| `ALLOWED_FORM_NAMES` | No | No | Comma-separated Webflow form names |
| `RENTMAN_API_BASE` | No | No | Default `https://api.rentman.net` |
| `FIELD_MAP_JSON` / `FIELD_*` | No | No | Field aliases |

Put secrets in `.dev.vars` locally (`cp .env.example .dev.vars`) or `wrangler secret put` in production. **Never commit tokens.**

## Authentication

`WEBHOOK_SECRET` is optional. If it is unset, POSTs are accepted (fine for first local tests; do not ship that way).

When it **is** set:

1. **Webflow HMAC** — if the request has `x-webflow-signature` and `x-webflow-timestamp`, the worker checks `HMAC-SHA256(secret, timestamp + ":" + rawBody)` and rejects timestamps older than 5 minutes. This is what [Webflow documents](https://developers.webflow.com/data/docs/working-with-webhooks) for API-created webhooks (webhook-specific secret after 2025-04-14) and OAuth apps (OAuth client secret).
2. **Shared secret** — dashboard webhooks and HTML form POSTs have **no** signature headers. Send the same value as:
   - `X-Webhook-Secret: <secret>`, or
   - `Authorization: Bearer <secret>`, or
   - `https://<worker>/webhook?secret=<secret>` (visible in the Webflow UI; acceptable if the secret is not the Rentman token).

Wrong or missing credentials → **401**.

## Errors

| Status | When |
| --- | --- |
| 200 | Health, ignored honeypot / other form, or `DRY_RUN` |
| 201 | Rentman created the project request |
| 400 | Empty / invalid body, unsupported multipart |
| 401 | Bad signature or shared secret |
| 404 | POST to an unknown path |
| 405 | Not GET/POST/OPTIONS |
| 413 | Body larger than 100 KB |
| 500 | Missing `RENTMAN_API_TOKEN`, bad `FIELD_MAP_JSON` |
| 502 | Rentman non-2xx or network failure |

Rentman error bodies are logged (truncated, `Authorization` redacted). The client only sees `rentman_error` plus the upstream status code.

## Setup

```bash
npm install
cp .env.example .dev.vars
# edit .dev.vars — keep DRY_RUN=true until you have a token
npm test
npm run typecheck
npm run dev
```

`npm run dev` binds [http://127.0.0.1:4545](http://127.0.0.1:4545).

### Tests

`npm test` runs Vitest unit tests: payload shapes, field mapper (including honeypot and remark dump), HMAC / shared secret, and the HTTP handler with a **mocked** Rentman `fetch`. No live Rentman or Webflow account is required.

`DRY_RUN=true` is the documented live dry-run: POST a real webhook body and inspect the JSON `rentman` object.

## Webflow webhook setup

### Option A — Data API webhook (HMAC)

1. Create a site token or Data Client app with `forms:read` / `sites:write` as required to register webhooks.
2. `POST https://api.webflow.com/v2/sites/{site_id}/webhooks` with `triggerType: form_submission` and `url: https://<worker>/webhook`.
3. Store the returned webhook secret (or OAuth client secret) as `WEBHOOK_SECRET`.
4. Publish the site and submit the form.

Dashboard-created webhooks **do not** send signature headers. Use option B or recreate the webhook via the API.

### Option B — Dashboard webhook + query secret

1. Webflow → Site settings → Apps & integrations → Webhooks.
2. Event: form submission. URL: `https://<your-worker>.workers.dev/webhook?secret=<WEBHOOK_SECRET>`.
3. Set the same value with `wrangler secret put WEBHOOK_SECRET`.

### Option C — Form action POST

Point the form’s action at `https://<worker>/?secret=<WEBHOOK_SECRET>` and send `application/x-www-form-urlencoded` (or JSON). Add a hidden `website` input for the honeypot.

Give every field a unique name in the Designer. Those names become JSON keys.

## Deploy to Cloudflare

```bash
npx wrangler login
npx wrangler secret put RENTMAN_API_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npx wrangler deploy
```

Confirm `GET https://<your-worker>.workers.dev/` returns `"ok": true`. Then send the curl example below with `DRY_RUN` still off.

Rentman token: Rentman → Configuration → Integrations / API. The token is a Bearer secret for `https://api.rentman.net`.

## curl examples

Health:

```bash
curl -sS http://127.0.0.1:4545/
```

Dry-run a Webflow webhook body (`.dev.vars` has `DRY_RUN=true`):

```bash
curl -sS http://127.0.0.1:4545/webhook \
  -H 'content-type: application/json' \
  -d '{
    "triggerType": "form_submission",
    "payload": {
      "name": "Contact",
      "data": {
        "project": "Club night",
        "company": "Acme Events",
        "first_name": "Ada",
        "last_name": "Lovelace",
        "email": "ada@example.com",
        "phone": "+32 2 000 00 00",
        "location": "Brussels",
        "start": "2026-10-01",
        "end": "2026-10-03",
        "language": "nl",
        "message": "Need PA and one tech",
        "type": "Club",
        "materiaal": "2x tops, mixer",
        "website": ""
      },
      "submittedAt": "2026-09-22T10:00:00.000Z",
      "id": "demo-1",
      "formId": "form-1"
    }
  }'
```

Honeypot (must return 200 and `"ignored": true`):

```bash
curl -sS http://127.0.0.1:4545/ \
  -H 'content-type: application/json' \
  -d '{"email":"bot@example.com","website":"http://spam.test"}'
```

With a shared secret:

```bash
curl -sS 'http://127.0.0.1:4545/webhook?secret=test-secret' \
  -H 'content-type: application/json' \
  -d '{"project":"Gala","email":"ada@example.com"}'
```

## Adopters

- [docs/DPRO.md](docs/DPRO.md) — dPro bv (Brussels) contact / offerte form. No tokens.

## License

[MIT](LICENSE)
