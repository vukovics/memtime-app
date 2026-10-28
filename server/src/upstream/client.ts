import type {
  Client,
  DeleteResponse,
  ListParams,
  Project,
  Task,
  TimeEntry,
  TimeEntryInput,
} from './types.js';

export type UpstreamErrorKind =
  | 'BadRequest'
  | 'NotFound'
  | 'RateLimited'
  | 'UpstreamError';

export class UpstreamApiError extends Error {
  readonly status: number;
  readonly kind: UpstreamErrorKind;
  readonly upstreamMessage: string;

  constructor(status: number, upstreamMessage: string) {
    super(`Upstream request failed (${status}): ${upstreamMessage}`);
    this.name = 'UpstreamApiError';
    this.status = status;
    this.kind = kindFromStatus(status);
    this.upstreamMessage = upstreamMessage;
  }
}

function kindFromStatus(status: number): UpstreamErrorKind {
  switch (status) {
    case 400:
      return 'BadRequest';
    case 404:
      return 'NotFound';
    case 429:
      return 'RateLimited';
    default:
      return 'UpstreamError';
  }
}

export interface UpstreamClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Injectable for tests; defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
}

export interface UpstreamClient {
  listClients(params?: ListParams): Promise<Client[]>;
  getClient(id: number): Promise<Client>;
  listClientProjects(clientId: number, params?: ListParams): Promise<Project[]>;
  getProject(id: number): Promise<Project>;
  listProjectTasks(projectId: number, params?: ListParams): Promise<Task[]>;
  getTask(id: number): Promise<Task>;
  listTimeEntries(params?: ListParams): Promise<TimeEntry[]>;
  getTimeEntry(id: number): Promise<TimeEntry>;
  createTimeEntry(input: TimeEntryInput): Promise<TimeEntry>;
  updateTimeEntry(id: number, input: TimeEntryInput): Promise<TimeEntry>;
  deleteTimeEntry(id: number): Promise<DeleteResponse>;
}

export function createUpstreamClient(
  options: UpstreamClientOptions,
): UpstreamClient {
  const { apiKey, fetch = globalThis.fetch } = options;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  async function request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    opts: { params?: ListParams; body?: unknown } = {},
  ): Promise<T> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(opts.params ?? {})) {
      if (value !== undefined) query.set(key, String(value));
    }
    const url = `${baseUrl}${path}${query.size > 0 ? `?${query}` : ''}`;

    const headers: Record<string, string> = {
      authorization: `Bearer ${apiKey}`,
    };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }

    const response = await fetch(url, { method, headers, body });
    if (!response.ok) {
      throw new UpstreamApiError(
        response.status,
        await readErrorMessage(response),
      );
    }
    return (await response.json()) as T;
  }

  const id = String;

  return {
    listClients: (params) => request('GET', '/clients', { params }),
    getClient: (clientId) => request('GET', `/clients/${id(clientId)}`),
    listClientProjects: (clientId, params) =>
      request('GET', `/clients/${id(clientId)}/projects`, { params }),
    getProject: (projectId) => request('GET', `/projects/${id(projectId)}`),
    listProjectTasks: (projectId, params) =>
      request('GET', `/projects/${id(projectId)}/tasks`, { params }),
    getTask: (taskId) => request('GET', `/tasks/${id(taskId)}`),
    listTimeEntries: (params) => request('GET', '/time-entries', { params }),
    getTimeEntry: (entryId) => request('GET', `/time-entries/${id(entryId)}`),
    createTimeEntry: (input) =>
      request('POST', '/time-entries', { body: input }),
    updateTimeEntry: (entryId, input) =>
      request('PUT', `/time-entries/${id(entryId)}`, { body: input }),
    deleteTimeEntry: (entryId) =>
      request('DELETE', `/time-entries/${id(entryId)}`),
  };
}

async function readErrorMessage(response: Response): Promise<string> {
  const fallback = response.statusText || `HTTP ${response.status}`;
  try {
    const body: unknown = await response.json();
    if (
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      typeof (body as { error: unknown }).error === 'string'
    ) {
      return (body as { error: string }).error;
    }
    return fallback;
  } catch {
    return fallback;
  }
}
