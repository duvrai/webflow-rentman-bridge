# dPro adopter note

dPro bv (Brussels AV rental) is the first intended adopter of this generic worker. This note is operational only. **Do not put API tokens or webhook secrets in this file or the repo.**

## Intended flow

1. Visitor submits the Webflow **contact / offerte** form (NL and FR locales).
2. Webflow sends a `form_submission` webhook to this Cloudflare Worker.
3. The worker creates a Rentman **project request** (`POST /projectrequests`).
4. Office staff open **Project requests** in Rentman, match or create the contact, and convert the request into a real project. Equipment, crew, and pricing stay in Rentman.

The worker does not write project equipment, does not send customer email, and does not read live stock.

## Suggested Webflow field names

Use stable field names in the Designer (not only labels). These match the worker defaults. Numbered Designer labels also match (`First Name 4` → first name, `Last Name 4` → last name, `Email 6` → email, `Message 7` → brief) — no `FIELD_*` override is required for that pattern.

| Form field name | Rentman / remark slot |
| --- | --- |
| `project` or `evenement` | Project request title (`name`) |
| `bedrijf` / `societe` | `contact_name` |
| `voornaam` / `prenom` | `contact_person_first_name` |
| `achternaam` / `nom` | `contact_person_lastname` |
| `email` | `contact_person_email` |
| `telefoon` / `tel` | `contact_phone` |
| `locatie` / `lieu` | `location_name` |
| `startdatum` / `debut` | `usageperiod_start` |
| `einddatum` / `fin` | `usageperiod_end` |
| `taal` / `langue` | `language` (`nl` / `fr`) |
| `message` | Remark **Brief** |
| `type` | Remark **Type** |
| `materiaal` | Remark **Materiaal/crew** |
| `website` (hidden) | Honeypot — filled bots are dropped |

Add a hidden `website` input on the form. Leave it empty for real visitors.

If the live field names differ, set `FIELD_*` or `FIELD_MAP_JSON` on the Worker (see the README). Do not hard-code dPro names into `src/`.

## Language

- Prefer an explicit `taal` / `langue` field (`nl`, `fr`, `Nederlands`, `Français`).
- Otherwise the worker default language is `nl` (`DEFAULT_LANGUAGE` in `wrangler.toml`).
- Webflow `localeId` is **not** mapped automatically (it is an opaque id).

## Webflow setup (after the Worker is deployed)

1. Create a Cloudflare Worker from this repo. Store `RENTMAN_API_TOKEN` with `wrangler secret put`.
2. Store `WEBHOOK_SECRET` the same way.
3. Preferred: create a site webhook via the Webflow Data API (`form_submission` → `https://<worker>/webhook`) and keep the webhook secret as `WEBHOOK_SECRET`.
4. Dashboard-only webhooks are unsigned. Use `https://<worker>/webhook?secret=<WEBHOOK_SECRET>` instead.
5. Optionally set `ALLOWED_FORM_NAMES=Offerte,Contact` so newsletter or other forms are ignored.

## Rentman

- Token: Rentman → Configuration / Settings → API (Bearer). The token never belongs in Webflow, the browser, or this repo.
- After go-live, convert a test request in the Rentman UI and confirm contact matching.
- Equipment lists from the form land in **remark** only. Staff still plan gear in Rentman.

The live contact form currently has no date fields. The Worker still creates the request: `planperiod_start` / `planperiod_end` default to today UTC; `usageperiod_*` stays unset. When optional start/end fields are added later, they map to usage + plan.

## Later

When dPro is ready to point production at this worker, provide `RENTMAN_API_TOKEN` (and a webhook secret) through Cloudflare secrets or the deploy environment — not through git.
