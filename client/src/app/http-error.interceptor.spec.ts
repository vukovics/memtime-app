import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ErrorService } from './error.service';
import { httpErrorInterceptor } from './http-error.interceptor';

describe('httpErrorInterceptor', () => {
  let http: HttpClient;
  let httpTesting: HttpTestingController;
  let errorService: ErrorService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([httpErrorInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpClient);
    httpTesting = TestBed.inject(HttpTestingController);
    errorService = TestBed.inject(ErrorService);
  });

  afterEach(() => {
    httpTesting.verify();
  });

  it('does not report successful responses', () => {
    http.get('/api/clients').subscribe();
    httpTesting.expectOne('/api/clients').flush([]);
    expect(errorService.message()).toBeNull();
  });

  it('uses the server error body message when present', () => {
    http.get('/api/clients').subscribe({ error: () => {} });
    httpTesting
      .expectOne('/api/clients')
      .flush({ error: 'Client not found' }, { status: 404, statusText: 'Not Found' });
    expect(errorService.message()).toBe('Client not found');
  });

  it('falls back to a generic message without an error body', () => {
    http.get('/api/clients').subscribe({ error: () => {} });
    httpTesting
      .expectOne('/api/clients')
      .flush('oops', { status: 500, statusText: 'Internal Server Error' });
    expect(errorService.message()).toBe('Request failed (500 Internal Server Error).');
  });

  it('reports network failures as unreachable server', () => {
    http.get('/api/clients').subscribe({ error: () => {} });
    httpTesting.expectOne('/api/clients').error(new ProgressEvent('error'));
    expect(errorService.message()).toBe(
      'Could not reach the server. Please check your connection.',
    );
  });

  it('rethrows the error to the caller', () => {
    let status: number | undefined;
    http.get('/api/clients').subscribe({
      error: (err) => (status = err.status),
    });
    httpTesting
      .expectOne('/api/clients')
      .flush({ error: 'nope' }, { status: 400, statusText: 'Bad Request' });
    expect(status).toBe(400);
  });
});
