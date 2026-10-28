import express from "express";
import type { Cache } from "./cache.js";
import type { RateLimitQueue } from "./rateLimitQueue.js";
import {
  UpstreamApiError,
  type UpstreamClient,
  type UpstreamErrorKind,
} from "./upstream/client.js";
import type { ListParams } from "./upstream/types.js";

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
