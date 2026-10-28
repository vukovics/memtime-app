import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type express from "express";
import { createApp } from "./app.js";
import { createCache, type Cache } from "./cache.js";
import { createRateLimitQueue } from "./rateLimitQueue.js";
import { UpstreamApiError, type UpstreamClient } from "./upstream/client.js";

const clients = [{ id: 1, name: "Acme" }];
const projects = [{ id: 10, clientId: 1, name: "Website" }];
const tasks = [{ id: 100, parent: 10, name: "Design" }];

let upstream: {
  listClients: ReturnType<typeof vi.fn>;
  listClientProjects: ReturnType<typeof vi.fn>;
  listProjectTasks: ReturnType<typeof vi.fn>;
};
let cache: Cache;
let app: express.Express;

beforeEach(() => {
  upstream = {
    listClients: vi.fn().mockResolvedValue(clients),
    listClientProjects: vi.fn().mockResolvedValue(projects),
    listProjectTasks: vi.fn().mockResolvedValue(tasks),
  };
  cache = createCache({ dbPath: ":memory:" });
  app = createApp({
    upstream: upstream as unknown as UpstreamClient,
    queue: createRateLimitQueue(),
    cache,
  });
});

afterEach(() => {
  cache.close();
});

describe("GET /health", () => {
  it("responds 200 with status ok", async () => {
    const response = await request(app).get("/health");
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
  });
});

