import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type express from "express";
import { createApp, validateTimeEntryInput } from "./app.js";
import { createCache, type Cache } from "./cache.js";
import { createRateLimitQueue } from "./rateLimitQueue.js";
import { UpstreamApiError, type UpstreamClient } from "./upstream/client.js";

const entry = {
  id: 500,
  taskId: 1,
  userId: "user-1",
  comment: "Design review",
  start: "2026-01-05T09:00:00.000Z",
  end: "2026-01-05T10:30:00.000Z",
  createdAt: "2026-01-05T11:00:00.000Z",
  updatedAt: "2026-01-05T11:00:00.000Z",
};

const validBody = {
  taskId: 1,
  comment: "Design review",
  start: "2026-01-05T09:00:00.000Z",
  end: "2026-01-05T10:30:00.000Z",
};

let upstream: {
  listTimeEntries: ReturnType<typeof vi.fn>;
  getTimeEntry: ReturnType<typeof vi.fn>;
  createTimeEntry: ReturnType<typeof vi.fn>;
  updateTimeEntry: ReturnType<typeof vi.fn>;
  deleteTimeEntry: ReturnType<typeof vi.fn>;
};
let cache: Cache;
let app: express.Express;

beforeEach(() => {
  upstream = {
    listTimeEntries: vi.fn().mockResolvedValue([entry]),
    getTimeEntry: vi.fn().mockResolvedValue(entry),
    createTimeEntry: vi.fn().mockResolvedValue(entry),
    updateTimeEntry: vi.fn().mockResolvedValue(entry),
    deleteTimeEntry: vi
      .fn()
      .mockResolvedValue({ message: "Time entry deleted" }),
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

describe("GET /api/time-entries", () => {
  it("responds 200 with the upstream list, called without params", async () => {
    const response = await request(app).get("/api/time-entries");
    expect(response.status).toBe(200);
    expect(response.body).toEqual([entry]);
    expect(upstream.listTimeEntries).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("forwards pagination params", async () => {
    const response = await request(app).get(
      "/api/time-entries?limit=2&offset=5&sortBy=start&order=desc",
    );
    expect(response.status).toBe(200);
    expect(upstream.listTimeEntries).toHaveBeenCalledExactlyOnceWith({
      limit: 2,
      offset: 5,
      sortBy: "start",
      order: "desc",
    });
  });

  it("is never cached: two identical requests hit upstream twice", async () => {
    await request(app).get("/api/time-entries?limit=2");
    await request(app).get("/api/time-entries?limit=2");
    expect(upstream.listTimeEntries).toHaveBeenCalledTimes(2);
  });
});

describe("GET /api/time-entries/:id", () => {
  it("responds 200 and passes the id as a number", async () => {
    const response = await request(app).get("/api/time-entries/500");
    expect(response.status).toBe(200);
    expect(response.body).toEqual(entry);
    expect(upstream.getTimeEntry).toHaveBeenCalledExactlyOnceWith(500);
  });

  it("maps upstream NotFound to 404 with the upstream message", async () => {
    upstream.getTimeEntry.mockRejectedValue(
      new UpstreamApiError(404, "Time entry not found"),
    );
    const response = await request(app).get("/api/time-entries/999");
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Time entry not found" });
  });
});

describe("POST /api/time-entries", () => {
  it("responds 201 with the created entry and forwards the input", async () => {
    const response = await request(app)
      .post("/api/time-entries")
      .send(validBody);
    expect(response.status).toBe(201);
    expect(response.body).toEqual(entry);
    expect(upstream.createTimeEntry).toHaveBeenCalledExactlyOnceWith(validBody);
  });

  it("forwards the comment trimmed", async () => {
    await request(app)
      .post("/api/time-entries")
      .send({ ...validBody, comment: "  Design review  " });
    expect(upstream.createTimeEntry).toHaveBeenCalledExactlyOnceWith(validBody);
  });

  it("responds 400 Invalid JSON body for malformed JSON", async () => {
    const response = await request(app)
      .post("/api/time-entries")
      .set("content-type", "application/json")
      .send('{"taskId":');
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Invalid JSON body" });
    expect(upstream.createTimeEntry).not.toHaveBeenCalled();
  });

  it("scopes the JSON body parser to /api/time-entries", async () => {
    // Elsewhere, a malformed JSON body is never parsed, so the request
    // falls through to the /api 404 catch-all instead of a parse error.
    const response = await request(app)
      .post("/api/clients")
      .set("content-type", "application/json")
      .send('{"taskId":');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Not found" });
  });
});

describe("PUT /api/time-entries/:id", () => {
  it("responds 200 with the updated entry and passes the id as a number", async () => {
    const response = await request(app)
      .put("/api/time-entries/500")
      .send(validBody);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(entry);
    expect(upstream.updateTimeEntry).toHaveBeenCalledExactlyOnceWith(
      500,
      validBody,
    );
  });

  it("maps upstream NotFound to 404 with the upstream message", async () => {
    upstream.updateTimeEntry.mockRejectedValue(
      new UpstreamApiError(404, "Time entry not found"),
    );
    const response = await request(app)
      .put("/api/time-entries/999")
      .send(validBody);
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Time entry not found" });
  });
});

describe("DELETE /api/time-entries/:id", () => {
  it("responds 200 with the upstream message and passes the id as a number", async () => {
    const response = await request(app).delete("/api/time-entries/500");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: "Time entry deleted" });
    expect(upstream.deleteTimeEntry).toHaveBeenCalledExactlyOnceWith(500);
  });

  it("maps upstream NotFound to 404 with the upstream message", async () => {
    upstream.deleteTimeEntry.mockRejectedValue(
      new UpstreamApiError(404, "Time entry not found"),
    );
    const response = await request(app).delete("/api/time-entries/999");
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Time entry not found" });
  });
});

describe("non-numeric :id", () => {
  it.each([
    ["GET", () => request(app).get("/api/time-entries/abc")],
    ["PUT", () => request(app).put("/api/time-entries/abc").send(validBody)],
    ["DELETE", () => request(app).delete("/api/time-entries/abc")],
  ])("%s responds 400 without calling upstream", async (_method, send) => {
    const response = await send();
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("time entry id");
    expect(upstream.getTimeEntry).not.toHaveBeenCalled();
    expect(upstream.updateTimeEntry).not.toHaveBeenCalled();
    expect(upstream.deleteTimeEntry).not.toHaveBeenCalled();
  });
});

describe.each(["POST", "PUT"] as const)("%s body validation", (method) => {
  const send = (body: unknown) =>
    method === "POST"
      ? request(app).post("/api/time-entries").send(body as object)
      : request(app).put("/api/time-entries/500").send(body as object);

  it.each([
    ["missing taskId", { ...validBody, taskId: undefined }, "taskId"],
    ["string taskId", { ...validBody, taskId: "1" }, "taskId"],
    ["zero taskId", { ...validBody, taskId: 0 }, "taskId"],
    ["negative taskId", { ...validBody, taskId: -3 }, "taskId"],
    ["non-integer taskId", { ...validBody, taskId: 1.5 }, "taskId"],
    ["missing comment", { ...validBody, comment: undefined }, "comment"],
    ["empty comment", { ...validBody, comment: "" }, "comment"],
    ["whitespace-only comment", { ...validBody, comment: "   " }, "comment"],
    ["non-string comment", { ...validBody, comment: 42 }, "comment"],
    // Arrays are valid JSON and String() unwraps a single element, so a
    // dropped typeof guard would let [validISO] through the regex+Date.parse.
    ["array-wrapped start", { ...validBody, start: [validBody.start] }, "start"],
    ["array-wrapped end", { ...validBody, end: [validBody.end] }, "end"],
    ["missing start", { ...validBody, start: undefined }, "start"],
    ["garbage start", { ...validBody, start: "yesterday" }, "start"],
    ["non-string start", { ...validBody, start: 1767600000000 }, "start"],
    ["date-only start", { ...validBody, start: "2026-01-05" }, "start"],
    [
      "out-of-range start",
      { ...validBody, start: "2026-13-05T09:00:00.000Z" },
      "start",
    ],
    ["missing end", { ...validBody, end: undefined }, "end"],
    ["garbage end", { ...validBody, end: "not a date" }, "end"],
    [
      "end equal to start",
      { ...validBody, end: validBody.start },
      "end",
    ],
    [
      "end before start",
      { ...validBody, end: "2026-01-05T08:00:00.000Z" },
      "end",
    ],
  ])("responds 400 for %s without calling upstream", async (_name, body, field) => {
    const response = await send(body);
    expect(response.status).toBe(400);
    expect(response.body.error).toContain(field);
    expect(upstream.createTimeEntry).not.toHaveBeenCalled();
    expect(upstream.updateTimeEntry).not.toHaveBeenCalled();
  });
});

// Known-equivalent Stryker mutant on app.ts (taskId check, line 92): dropping
// `typeof taskId !== "number"` is unobservable — Number.isInteger never
// coerces and is false for every non-number, so the same error is pushed.
describe("validateTimeEntryInput (unit)", () => {
  /** Runs fn, returning the thrown error message; fails the test if it returns. */
  function errorMessage(fn: () => unknown): string {
    try {
      fn();
    } catch (err) {
      return (err as Error).message;
    }
    throw new Error("expected validateTimeEntryInput to throw");
  }

  const allFieldErrors =
    '"taskId" must be a positive integer; ' +
    '"comment" must be a non-empty string; ' +
    '"start" must be an ISO 8601 datetime; ' +
    '"end" must be an ISO 8601 datetime';

  // express.json (strict mode) only delivers objects, so the non-object
  // normalization arm is only reachable through a direct call.
  it.each([null, undefined, "nope", 42])(
    "treats non-object body %o as empty and reports every field, ; -joined in field order",
    (body) => {
      expect(errorMessage(() => validateTimeEntryInput(body))).toBe(
        allFieldErrors,
      );
    },
  );

  it("skips the end-after-start check when another field is already invalid", () => {
    expect(
      errorMessage(() =>
        validateTimeEntryInput({
          taskId: 0,
          comment: "x",
          start: "2026-01-05T09:00:00.000Z",
          end: "2026-01-05T09:00:00.000Z",
        }),
      ),
    ).toBe('"taskId" must be a positive integer');
  });

  it.each([
    ["no seconds", "2026-01-05T09:00Z", "2026-01-05T10:00Z"],
    ["no offset", "2026-01-05T09:00:00", "2026-01-05T10:00:00"],
    [
      "millis + positive offset",
      "2026-01-05T09:00:00.5+01:00",
      "2026-01-05T10:00:00.5+01:00",
    ],
    [
      "negative offset",
      "2026-01-05T09:00:00-05:00",
      "2026-01-05T10:00:00-05:00",
    ],
  ])("accepts the %s ISO 8601 form", (_name, start, end) => {
    expect(validateTimeEntryInput({ taskId: 1, comment: "x", start, end })).toEqual(
      { taskId: 1, comment: "x", start, end },
    );
  });

  // Date.parse accepts both of these, so the ISO regex alone must reject them.
  it.each([
    ["space instead of T", "2026-01-05 09:00:00Z"],
    ["offset without colon", "2026-01-05T09:00:00+0100"],
    // Also pins the regex ^ anchor: unanchored, it matches the inner
    // "2026-01-05T..." substring of the expanded-year form.
    ["an expanded year", "+002026-01-05T09:00:00Z"],
  ])("rejects %s even though Date.parse allows it", (_name, start) => {
    expect(
      errorMessage(() =>
        validateTimeEntryInput({
          taskId: 1,
          comment: "x",
          start,
          end: "2026-01-05T10:00:00.000Z",
        }),
      ),
    ).toBe('"start" must be an ISO 8601 datetime');
  });
});

describe("error middleware SyntaxError narrowing", () => {
  // Only express.json parse failures (SyntaxError + status 400 + type
  // "entity.parse.failed") are reported as a bad body; anything weaker is a 500.
  function withProps(err: Error, props: Record<string, unknown>): Error {
    return Object.assign(err, props);
  }

  it.each([
    ["a bare SyntaxError", new SyntaxError("oops")],
    [
      "a SyntaxError with status 400 but the wrong type",
      withProps(new SyntaxError("oops"), { status: 400, type: "other" }),
    ],
    [
      "a SyntaxError with the right type but the wrong status",
      withProps(new SyntaxError("oops"), {
        status: 500,
        type: "entity.parse.failed",
      }),
    ],
    [
      "a non-SyntaxError carrying body-parser markers",
      withProps(new Error("oops"), {
        status: 400,
        type: "entity.parse.failed",
      }),
    ],
  ])("maps %s to a generic 500, not Invalid JSON body", async (_name, err) => {
    upstream.listTimeEntries.mockRejectedValue(err);
    const response = await request(app).get("/api/time-entries");
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Internal server error" });
  });
});
