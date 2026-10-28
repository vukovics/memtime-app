import { describe, expect, it, vi } from 'vitest';

import { createUpstreamClient, UpstreamApiError } from './client.js';

const BASE_URL = 'https://upstream.example/api/v1';
const API_KEY = 'test-key';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeClient(response: Response = jsonResponse({})) {
  const fetchStub = vi.fn(async () => response);
  const client = createUpstreamClient({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    fetch: fetchStub,
  });
  return { client, fetchStub };
}

function firstCall(fetchStub: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchStub.mock.calls[0] as [string, RequestInit];
  return { url: new URL(url), init };
}

function rawUrl(fetchStub: ReturnType<typeof vi.fn>): string {
  const [url] = fetchStub.mock.calls[0] as [string];
  return url;
}

describe('createUpstreamClient', () => {
  describe('request shape', () => {
    const cases: Array<{
      name: string;
      call: (client: ReturnType<typeof createUpstreamClient>) => Promise<unknown>;
      method: string;
      path: string;
    }> = [
      {
        name: 'listClients',
        call: (c) => c.listClients(),
        method: 'GET',
        path: '/api/v1/clients',
      },
      {
        name: 'getClient',
        call: (c) => c.getClient(1),
        method: 'GET',
        path: '/api/v1/clients/1',
      },
      {
        name: 'listClientProjects',
        call: (c) => c.listClientProjects(1),
        method: 'GET',
        path: '/api/v1/clients/1/projects',
      },
      {
        name: 'getProject',
        call: (c) => c.getProject(2),
        method: 'GET',
        path: '/api/v1/projects/2',
      },
      {
        name: 'listProjectTasks',
        call: (c) => c.listProjectTasks(2),
        method: 'GET',
        path: '/api/v1/projects/2/tasks',
      },
      {
        name: 'getTask',
        call: (c) => c.getTask(3),
        method: 'GET',
        path: '/api/v1/tasks/3',
      },
      {
        name: 'listTimeEntries',
        call: (c) => c.listTimeEntries(),
        method: 'GET',
        path: '/api/v1/time-entries',
      },
      {
        name: 'getTimeEntry',
        call: (c) => c.getTimeEntry(4),
        method: 'GET',
        path: '/api/v1/time-entries/4',
      },
      {
        name: 'createTimeEntry',
        call: (c) =>
          c.createTimeEntry({
            taskId: 3,
            comment: 'work',
            start: '2026-01-01T09:00:00Z',
            end: '2026-01-01T10:00:00Z',
          }),
        method: 'POST',
        path: '/api/v1/time-entries',
      },
      {
        name: 'updateTimeEntry',
        call: (c) =>
          c.updateTimeEntry(4, {
            taskId: 3,
            comment: 'work',
            start: '2026-01-01T09:00:00Z',
            end: '2026-01-01T10:00:00Z',
          }),
        method: 'PUT',
        path: '/api/v1/time-entries/4',
      },
      {
        name: 'deleteTimeEntry',
        call: (c) => c.deleteTimeEntry(4),
        method: 'DELETE',
        path: '/api/v1/time-entries/4',
      },
    ];

    it.each(cases)(
      '$name sends $method $path with bearer auth',
      async ({ call, method, path }) => {
        const { client, fetchStub } = makeClient();

        await call(client);

        expect(fetchStub).toHaveBeenCalledTimes(1);
        const { url, init } = firstCall(fetchStub);
        expect(url.pathname).toBe(path);
        expect(init.method).toBe(method);
        expect(new Headers(init.headers).get('authorization')).toBe(
          `Bearer ${API_KEY}`,
        );
      },
    );

    it('returns the parsed JSON body', async () => {
      const task = { id: 3, parent: 2, name: 'Task' };
      const { client } = makeClient(jsonResponse(task));

      await expect(client.getTask(3)).resolves.toEqual(task);
    });

    it('interpolates numeric ids into the path as-is', async () => {
      const { client, fetchStub } = makeClient();

      await client.getClient(1234567890);

      const { url } = firstCall(fetchStub);
      expect(url.pathname).toBe('/api/v1/clients/1234567890');
    });

    it('strips all trailing slashes from the base URL', async () => {
      const fetchStub = vi.fn(async () => jsonResponse({}));
      const client = createUpstreamClient({
        baseUrl: `${BASE_URL}//`,
        apiKey: API_KEY,
        fetch: fetchStub,
      });

      await client.listClients();

      expect(rawUrl(fetchStub)).toBe(`${BASE_URL}/clients`);
    });

    it('sends no content-type header when there is no body', async () => {
      const { client, fetchStub } = makeClient();

      await client.getTask(3);

      const { init } = firstCall(fetchStub);
      expect(new Headers(init.headers).get('content-type')).toBeNull();
    });
  });

  describe('pagination params', () => {
    it('forwards all params when provided', async () => {
      const { client, fetchStub } = makeClient();

      await client.listClients({
        limit: 10,
        offset: 20,
        sortBy: 'name',
        order: 'desc',
      });

      const { url } = firstCall(fetchStub);
      expect(url.searchParams.get('limit')).toBe('10');
      expect(url.searchParams.get('offset')).toBe('20');
      expect(url.searchParams.get('sortBy')).toBe('name');
      expect(url.searchParams.get('order')).toBe('desc');
    });

    it('forwards only the provided params', async () => {
      const { client, fetchStub } = makeClient();

      await client.listTimeEntries({ limit: 5 });

      const { url } = firstCall(fetchStub);
      expect(url.searchParams.get('limit')).toBe('5');
      expect([...url.searchParams.keys()]).toEqual(['limit']);
    });

    it('skips params explicitly set to undefined', async () => {
      const { client, fetchStub } = makeClient();

      await client.listClients({ limit: 5, offset: undefined });

      const { url } = firstCall(fetchStub);
      expect([...url.searchParams.keys()]).toEqual(['limit']);
    });

    it('includes offset 0 when explicitly provided', async () => {
      const { client, fetchStub } = makeClient();

      await client.listClientProjects(1, { offset: 0 });

      const { url } = firstCall(fetchStub);
      expect(url.searchParams.get('offset')).toBe('0');
    });

    it('listProjectTasks forwards pagination params', async () => {
      const { client, fetchStub } = makeClient();

      await client.listProjectTasks(2, { limit: 3 });

      const { url } = firstCall(fetchStub);
      expect(url.searchParams.get('limit')).toBe('3');
    });

    it('sends no query string (not even "?") when params are omitted', async () => {
      const { client, fetchStub } = makeClient();

      await client.listProjectTasks(2);

      expect(rawUrl(fetchStub)).toBe(`${BASE_URL}/projects/2/tasks`);
    });
  });

  describe('write requests', () => {
    const body = {
      taskId: 3,
      comment: 'standup',
      start: '2026-01-01T09:00:00Z',
      end: '2026-01-01T09:15:00Z',
    };

    it('createTimeEntry sends a JSON body with content-type', async () => {
      const { client, fetchStub } = makeClient();

      await client.createTimeEntry(body);

      const { init } = firstCall(fetchStub);
      expect(new Headers(init.headers).get('content-type')).toBe(
        'application/json',
      );
      expect(JSON.parse(init.body as string)).toEqual(body);
    });

    it('updateTimeEntry sends a JSON body with content-type', async () => {
      const { client, fetchStub } = makeClient();

      await client.updateTimeEntry(4, body);

      const { init } = firstCall(fetchStub);
      expect(new Headers(init.headers).get('content-type')).toBe(
        'application/json',
      );
      expect(JSON.parse(init.body as string)).toEqual(body);
    });

    it('deleteTimeEntry sends no body and returns the message', async () => {
      const { client, fetchStub } = makeClient(
        jsonResponse({ message: 'deleted' }),
      );

      await expect(client.deleteTimeEntry(4)).resolves.toEqual({
        message: 'deleted',
      });
      const { init } = firstCall(fetchStub);
      expect(init.body).toBeUndefined();
    });
  });

  describe('error mapping', () => {
    const errorCases: Array<{ status: number; kind: string }> = [
      { status: 400, kind: 'BadRequest' },
      { status: 404, kind: 'NotFound' },
      { status: 429, kind: 'RateLimited' },
      { status: 500, kind: 'UpstreamError' },
      { status: 503, kind: 'UpstreamError' },
    ];

    it.each(errorCases)(
      'maps upstream $status to kind $kind with the upstream message',
      async ({ status, kind }) => {
        const { client } = makeClient(
          jsonResponse({ error: 'boom' }, status),
        );

        const error = await client.listClients().catch((e: unknown) => e);

        expect(error).toBeInstanceOf(UpstreamApiError);
        const apiError = error as UpstreamApiError;
        expect(apiError.name).toBe('UpstreamApiError');
        expect(apiError.status).toBe(status);
        expect(apiError.kind).toBe(kind);
        expect(apiError.upstreamMessage).toBe('boom');
        expect(apiError.message).toContain('boom');
      },
    );

    it('falls back to the status text when the error body is not JSON', async () => {
      const { client } = makeClient(
        new Response('<html>oops</html>', {
          status: 500,
          statusText: 'Internal Server Error',
        }),
      );

      const error = await client.getTask(3).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UpstreamApiError);
      const apiError = error as UpstreamApiError;
      expect(apiError.status).toBe(500);
      expect(apiError.kind).toBe('UpstreamError');
      expect(apiError.upstreamMessage).toBe('Internal Server Error');
    });

    it('falls back when the JSON error body has no string error field', async () => {
      const { client } = makeClient(
        new Response(JSON.stringify({ error: 42, detail: 'nope' }), {
          status: 500,
          statusText: 'Internal Server Error',
        }),
      );

      const error = await client.listClients().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UpstreamApiError);
      expect((error as UpstreamApiError).upstreamMessage).toBe(
        'Internal Server Error',
      );
    });

    it('falls back to "HTTP <status>" when status text is empty', async () => {
      const { client } = makeClient(new Response(null, { status: 502 }));

      const error = await client.listClients().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UpstreamApiError);
      expect((error as UpstreamApiError).upstreamMessage).toBe('HTTP 502');
    });

    it('maps unexpected non-ok statuses to UpstreamError', async () => {
      const { client } = makeClient(jsonResponse({ error: 'nope' }, 403));

      const error = await client.listClients().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UpstreamApiError);
      expect((error as UpstreamApiError).kind).toBe('UpstreamError');
    });
  });
});
