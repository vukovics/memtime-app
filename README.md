# Memtime App

A time-tracking app built against the Memtime demo API: an Angular SPA for browsing the
client → project → task hierarchy and managing time entries, backed by an Express proxy
that owns the API key, smooths over the upstream rate limit, and caches hierarchy reads.

Stack: Angular 22 (client), Express 5 + TypeScript (server), SQLite (cache), npm workspaces.

## Setup

Prerequisites: Node 22.12+ (developed on 24), npm 10+.

```sh
git clone <repo-url> && cd memtime-app
npm install
cp server/.env.example server/.env   # then set API_KEY=<your Memtime demo API key>
npm run dev -w server                # Express proxy on http://localhost:3000
npm start -w client                  # Angular dev server on http://localhost:4200
```

Open http://localhost:4200. The dev server proxies `/api` to the Express server
(`client/proxy.conf.json`), so the browser never talks to the upstream API directly.
Sanity check: `curl http://localhost:3000/health` → `{"status":"ok"}`.

### Scripts

| Command | What it does |
| --- | --- |
| `npm run dev -w server` | Server in watch mode (tsx), loads `server/.env` |
| `npm run build -w server` / `npm start -w server` | Compile to `dist/` / run compiled server |
| `npm test -w server` | Server unit tests (Vitest, 161 tests) |
| `npm run mutation -w server` | Stryker mutation tests → `server/reports/mutation/mutation.html` |
| `npm start -w client` | `ng serve` with the `/api` proxy |
| `npm run build -w client` | Production client build |
| `npm test -w client -- --watch=false` | Client unit tests (Vitest, 75 tests) |
| `node e2e/mt-<n>.qa.mjs` | Executable QA script for ticket MT-n (self-contained: builds and starts the server itself; needs `server/.env`) |

## Architecture

```text
Browser (http://localhost:4200)
   │
Angular SPA (client/) ── ng dev proxy: /api → localhost:3000
   │
Express proxy (server/, port 3000)
   │
   ├─► SQLite cache          hierarchy GETs only, 5 min TTL, data/cache.sqlite
   ├─► rate-limit queue      sliding window, budget 14 req/60 s, FIFO
   │
Memtime demo API (15 req/60 s, Bearer key)
```

**The API key never ships to the browser.** The key lives in `server/.env` (git-ignored)
and only the proxy attaches it, as a Bearer header on upstream requests. The client is
plain static assets plus calls to its own origin — nothing secret to extract from a
bundle or a network tab.

**The upstream limit of 15 requests per 60 s is made invisible to users.** A sliding-window
queue in front of every upstream call spends a budget of 14 (one slot of safety margin);
calls over budget are never rejected, they wait in FIFO order until the oldest counted
request leaves the window. In front of that, a read-through SQLite cache (5 min TTL,
persistent across restarts) serves repeat hierarchy reads without touching the budget at
all. Time entries are the user's own fresh data, so they are always queued, never cached.

**Validation happens twice, for different reasons.** The Angular form validates for UX —
inline messages before a request is ever made — and the server re-validates for
correctness, since the proxy's contract cannot depend on a well-behaved client. Every
failure is clean JSON (`{"error": "..."}`): local 400s name each invalid field, upstream
errors map by status, and an upstream 429 becomes a 503 with `Retry-After: 60` so proxy
clients see a conventional "retry later" rather than a leaked rate-limit internal.

## Proxy API reference

All list endpoints accept optional `limit`, `offset`, `sortBy`, `order` query params,
forwarded upstream; non-numeric `limit`/`offset` is a local 400.

| Method | Path | Params / body | Success | Errors |
| --- | --- | --- | --- | --- |
| GET | `/health` | — | 200 `{"status":"ok"}` | — |
| GET | `/api/clients` | list params | 200 `Client[]` (cached) | 400 |
| GET | `/api/clients/:id/projects` | list params | 200 `Project[]` (cached) | 400 |
| GET | `/api/projects/:id/tasks` | list params | 200 `Task[]` (cached) | 400 |
| GET | `/api/time-entries` | list params | 200 `TimeEntry[]` | 400 |
| GET | `/api/time-entries/:id` | numeric id | 200 `TimeEntry` | 400, 404 |
| POST | `/api/time-entries` | JSON body (below) | 201 created entry | 400 |
| PUT | `/api/time-entries/:id` | numeric id + JSON body | 200 updated entry | 400, 404 |
| DELETE | `/api/time-entries/:id` | numeric id | 200 confirmation | 400, 404 |

