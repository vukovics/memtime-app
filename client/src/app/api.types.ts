// Shapes mirror the server's API responses (see server/src/upstream/types.ts).

export interface Client {
  id: number;
  name: string;
  description: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: number;
  clientId: number;
  name: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: number;
  parent: number;
  name: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface TimeEntry {
  id: number;
  taskId: number;
  userId: string;
  comment: string;
  start: string;
  end: string;
  createdAt: string;
  updatedAt: string;
}

/** Body for POST/PUT /api/time-entries (dates as ISO 8601 strings). */
export interface TimeEntryInput {
  taskId: number;
  comment: string;
  start: string;
  end: string;
}

export interface DeleteResponse {
  message: string;
}

/** Query params accepted by the list endpoints. */
export interface ListParams {
  limit?: number;
  offset?: number;
  sortBy?: string;
  order?: 'asc' | 'desc';
}
