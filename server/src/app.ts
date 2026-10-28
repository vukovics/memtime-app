import express from "express";
import type { Cache } from "./cache.js";
import type { RateLimitQueue } from "./rateLimitQueue.js";
import {
  UpstreamApiError,
  type UpstreamClient,
  type UpstreamErrorKind,
} from "./upstream/client.js";
import type { ListParams, TimeEntryInput } from "./upstream/types.js";

export interface AppDeps {
  upstream: UpstreamClient;
  queue: RateLimitQueue;
  cache: Cache;
}

const STATUS_BY_KIND: Record<UpstreamErrorKind, number> = {
  BadRequest: 400,
  NotFound: 404,
  RateLimited: 503,
  UpstreamError: 502,
};

/** Thrown by request parsing; mapped to a local 400 by the error middleware. */
class BadRequestError extends Error {}

/** First query value if it is a non-empty string, otherwise undefined. */
function queryString(query: express.Request["query"], key: string): string | undefined {
  const value = query[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Extracts upstream pagination params (limit, offset, sortBy, order) from the
 * query string. Absent/empty params are omitted; returns undefined when none
 * are present. Throws BadRequestError for non-numeric limit/offset.
 */
function parseListParams(query: express.Request["query"]): ListParams | undefined {
  const params: ListParams = {};

  for (const key of ["limit", "offset"] as const) {
    const value = queryString(query, key);
    if (value === undefined) continue;
    const parsed = Number(value);
    if (Number.isNaN(parsed)) {
      throw new BadRequestError(
        `Invalid query parameter "${key}": must be a number`,
      );
    }
    params[key] = parsed;
  }

  const sortBy = queryString(query, "sortBy");
  if (sortBy !== undefined) params.sortBy = sortBy;
  const order = queryString(query, "order");
  if (order !== undefined) params.order = order as ListParams["order"];

  return Object.keys(params).length > 0 ? params : undefined;
}

/** Parses a path id segment; throws a local 400 naming the param if non-numeric. */
function parseId(raw: string, name: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new BadRequestError(`Invalid ${name} "${raw}": must be a number`);
  }
  return Number(raw);
}

// Standard ISO 8601 datetime: date, "T", time, optional seconds/millis,
// optional Z or numeric offset. Date-only strings and garbage are rejected.
const ISO_DATETIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/;

/** True for standard ISO 8601 datetimes that parse to a real instant. */
function isIsoDateTime(value: string): boolean {
  return ISO_DATETIME.test(value) && Number.isFinite(Date.parse(value));
}

/**
 * Validates a POST/PUT time-entry body. Returns the normalized input
 * (comment trimmed) or throws BadRequestError naming every invalid field.
 * Exported for tests.
 */
export function validateTimeEntryInput(body: unknown): TimeEntryInput {
  const record: Record<string, unknown> =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)
      : {};
  const errors: string[] = [];

  const { taskId, comment, start, end } = record;
  if (typeof taskId !== "number" || !Number.isInteger(taskId) || taskId <= 0) {
    errors.push('"taskId" must be a positive integer');
  }
  if (typeof comment !== "string" || comment.trim() === "") {
    errors.push('"comment" must be a non-empty string');
  }
  if (typeof start !== "string" || !isIsoDateTime(start)) {
    errors.push('"start" must be an ISO 8601 datetime');
  }
  if (typeof end !== "string" || !isIsoDateTime(end)) {
    errors.push('"end" must be an ISO 8601 datetime');
  } else if (
    errors.length === 0 &&
    Date.parse(end) <= Date.parse(start as string)
  ) {
    errors.push('"end" must be strictly after "start"');
  }

  if (errors.length > 0) {
    throw new BadRequestError(errors.join("; "));
  }
  return {
    taskId: taskId as number,
    comment: (comment as string).trim(),
    start: start as string,
    end: end as string,
  };
}

/** Cache key: request path plus the forwarded params, sorted by name. */
function cacheKey(path: string, params: ListParams | undefined): string {
  if (params === undefined) return path;
  const query = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join("&");
  return `${path}?${query}`;
}

export function createApp(deps: AppDeps): express.Express {
  const { upstream, queue, cache } = deps;
  const app = express();

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  /** Shared read path: parse params, then cache -> rate-limit queue -> upstream. */
  async function proxyList(
    req: express.Request,
    res: express.Response,
    fetch: (params?: ListParams) => Promise<unknown>,
  ): Promise<void> {
    const params = parseListParams(req.query);
    const result = await cache.getOrFetch(cacheKey(req.path, params), () =>
      queue.run(() => fetch(params)),
    );
    res.status(200).json(result);
  }

  app.get("/api/clients", (req, res) =>
    proxyList(req, res, (params) => upstream.listClients(params)),
  );

  app.get("/api/clients/:id/projects", (req, res) => {
    const clientId = parseId(req.params.id, "client id");
    return proxyList(req, res, (params) =>
      upstream.listClientProjects(clientId, params),
    );
  });

  app.get("/api/projects/:id/tasks", (req, res) => {
    const projectId = parseId(req.params.id, "project id");
    return proxyList(req, res, (params) =>
      upstream.listProjectTasks(projectId, params),
    );
  });

  // Time entries are the user's own fresh data: always rate-limit queued,
  // never cached.
  app.use("/api/time-entries", express.json());

  app.get("/api/time-entries", async (req, res) => {
    const params = parseListParams(req.query);
    const result = await queue.run(() => upstream.listTimeEntries(params));
    res.status(200).json(result);
  });

  app.get("/api/time-entries/:id", async (req, res) => {
    const id = parseId(req.params.id, "time entry id");
    res.status(200).json(await queue.run(() => upstream.getTimeEntry(id)));
  });

  app.post("/api/time-entries", async (req, res) => {
    const input = validateTimeEntryInput(req.body);
    const created = await queue.run(() => upstream.createTimeEntry(input));
    res.status(201).json(created);
  });

  app.put("/api/time-entries/:id", async (req, res) => {
    const id = parseId(req.params.id, "time entry id");
    const input = validateTimeEntryInput(req.body);
    const updated = await queue.run(() => upstream.updateTimeEntry(id, input));
    res.status(200).json(updated);
  });

  app.delete("/api/time-entries/:id", async (req, res) => {
    const id = parseId(req.params.id, "time entry id");
    res.status(200).json(await queue.run(() => upstream.deleteTimeEntry(id)));
  });

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      // express.json() reports malformed bodies as a SyntaxError with
      // status 400 and type "entity.parse.failed"; narrow on both so an
      // unrelated SyntaxError elsewhere isn't misreported as a bad body.
      if (
        err instanceof SyntaxError &&
        (err as { status?: unknown }).status === 400 &&
        (err as { type?: unknown }).type === "entity.parse.failed"
      ) {
        res.status(400).json({ error: "Invalid JSON body" });
        return;
      }
      if (err instanceof BadRequestError) {
        res.status(400).json({ error: err.message });
        return;
      }
      if (err instanceof UpstreamApiError) {
        if (err.kind === "RateLimited") res.set("Retry-After", "60");
        res.status(STATUS_BY_KIND[err.kind]).json({ error: err.upstreamMessage });
        return;
      }
      res.status(500).json({ error: "Internal server error" });
    },
  );

  return app;
}