Anything else under `/api` is 404. Upstream failures surface as 503 + `Retry-After: 60`
(upstream 429) or 502 (other upstream errors); unexpected server errors are 500. All
error responses are `{"error": "<message>"}`.

**Time-entry body validation** (POST and PUT, checked locally before any upstream call):

- `taskId` — positive integer
- `comment` — non-empty string (trimmed before forwarding)
- `start`, `end` — ISO 8601 datetimes (`YYYY-MM-DDTHH:MM`, optional seconds/millis,
  optional `Z` or numeric offset; date-only strings rejected)
- `end` must be strictly after `start`

All invalid fields are reported together in one 400, semicolon-joined. A malformed JSON
body is a 400 (`Invalid JSON body`); non-numeric path ids are a local 400 that never
reaches the upstream.

**Empty array vs 404.** The upstream returns 200 `[]` for list routes with an unknown
parent id (e.g. projects of a nonexistent client) and reserves 404 for direct
single-resource gets. The proxy passes both through unchanged, so
`/api/clients/999999/projects` is a 200 `[]`, while `/api/time-entries/999999` is a 404.

## Testing & quality

- **Unit tests** — server: 161 (Vitest + Supertest, upstream stubbed, injectable clock for
  queue/cache timing); client: 75 (Vitest, HTTP layer stubbed). Both suites run in seconds.
- **Mutation testing** — Stryker over the four server core modules: `cache.ts` 100%,
  `app.ts` 98.7%, `rateLimitQueue.ts` 96.2%, `upstream/client.ts` 94.4%. Each surviving
  mutant is analyzed and documented as equivalent (no observable behavior change) in a
  comment next to the relevant tests. Report: `server/reports/mutation/mutation.html`.
- **Per-ticket QA scripts** — `e2e/mt-1.qa.mjs` … `e2e/mt-12.qa.mjs` are executable
  acceptance checks, one per ticket, run as `node e2e/mt-<n>.qa.mjs` from the repo root.
  Each prints PASS/FAIL per step and exits nonzero on failure. Scripts that need a server
  build and start one themselves; `mt-3`, `mt-6`, and `mt-7` make a small budgeted number
  of live upstream calls, so re-running them back-to-back (or alongside other live traffic)
  can eat into the 14 req/60 s budget — on a 429/503 wait 60 s and rerun.
- **Docs** — [docs/GHERKIN.md](docs/GHERKIN.md) holds the Gherkin acceptance scenarios per
  ticket (the definition of done); [docs/QA_PROCEDURE.md](docs/QA_PROCEDURE.md) is the
  manual QA runbook with a sign-off log, pointing to the automated script for each ticket.

## What I'd improve

- **Timer-based capture (start/stop)** — typing datetimes is the biggest friction in the
  current flow; a running timer matches how people actually track time.
- **Task search and favorites** — tree-only picking is fine for a demo dataset but doesn't
  scale past a handful of clients; recently-used tasks would cover most entries.
- **Auth and multi-user** — the server holds one API key for everyone; real deployment
  needs sessions and per-user credentials before anything else.
- **Optimistic UI for writes** — when the rate-limit queue is saturated a write can wait
  tens of seconds; acknowledging locally and reconciling keeps the app feeling responsive.
- **Pagination totals** — the upstream returns no counts, so "load more" infers more pages
  from a full page; a proxy-side look-ahead (or upstream counts) would enable real paging.
- **Observability** — structured request logs plus queue-depth and cache-hit metrics;
  queue saturation is the first thing worth alarming on in this design.
- **CI pipeline** — unit, mutation, and the QA scripts are all headless already; wiring
  them into CI per PR is cheap and locks in the mutation scores.
- **Browser e2e (Playwright)** — the QA scripts exercise the HTTP seams; the tree and form
  interactions deserve a few real-browser flows.
- **Timezone handling** — timestamps render in the browser locale; an explicit timezone
  choice matters as soon as a team spans regions.
