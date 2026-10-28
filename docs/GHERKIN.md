# Memtime App — Gherkin Acceptance Scenarios

One feature block per ticket. A ticket is done when all its scenarios pass.

---

## MT-1: Repository scaffold

```gherkin
Feature: Monorepo scaffold

  Scenario: Workspace installs cleanly
    When I run "npm install" in the repository root
    Then it completes without errors
    And workspaces "server" and "client" are resolved

  Scenario: Repository hygiene
    Then ".gitignore" excludes node_modules, dist, .env, and SQLite data files
    And ".editorconfig" and a README stub exist
    And docs/GHERKIN.md and docs/QA_PROCEDURE.md are part of the repository
```

## MT-2: Express server scaffold

```gherkin
Feature: Express server with health endpoint and env config

  Scenario: Health check
    Given a valid server/.env based on server/.env.example
    When the server runs and I GET "/health"
    Then the response is 200 with JSON indicating the service is alive

  Scenario: Missing API_KEY fails fast
    Given the environment lacks API_KEY
    When the server starts
    Then the process exits with an error naming API_KEY

  Scenario: Secrets hygiene
    Then server/.env is git-ignored and server/.env.example holds placeholders only
```

## MT-3: Upstream API client

```gherkin
Feature: Typed client for the Memtime upstream API

  Scenario: Authenticated, correctly-routed requests
    Then every method sends "Authorization: Bearer <apiKey>" to its documented path
    And limit/offset/sortBy/order are forwarded only when provided
    And entity ids are numbers, matching upstream responses

  Scenario: Time-entry CRUD
    Then createTimeEntry POSTs a JSON body, updateTimeEntry PUTs to /time-entries/:id,
      deleteTimeEntry DELETEs /time-entries/:id

  Scenario Outline: Upstream errors become one typed error
    Given the upstream responds <status>
    Then the client throws UpstreamApiError with kind <kind> carrying the upstream message
    Examples:
      | status | kind          |
      | 400    | BadRequest    |
      | 404    | NotFound      |
      | 429    | RateLimited   |
      | 5xx    | UpstreamError |
```

## MT-4: Rate-limit queue

```gherkin
Feature: Sliding-window request queue (14 per 60s)

  Scenario: Under budget runs immediately
  Scenario: Over budget waits in FIFO order until the window frees capacity
  Scenario: Nothing is ever rejected locally due to the limit
  Scenario: Errors from wrapped calls propagate, still count, and never wedge the queue
```

## MT-5: SQLite cache

```gherkin
Feature: Read-through TTL cache for hierarchy data

  Scenario: Miss populates, hit skips upstream, expiry refreshes
  Scenario: Distinct endpoint+pagination params are distinct cache entries
  Scenario: Time entries are never cached
  Scenario: Cache persists across server restarts
```

## MT-6: Hierarchy routes

```gherkin
Feature: Proxy routes for clients, projects, tasks

  Scenario Outline: Proxying lists
    When I GET <route> with pagination params
    Then I get 200 with the upstream-shaped array and params were forwarded
    Examples:
      | route                     |
      | /api/clients              |
      | /api/clients/:id/projects |
      | /api/projects/:id/tasks   |

  Scenario: Served through cache and queue (second identical request hits no upstream)
  Scenario: Unknown parent id on a list route passes through as the upstream's 200 []
    (upstream reserves 404 for direct single-resource gets, which these routes do not expose)
  Scenario: Upstream errors (400/404/429/5xx) become JSON errors via the shared middleware
    (429 maps to 503 with Retry-After so proxy clients never see a raw upstream 429)
```

## MT-7: Time-entry routes

```gherkin
Feature: Time-entry CRUD with validation

  Scenario: List, create (201 + new id), update (200), delete (confirmed, then 404)
  Scenario Outline: Invalid payloads rejected locally with 400 naming the field, upstream untouched
    Examples: missing taskId | missing comment | non-ISO start | non-ISO end | end <= start
  Scenario: Upstream 404 on update/delete of unknown id passes through meaningfully
```

## MT-8: Angular scaffold

```gherkin
Feature: Angular shell

  Scenario: App compiles, serves, and shows nav "Browse" and "Time Entries"
  Scenario: API calls go through the dev proxy to Express — no API key in client code
  Scenario: Backend down → user sees a readable error, not a blank page
```

## MT-9: Hierarchy tree view

```gherkin
Feature: Lazy-loaded client → project → task tree

  Scenario: Initial load fetches clients only
  Scenario: Expanding a node loads and nests its children with a loading indicator
  Scenario: Re-expanding does not refetch
  Scenario: Empty levels show an explicit message
  Scenario: "Load more" appends the next page within a level
```

## MT-10: Time-entries list

```gherkin
Feature: Paginated time-entries table

  Scenario: Columns ID, Task ID, Comment, Start, End, Created At
  Scenario: Pagination controls load next/previous offsets
  Scenario: Timestamps render human-readable
  Scenario: Loading, empty, and error states all exist
```

## MT-11: Time-entry form

```gherkin
Feature: Create and update time entries

  Scenario: Valid create shows success with the new entry's ID and the list updates
  Scenario: Edit prefills, update confirms, list reflects the change
  Scenario Outline: Client-side validation blocks submit with inline messages
    Examples: empty comment | no task | end <= start | missing start or end
  Scenario: Server 400/404 surfaced near the form, typed input preserved
```

## MT-12: UX polish

```gherkin
Feature: Workflow conveniences

  Scenario: "Log time" on a tree task opens the form with that task preselected
  Scenario: Delete asks confirmation, then removes the row without manual refresh
  Scenario: Rows show duration; create form defaults to a recent interval ending now
```

## MT-13: Documentation

```gherkin
Feature: README and handover

  Scenario: Following the README alone yields a running app end to end
  Scenario: Architecture section ties proxy/cache/queue to key secrecy and the 15/60s limit
  Scenario: Every /api endpoint documented; "What I'd improve" section present
```
