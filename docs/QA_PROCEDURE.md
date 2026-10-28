# Memtime App — Manual QA Procedure

Run the ticket's section after implementation; every `✅` must hold before approval.
Server: `http://localhost:3000`, client: `http://localhost:4200`. Upstream rate limit is 15 req/60s — space out curls; on 429 wait a minute. Most steps are automated in `e2e/mt-x.qa.mjs`; run that first, then any MANUAL steps.

Sign-off: fill the log at the bottom (PASS/FAIL, date, notes).

---

## MT-1: Repository scaffold
1. `npm install` at root → ✅ no errors, workspaces server+client resolve.
2. `.gitignore` covers node_modules, dist, .env, *.sqlite ✅. `.editorconfig`, `README.md` exist ✅.
3. `git status` → ✅ docs/ tracked; no TICKETS/AGENT_PIPELINE files in repo.

## MT-2: Express server scaffold
1. Copy `server/.env.example` → `server/.env`, paste real API key (MANUAL).
2. `npm run dev -w server` → ✅ listening on 3000. `curl localhost:3000/health` → ✅ 200 JSON.
3. Start without API_KEY → ✅ exits with error naming API_KEY.
4. `git check-ignore server/.env` → ✅ ignored; `.env.example` placeholders only.

## MT-3: Upstream API client
1. `npm test -w server` → ✅ green (header, paths, pagination, error mapping all unit-tested against stub fetch).
2. Live smoke (QA script): listClients(limit 1) returns array with numeric `id` ✅; absurd id throws kind NotFound ✅. [2 live requests]
3. Real key appears nowhere under `server/src/` ✅.

## MT-4: Rate-limit queue
1. `npm test -w server` → ✅ queue tests green (immediate under budget, FIFO wait at boundary, nothing rejected, errors don't wedge).
2. Config default ✅ budget 14 / 60s.

## MT-5: SQLite cache
1. Delete SQLite file, request same hierarchy endpoint twice (QA script) → ✅ one upstream call, second served from cache.
2. Different params → ✅ separate entry (new upstream call).
3. Time entries twice → ✅ two upstream calls (never cached).
4. Restart server, repeat within TTL → ✅ still cached (file persistence).

## MT-6: Hierarchy routes
1. `curl "localhost:3000/api/clients?limit=5"` → ✅ 200, ≤5 clients, upstream shape.
2. Real ids: `/api/clients/<id>/projects`, `/api/projects/<id>/tasks` → ✅ 200 arrays.
3. `sortBy=name&order=desc` → ✅ order respected (params forwarded).
4. `/api/clients/999999/projects` → ✅ 200 `[]` (real upstream behavior: list endpoints return an empty array for unknown parent ids; 404 is reserved for direct single-resource gets). Non-numeric id (`/api/clients/abc/projects`) → ✅ local 400, no upstream call.
5. Repeat step 1 → ✅ cache hit (no new upstream call in logs).

## MT-7: Time-entry routes
1. List → ✅ 200. Create valid (real taskId) → ✅ 201 + id. Update it → ✅ 200 changed. Delete it → ✅ confirmed, then GET → 404. [≈5 live requests — QA script budgets them]
2. Create with end ≤ start → ✅ 400 naming the fields, no upstream call.
3. Create missing comment → ✅ 400 naming comment, no upstream call.
4. PUT /api/time-entries/999999 (valid body) → ✅ 404 meaningful message.

## MT-8: Angular scaffold
1. `npm start -w client` (server up) → ✅ compiles, loads at 4200, nav Browse/Time Entries works (MANUAL: eyeball).
2. Key grep in client/src → ✅ zero matches.
3. Stop server, trigger a call → ✅ readable UI error (MANUAL).

## MT-9: Tree view
1. Open Browse with DevTools Network (MANUAL): ✅ only clients request on load; expand client → one projects request + spinner; expand project → tasks; re-expand → no new request.
2. Empty client → ✅ explicit "no projects" message.
3. "Load more" where >page size → ✅ appends without duplicates.

## MT-10: Time-entries list
1. Open Time Entries (MANUAL): ✅ six columns, readable local timestamps.
2. Page through → ✅ next/prev correct slices.
3. Backend stopped → ✅ readable error state. Zero entries → ✅ explicit empty state.

## MT-11: Time-entry form
1. Submit empty → ✅ inline errors on task/comment/start/end, no request.
2. end ≤ start → ✅ blocked with message.
3. Valid create → ✅ success message WITH new ID, list shows it.
4. Edit from list → ✅ prefilled; change comment; ✅ success + list updated.
5. Force a 404 (edit then delete behind its back via curl) → ✅ API message shown, input preserved.

## MT-12: UX polish
1. "Log time" on tree task → ✅ form opens, task preselected.
2. Fresh create form → ✅ start/end default to recent interval ending ~now.
3. List rows show durations ✅. Delete → ✅ confirm dialog, row gone without reload. Create → ✅ list updates without reload.

## MT-13: Documentation
1. Follow README from scratch → ✅ running app with no undocumented step.
2. ✅ Architecture ties proxy/cache/queue to key secrecy + rate limit; all /api endpoints documented; "What I'd improve" present.
3. `grep -rF "$API_KEY" .` (key value from server/.env) → ✅ matches only the untracked .env itself.

---

## Sign-off log

| Ticket | Result | Date | Notes |
|--------|--------|------|-------|
| MT-1   |        |      |       |
| MT-2   |        |      |       |
| MT-3   |        |      |       |
| MT-4   |        |      |       |
| MT-5   |        |      |       |
| MT-6   |        |      |       |
| MT-7   |        |      |       |
| MT-8   |        |      |       |
| MT-9   |        |      |       |
| MT-10  |        |      |       |
| MT-11  |        |      |       |
| MT-12  |        |      |       |
| MT-13  |        |      |       |
