# Contributing

This worker is intentionally small. Prefer a boring change in `src/` over a new dependency.

## Setup

```bash
npm install
cp .env.example .dev.vars
# leave RENTMAN_API_TOKEN empty and DRY_RUN=true for local work
npm test
npm run typecheck
npm run dev
```

`.dev.vars` is gitignored. Never commit tokens, webhook secrets, or customer form dumps.

## Layout

| Path | Role |
| --- | --- |
| `src/payload.ts` | Normalize Webflow webhook / Data API / flat / form POST bodies |
| `src/mapper.ts` | Form fields → Rentman `POST /projectrequests` body |
| `src/verify.ts` | Webflow HMAC + shared secret |
| `src/rentman.ts` | Rentman HTTP client (no token logging) |
| `src/handler.ts` | GET health, POST webhook |
| `test/` | Unit tests with a mocked Rentman `fetch` |

## Rules of the road

- Do not add project-equipment, quote, or stock writes. Rentman expects staff to convert a project request in the UI.
- Do not add customer-facing email.
- Keep adopter-specific notes in `docs/` (see `docs/DPRO.md`). Config stays generic.
- If you change mapped fields, add a mapper test and update the README table.

## Pull requests

1. `npm test` and `npm run typecheck` pass.
2. No secrets in the diff (`git grep` for `Bearer`, `rnt_`, long hex tokens).
3. Short description of the payload or Rentman field you touched.