describe("GET /api/clients", () => {
  it("responds 200 with the upstream list, called without params", async () => {
    const response = await request(app).get("/api/clients");
    expect(response.status).toBe(200);
    expect(response.body).toEqual(clients);
    expect(upstream.listClients).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("forwards pagination params", async () => {
    const response = await request(app).get(
      "/api/clients?limit=2&offset=5&sortBy=name&order=desc",
    );
    expect(response.status).toBe(200);
    expect(upstream.listClients).toHaveBeenCalledExactlyOnceWith({
      limit: 2,
      offset: 5,
      sortBy: "name",
      order: "desc",
    });
  });

  it("forwards only the params that are present", async () => {
    await request(app).get("/api/clients?limit=3");
    expect(upstream.listClients).toHaveBeenCalledExactlyOnceWith({ limit: 3 });
  });

  it("treats empty params as absent", async () => {
    await request(app).get("/api/clients?limit=&sortBy=");
    expect(upstream.listClients).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("treats repeated (non-string) params as absent", async () => {
    const response = await request(app).get("/api/clients?limit=1&limit=2");
    expect(response.status).toBe(200);
    expect(upstream.listClients).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it.each(["limit", "offset"])(
    "responds 400 for non-numeric %s without calling upstream",
    async (param) => {
      const response = await request(app).get(`/api/clients?${param}=abc`);
      expect(response.status).toBe(400);
      expect(response.body.error).toContain(param);
      expect(upstream.listClients).not.toHaveBeenCalled();
    },
  );
});

describe("GET /api/clients/:id/projects", () => {
  it("responds 200 and passes the id as a number", async () => {
    const response = await request(app).get("/api/clients/5/projects?limit=2");
    expect(response.status).toBe(200);
    expect(response.body).toEqual(projects);
    expect(upstream.listClientProjects).toHaveBeenCalledExactlyOnceWith(5, {
      limit: 2,
    });
  });

  it("responds 400 for a non-numeric id without calling upstream", async () => {
    const response = await request(app).get("/api/clients/abc/projects");
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("client id");
    expect(upstream.listClientProjects).not.toHaveBeenCalled();
  });
});

describe("GET /api/projects/:id/tasks", () => {
  it("responds 200 and passes the id as a number", async () => {
    const response = await request(app).get("/api/projects/7/tasks");
    expect(response.status).toBe(200);
    expect(response.body).toEqual(tasks);
    expect(upstream.listProjectTasks).toHaveBeenCalledExactlyOnceWith(
      7,
      undefined,
    );
  });

  it("responds 400 for a non-numeric id without calling upstream", async () => {
    const response = await request(app).get("/api/projects/1.5/tasks");
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("project id");
    expect(upstream.listProjectTasks).not.toHaveBeenCalled();
  });
});

describe("caching", () => {
  it("serves a second identical request from cache", async () => {
    const first = await request(app).get("/api/clients?limit=2");
    const second = await request(app).get("/api/clients?limit=2");
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(upstream.listClients).toHaveBeenCalledTimes(1);
  });

  it("normalizes query param order in the cache key", async () => {
    await request(app).get("/api/clients?offset=0&limit=2");
    await request(app).get("/api/clients?limit=2&offset=0");
    expect(upstream.listClients).toHaveBeenCalledTimes(1);
  });

  it("calls upstream again for different params", async () => {
    await request(app).get("/api/clients?limit=2");
    await request(app).get("/api/clients?limit=3");
    expect(upstream.listClients).toHaveBeenCalledTimes(2);
  });

  it("caches per path, not just per params", async () => {
    await request(app).get("/api/clients/1/projects");
    await request(app).get("/api/clients/2/projects");
    expect(upstream.listClientProjects).toHaveBeenCalledTimes(2);
  });

  // Kills the Stryker mutant that drops the "&" separator from the cache key:
  // without it, {order: "x", sortBy: "y"} and {order: "xsortBy=y"} collide.
  it("keeps distinct param sets distinct in the cache key", async () => {
    await request(app).get("/api/clients?order=x&sortBy=y");
    await request(app).get("/api/clients?order=xsortBy%3Dy");
    expect(upstream.listClients).toHaveBeenCalledTimes(2);
  });

  // Known-equivalent Stryker mutants on app.ts (cacheKey, lines 72-73):
  // removing/neutering the `.sort()` is unobservable — parseListParams always
  // builds params in a fixed key order (limit, offset, sortBy, order), so the
  // unsorted entry order is already deterministic and the cache key stays
  // consistent for identical param sets either way.
});

describe("error handling", () => {
  it("maps upstream BadRequest to 400 with the upstream message", async () => {
    upstream.listClients.mockRejectedValue(
      new UpstreamApiError(400, "Invalid sortBy field"),
    );
    const response = await request(app).get("/api/clients");
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Invalid sortBy field" });
  });

  it("maps upstream NotFound to 404 with the upstream message", async () => {
    upstream.listClientProjects.mockRejectedValue(
      new UpstreamApiError(404, "Client not found"),
    );
    const response = await request(app).get("/api/clients/999/projects");
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Client not found" });
  });

  it("maps upstream RateLimited to 503 with a Retry-After header", async () => {
    upstream.listClients.mockRejectedValue(
      new UpstreamApiError(429, "Rate limit exceeded"),
    );
    const response = await request(app).get("/api/clients");
    expect(response.status).toBe(503);
    expect(response.headers["retry-after"]).toBe("60");
    expect(response.body).toEqual({ error: "Rate limit exceeded" });
  });

  it("maps upstream UpstreamError to 502 with the upstream message", async () => {
    upstream.listProjectTasks.mockRejectedValue(
      new UpstreamApiError(500, "Internal error"),
    );
    const response = await request(app).get("/api/projects/1/tasks");
    expect(response.status).toBe(502);
    expect(response.body).toEqual({ error: "Internal error" });
    expect(response.headers["retry-after"]).toBeUndefined();
  });

  it("maps unknown errors to a generic 500 without leaking internals", async () => {
    upstream.listClients.mockRejectedValue(
      new Error("secret db password leaked"),
    );
    const response = await request(app).get("/api/clients");
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Internal server error" });
  });

  it("does not cache upstream failures", async () => {
    upstream.listClients.mockRejectedValueOnce(
      new UpstreamApiError(500, "boom"),
    );
    await request(app).get("/api/clients");
    const response = await request(app).get("/api/clients");
    expect(response.status).toBe(200);
    expect(response.body).toEqual(clients);
  });

  it("responds 404 JSON for unknown /api/* paths", async () => {
    const response = await request(app).get("/api/nope");
    expect(response.status).toBe(404);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.body).toEqual({ error: "Not found" });
  });

  it("scopes the JSON 404 catch-all to /api paths only", async () => {
    const response = await request(app).get("/nope");
    expect(response.status).toBe(404);
    expect(response.headers["content-type"]).not.toContain("application/json");
  });
});
