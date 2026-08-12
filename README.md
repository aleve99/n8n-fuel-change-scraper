# n8n-fuel-change-scraper

n8n workflows that pull **official regulated max fuel prices** into Neon for [carburantifvg.it](https://carburantifvg.it).

Station-level prices are scraped by [fuel-backend](https://github.com/aleve99/fuel-backend). This repo only handles **regulated reference** ingest (`current` + `next`), country-agnostic, **Slovenia first**.

## Ownership

| Repo | Role |
|------|------|
| [fuel-backend](https://github.com/aleve99/fuel-backend) | **Schema source of truth** (`init.sql`, `migrations/`) |
| This repo | n8n scrape + promote workflows |
| [fuel-dashboard](https://github.com/aleve99/fuel-dashboard) | Frontend |

## Pipeline

```text
Official source (e.g. GOV.SI)
  → n8n (CarburantiFVG)
  → Neon tables from fuel-backend migrations
  → frontend
```

- **Scrape** — upsert `current_reference` / `next_reference`; on real change → `POST /api/revalidate` (`regulated-prices`)
- **Promote** — roll `next_*` → `current_*` when the effective date arrives; same revalidate when rows move

## Source layout

| Path | Role |
|------|------|
| `workflows/*.ts` | n8n Workflow SDK sources (create via n8n MCP) |
| `src/parse-gov-si.ts` | Deterministic GOV.SI HTML parser (SoT; inlined into scrape Code node) |
| `fixtures/` | Trimmed HTML for parser tests |

Dev deps (`@n8n/workflow-sdk`, `typescript`) are for IDE/typecheck only — n8n does not run these files.

```bash
npm ci
npm test
npm run typecheck
```

## Workflows (v1)

| Name | Schedule (Europe/Ljubljana) | File |
|------|----------------------------|------|
| `CF – SI Scrape regulated prices` | daily 18:00 | `workflows/si-scrape-regulated-prices.ts` |
| `CF – Promote regulated prices` | daily 00:05 | `workflows/promote-regulated-prices.ts` |

Postgres: credential **Neon Postgres Carburanti FVG** (wired on the live n8n workflows).  
Revalidate: Bearer credential **CarburantiFVG Revalidate** (= site `REVALIDATE_SECRET`) — create in n8n and attach to both workflows’ revalidate nodes, then publish.

## Scope (v1)

- Country: Slovenia (`SLO`), regime: `off_motorway`
- Fuels: Petrol (NMB-95), Diesel
- No alerts — DB only
- No price history table

## Docs for agents

Full decisions, SI notes, workflow specs: **[AGENTS.md](./AGENTS.md)**.  
DDL: fuel-backend `migrations/002_regulated_prices.sql`.
