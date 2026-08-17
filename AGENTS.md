# AGENTS.md — Fuel regulated-price ingest

Context and locked decisions for agents working on this repo / n8n / Neon / frontend.

## Goal

Ingest **official regulated maximum fuel prices** (when available), store them in Neon, and let the frontend ([carburantifvg.it](https://carburantifvg.it)) read and display them. Station-level retail prices already exist in the DB; this layer adds the regulated reference (current + announced next) for comparison.

**v1 country:** Slovenia (`SLO`). Schema must stay **country-agnostic**.

## Repo ownership

| Repo | Owns |
|------|------|
| [aleve99/fuel-backend](https://github.com/aleve99/fuel-backend) (local: `/home/alessio/python/fuel-backend`) | **Schema SoT** — `init.sql`, `migrations/*.sql` (incl. `002_regulated_prices.sql`). Station price scrape worker. |
| **This repo** (`n8n-fuel-change-scraper`) | n8n workflow source, scrape/promote ops, agent decisions for regulated-price ingest. **Does not** invent competing DDL. |
| [aleve99/fuel-dashboard](https://github.com/aleve99/fuel-dashboard) | Frontend UI. |

**Rule:** schema change → PR/migration in **fuel-backend** first → then workflows here that write to those tables.

## Stack

| Piece | Detail |
|--------|--------|
| n8n | Folder / project label: **CarburantiFVG**. Personal n8n project. |
| Neon | Reuse project **Carburanti FVG** (`royal-paper-77859830`, `aws-eu-central-1`, PG 16). |
| Frontend | [carburantifvg.it](https://carburantifvg.it) — [aleve99/fuel-dashboard](https://github.com/aleve99/fuel-dashboard) |
| Schema | [aleve99/fuel-backend](https://github.com/aleve99/fuel-backend) |
| Sources | **Official only** (no aggregators as primary). |
| Alerts | **None** — DB row only; frontend pulls when needed. |

## Locked product decisions

1. **What we store:** regulated **max** retail price where the law provides one — not a replacement for station-level `fuel_prices`.
2. **Sources:** official government / legal publications.
3. **History:** **current snapshot only** (no history table). Each row exposes **`current_reference`** and **`next_reference`** (plus their effective dates) so the UI can compare.
4. **Countries:** start with Slovenia; schema country-agnostic.
5. **Neon:** reuse **Carburanti FVG**.
6. **Frontend:** existing dashboard repo above.
7. **n8n folder:** **CarburantiFVG**.
8. **Schedule:** scrape daily 18:00 Europe/Ljubljana **plus Monday hourly 09–17 & 19–21** until `next_*` is stored (then Monday extras skip HTTP); promote daily 00:05 Europe/Ljubljana.
9. **Notifications:** DB only.
10. **Fuels:** stick to existing catalog — **Petrol** (`fuels.id = 0`, maps to NMB-95) and **Diesel** (`fuels.id = 1`). No KOEL / NMB-98 / LPG in v1.
11. **Regimes (option C):** `regulated_price_regimes` table. For SI seed **only** `off_motorway`. Do **not** invent a motorway regulated max while the law leaves AC/HC free-market.
12. **Promote workflow:** yes — small scheduled SQL job that rolls `next_*` → `current_*` when `next_effective_from <= today`.
13. **Schema SoT:** fuel-backend only (see Repo ownership).

## Existing Neon schema (constraints — do not break)

Canonical definitions live in fuel-backend `init.sql` / `migrations/`. Summary:

| Table | Role |
|--------|------|
| `countries` | `id`, `code` — `SLO=0`, `ITA=1`, `AUT=2` |
| `fuels` | `id`, `name` — `Petrol=0`, `Diesel=1` |
| `stations` | `id`, lat/lon, `country_id`, `brand_id`, `address` — **no regime flag** |
| `fuel_prices` | **wide** columns: `station_id`, `petrol`, `diesel`, timestamps |
| `brands` | brand catalog |
| `areas` / `discount_rates` | **Italian FVG contributi** — **do not reuse** for regulated caps |
| `regulated_price_regimes` | country-scoped regime codes (DDL: `migrations/002_regulated_prices.sql`) |
| `regulated_prices` | current + next reference per country/regime/fuel |

~108 SLO / ~462 ITA / ~74 AUT stations. SLO retail often sits on the regulated cap when regulation applies.

**Optional later (not v1):** `stations.regime_id` so the UI can bind a station to the right cap. Until then, show country/regime-level references (for SI: the single off-motorway cap).

## Slovenia regulation (facts for scrapers)

Authoritative page: https://www.gov.si/teme/cene-naftnih-derivatov/

- Decree: *Uredba o oblikovanju cen določenih naftnih derivatov*.
- From **20 Mar 2026**, the retail max mechanism applies to stations **outside** motorway and expressway service areas. Motorway/expressway = **free market** (no official max to scrape).
- Regulated motor fuels: **NMB-95**, **standard diesel** (plus KOEL — out of scope).
- Cadence under current rules: **7-day** validity windows (previously often 14-day). Gov news usually publishes **the day before** a change (“Od jutri…”).
- Primary ingest URL: GOV.SI page above (tables of validity date → NMB-95 / diesel). Prefer that over third-party sites.

## Repo layout (workflow source)

```text
workflows/
  si-scrape-regulated-prices.ts   # n8n Workflow SDK → create via MCP
  promote-regulated-prices.ts
src/
  parse-gov-si.ts                 # pure HTML → periods (SoT)
  parse-gov-si.test.ts
fixtures/
  gov-si-nmb-diesel.html          # trimmed GOV.SI table for tests
```

- SDK files under `workflows/` are what we validate/create with n8n MCP (`create_workflow_from_code`).
- Parser SoT is `src/parse-gov-si.ts`. It is **inlined** into the scrape workflow Code node (n8n sandbox cannot import this repo) — keep them in sync.
- Postgres credentials in SDK use `newCredential('Neon Postgres Carburanti FVG')` (live id `sbf6GBft9YYQNdqi`).
- Cache bust: httpBearerAuth `CarburantiFVG Revalidate` (= site `REVALIDATE_SECRET`).

## n8n workflows (v1)

Folder / name prefix: **CarburantiFVG** / `CF – …`.

1. **`CF – SI Scrape regulated prices`** (`workflows/si-scrape-regulated-prices.ts`)
   - Fetch official GOV.SI (deterministic HTML parse — no AI).
   - Upsert `regulated_prices` for `SLO` (`country_id=0`) + `off_motorway` + Petrol/Diesel (`fuel_id` 0/1):
     - period containing today (Europe/Ljubljana) → `current_*`
     - announced future period (earliest `from > today` if present) → `next_*`, else clear `next_*`
   - Upsert `RETURNING` only when price/date fields change (`IS DISTINCT FROM`); unchanged scrapes skip downstream.
   - On change: `POST https://carburantifvg.it/api/revalidate` Bearer + `{ "tags": ["regulated-prices"] }` (same as fuel-backend). Soft-fail (`neverError`).
   - **Schedule:** daily **18:00 Europe/Ljubljana** (always fetch). Monday **09–17 & 19–21** hourly: skip fetch once `next_*` is already set.

2. **`CF – Promote regulated prices`** (`workflows/promote-regulated-prices.ts`)
   - No scrape HTTP. Country-agnostic SQL:

```sql
UPDATE regulated_prices
SET
  current_reference = next_reference,
  current_effective_from = next_effective_from,
  next_reference = NULL,
  next_effective_from = NULL,
  updated_at = now()
WHERE next_reference IS NOT NULL
  AND next_effective_from <= CURRENT_DATE;
```

   - **Schedule:** daily **00:05 Europe/Ljubljana**.
   - Scrape owns discovering `next_*`; promote rolls the calendar.
   - When promote `RETURNING` non-empty → same revalidate (`regulated-prices`).

## Frontend expectations

- Read `regulated_prices` (join `countries`, `fuels`, `regulated_price_regimes`).
- Show current max; if `next_reference` set, show upcoming change + date.
- Do not treat motorway stations as capped under current SI law.
- Station retail remains `fuel_prices`; regulated row is the reference ceiling where applicable.

## Agent rules

- Prefer official sources; document source URL on every write.
- Do not overload `areas` / `discount_rates` for regulated caps.
- Do not add history tables unless product decision changes.
- Do not invent regulated prices for regimes the law leaves free.
- **Do not add DDL here** — open/change migrations in fuel-backend.
- Keep schema reusable for ITA/AUT later (new regime codes / scrape workflows per country).
- Update this file when decisions change; keep `README.md` shorter and pointed here.
