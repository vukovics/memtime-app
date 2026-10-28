import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ApiService } from './api.service';
import { TimeEntryInput } from './api.types';

describe('ApiService', () => {
  let service: ApiService;
  let httpTesting: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(ApiService);
    httpTesting = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpTesting.verify();
  });

  it('requests clients without params by default', () => {
    service.getClients().subscribe();
    const req = httpTesting.expectOne('/api/clients');
    expect(req.request.method).toBe('GET');
    req.flush([]);
  });

  it('only sends list params that are set', () => {
    service.getClients({ limit: 10, sortBy: 'name' }).subscribe();
    const req = httpTesting.expectOne('/api/clients?limit=10&sortBy=name');
    expect(req.request.params.keys()).toEqual(['limit', 'sortBy']);
    req.flush([]);
  });

  it('requests projects for a client', () => {
    service.getProjects(7, { offset: 20, order: 'desc' }).subscribe();
    const req = httpTesting.expectOne('/api/clients/7/projects?offset=20&order=desc');
    expect(req.request.method).toBe('GET');
    req.flush([]);
  });

  it('requests tasks for a project', () => {
    service.getTasks(3).subscribe();
    const req = httpTesting.expectOne('/api/projects/3/tasks');
    expect(req.request.method).toBe('GET');
    req.flush([]);
  });

  it('requests time entries', () => {
    service.getTimeEntries({ limit: 5 }).subscribe();
    const req = httpTesting.expectOne('/api/time-entries?limit=5');
    expect(req.request.method).toBe('GET');
    req.flush([]);
  });

  it('requests a single time entry', () => {
    service.getTimeEntry(42).subscribe();
    const req = httpTesting.expectOne('/api/time-entries/42');
    expect(req.request.method).toBe('GET');
    req.flush({});
  });

  it('creates a time entry', () => {
    const input: TimeEntryInput = {
      taskId: 1,
      comment: 'Work',
      start: '2026-10-27T09:00:00Z',
      end: '2026-10-27T10:00:00Z',
    };
    service.createTimeEntry(input).subscribe();
    const req = httpTesting.expectOne('/api/time-entries');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual(input);
    req.flush({});
  });

  it('updates a time entry', () => {
    const input: TimeEntryInput = {
      taskId: 1,
      comment: 'Updated',
      start: '2026-10-27T09:00:00Z',
      end: '2026-10-27T11:00:00Z',
    };
    service.updateTimeEntry(42, input).subscribe();
    const req = httpTesting.expectOne('/api/time-entries/42');
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual(input);
    req.flush({});
  });

  it('deletes a time entry', () => {
    service.deleteTimeEntry(42).subscribe();
    const req = httpTesting.expectOne('/api/time-entries/42');
    expect(req.request.method).toBe('DELETE');
    req.flush({ message: 'deleted' });
  });
});
