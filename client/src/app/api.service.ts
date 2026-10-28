import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import {
  Client,
  DeleteResponse,
  ListParams,
  Project,
  Task,
  TimeEntry,
  TimeEntryInput,
} from './api.types';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

  getClients(params?: ListParams): Observable<Client[]> {
    return this.http.get<Client[]>('/api/clients', { params: toHttpParams(params) });
  }

  getProjects(clientId: number, params?: ListParams): Observable<Project[]> {
    return this.http.get<Project[]>(`/api/clients/${clientId}/projects`, {
      params: toHttpParams(params),
    });
  }

  getTasks(projectId: number, params?: ListParams): Observable<Task[]> {
    return this.http.get<Task[]>(`/api/projects/${projectId}/tasks`, {
      params: toHttpParams(params),
    });
  }

  getTimeEntries(params?: ListParams): Observable<TimeEntry[]> {
    return this.http.get<TimeEntry[]>('/api/time-entries', { params: toHttpParams(params) });
  }

  getTimeEntry(id: number): Observable<TimeEntry> {
    return this.http.get<TimeEntry>(`/api/time-entries/${id}`);
  }

  createTimeEntry(input: TimeEntryInput): Observable<TimeEntry> {
    return this.http.post<TimeEntry>('/api/time-entries', input);
  }

  updateTimeEntry(id: number, input: TimeEntryInput): Observable<TimeEntry> {
    return this.http.put<TimeEntry>(`/api/time-entries/${id}`, input);
  }

  deleteTimeEntry(id: number): Observable<DeleteResponse> {
    return this.http.delete<DeleteResponse>(`/api/time-entries/${id}`);
  }
}

function toHttpParams(params?: ListParams): HttpParams {
  let httpParams = new HttpParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) {
      httpParams = httpParams.set(key, value);
    }
  }
  return httpParams;
}
