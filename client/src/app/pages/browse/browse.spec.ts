import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { Subject, of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { ApiService } from '../../api.service';
import { Client, Project, Task } from '../../api.types';
import { Browse } from './browse';

function makeClient(id: number): Client {
  return {
    id,
    name: `Client ${id}`,
    description: '',
    status: 'active',
    createdAt: '',
    updatedAt: '',
  };
}

function makeProject(id: number, clientId: number): Project {
  return { id, clientId, name: `Project ${id}`, status: 'active', createdAt: '', updatedAt: '' };
}

function makeTask(id: number, parent: number): Task {
  return { id, parent, name: `Task ${id}`, status: 'open', createdAt: '', updatedAt: '' };
}

describe('Browse', () => {
  let api: {
    getClients: ReturnType<typeof vi.fn>;
    getProjects: ReturnType<typeof vi.fn>;
    getTasks: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    api = {
      getClients: vi.fn().mockReturnValue(of([makeClient(1), makeClient(2)])),
      getProjects: vi.fn().mockReturnValue(of([])),
      getTasks: vi.fn().mockReturnValue(of([])),
    };
    await TestBed.configureTestingModule({
      imports: [Browse],
      providers: [provideRouter([]), { provide: ApiService, useValue: api }],
    }).compileComponents();
  });

  async function create(): Promise<ComponentFixture<Browse>> {
    const fixture = TestBed.createComponent(Browse);
    await fixture.whenStable();
    return fixture;
  }

  function text(fixture: ComponentFixture<Browse>): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  }

  function rowButton(fixture: ComponentFixture<Browse>, label: string): HTMLButtonElement {
    const button = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('button.row'),
    ).find((b) => b.textContent?.includes(label));
    if (!button) throw new Error(`No row button containing "${label}"`);
    return button;
  }

  function loadMoreButton(fixture: ComponentFixture<Browse>): HTMLButtonElement | null {
    return (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      'button.load-more',
    );
  }

  it('loads only the first page of clients on init', async () => {
    const fixture = await create();
    expect(api.getClients).toHaveBeenCalledTimes(1);
    expect(api.getClients).toHaveBeenCalledWith({ limit: 10, offset: 0 });
    expect(api.getProjects).not.toHaveBeenCalled();
    expect(api.getTasks).not.toHaveBeenCalled();
    expect(text(fixture)).toContain('Client 1');
    expect(text(fixture)).toContain('Client 2');
  });

  it('shows "No clients" when the first page is empty', async () => {
    api.getClients.mockReturnValue(of([]));
    const fixture = await create();
    expect(text(fixture)).toContain('No clients');
    expect(loadMoreButton(fixture)).toBeNull();
  });

  it('fetches and nests projects when a client is expanded', async () => {
    api.getProjects.mockReturnValue(of([makeProject(10, 1)]));
    const fixture = await create();

    rowButton(fixture, 'Client 1').click();
    await fixture.whenStable();

    expect(api.getProjects).toHaveBeenCalledTimes(1);
    expect(api.getProjects).toHaveBeenCalledWith(1, { limit: 10, offset: 0 });
    expect(rowButton(fixture, 'Client 1').getAttribute('aria-expanded')).toBe('true');
    expect(text(fixture)).toContain('Project 10');
  });

  it('shows a loading indicator on the node while its projects are fetching', async () => {
    const projects$ = new Subject<Project[]>();
    api.getProjects.mockReturnValue(projects$.asObservable());
    const fixture = await create();

    rowButton(fixture, 'Client 1').click();
    await fixture.whenStable();
    expect(rowButton(fixture, 'Client 1').textContent).toContain('Loading…');

    projects$.next([makeProject(10, 1)]);
    projects$.complete();
    await fixture.whenStable();
    expect(text(fixture)).not.toContain('Loading…');
    expect(text(fixture)).toContain('Project 10');
  });

  it('does not refetch projects on collapse and re-expand', async () => {
    api.getProjects.mockReturnValue(of([makeProject(10, 1)]));
    const fixture = await create();

    rowButton(fixture, 'Client 1').click(); // expand (fetches)
    await fixture.whenStable();
    rowButton(fixture, 'Client 1').click(); // collapse
    await fixture.whenStable();
    expect(text(fixture)).not.toContain('Project 10');

    rowButton(fixture, 'Client 1').click(); // re-expand (from memory)
    await fixture.whenStable();
    expect(api.getProjects).toHaveBeenCalledTimes(1);
    expect(text(fixture)).toContain('Project 10');
  });

  it('shows "No projects" for a client with an empty projects list', async () => {
    const fixture = await create();
    rowButton(fixture, 'Client 1').click();
    await fixture.whenStable();
    expect(text(fixture)).toContain('No projects');
  });

  it('fetches tasks when a project is expanded and shows "No tasks" when empty', async () => {
    api.getProjects.mockReturnValue(of([makeProject(10, 1)]));
    const fixture = await create();
    rowButton(fixture, 'Client 1').click();
    await fixture.whenStable();

    rowButton(fixture, 'Project 10').click();
    await fixture.whenStable();
    expect(api.getTasks).toHaveBeenCalledTimes(1);
    expect(api.getTasks).toHaveBeenCalledWith(10, { limit: 10, offset: 0 });
    expect(text(fixture)).toContain('No tasks');

    api.getTasks.mockReturnValue(of([makeTask(100, 10)]));
    rowButton(fixture, 'Project 10').click(); // collapse
    rowButton(fixture, 'Project 10').click(); // re-expand: no refetch
    await fixture.whenStable();
    expect(api.getTasks).toHaveBeenCalledTimes(1);
  });

  it('shows Load more after a full page and appends the next offset', async () => {
    const firstPage = Array.from({ length: 10 }, (_, i) => makeClient(i + 1));
    api.getClients.mockReturnValueOnce(of(firstPage)).mockReturnValueOnce(of([makeClient(11)]));
    const fixture = await create();

    const loadMore = loadMoreButton(fixture);
    expect(loadMore).not.toBeNull();
    loadMore!.click();
    await fixture.whenStable();

    expect(api.getClients).toHaveBeenCalledTimes(2);
    expect(api.getClients).toHaveBeenLastCalledWith({ limit: 10, offset: 10 });
    expect(text(fixture)).toContain('Client 1');
    expect(text(fixture)).toContain('Client 11');
    // Short page means the end was reached: no further Load more.
    expect(loadMoreButton(fixture)).toBeNull();
  });

  it('stops loading and stays collapsed when a projects fetch fails, and retries on re-expand', async () => {
    api.getProjects
      .mockReturnValueOnce(throwError(() => new Error('upstream down')))
      .mockReturnValueOnce(of([makeProject(10, 1)]));
    const fixture = await create();

    rowButton(fixture, 'Client 1').click();
    await fixture.whenStable();
    expect(rowButton(fixture, 'Client 1').getAttribute('aria-expanded')).toBe('false');
    expect(text(fixture)).not.toContain('Loading…');
    expect(text(fixture)).not.toContain('Project 10');

    rowButton(fixture, 'Client 1').click(); // retry
    await fixture.whenStable();
    expect(api.getProjects).toHaveBeenCalledTimes(2);
    expect(rowButton(fixture, 'Client 1').getAttribute('aria-expanded')).toBe('true');
    expect(text(fixture)).toContain('Project 10');
  });

  it('stops loading clients when the clients fetch fails', async () => {
    const clients$ = new Subject<Client[]>();
    api.getClients.mockReturnValue(clients$.asObservable());
    const fixture = await create();
    expect(text(fixture)).toContain('Loading…');

    clients$.error(new Error('upstream down'));
    await fixture.whenStable();
    expect(text(fixture)).not.toContain('Loading…');
    expect(text(fixture)).toContain('No clients');
  });

  it('stops loading and retries when a tasks fetch fails', async () => {
    api.getProjects.mockReturnValue(of([makeProject(10, 1)]));
    api.getTasks
      .mockReturnValueOnce(throwError(() => new Error('upstream down')))
      .mockReturnValueOnce(of([makeTask(100, 10)]));
    const fixture = await create();
    rowButton(fixture, 'Client 1').click();
    await fixture.whenStable();

    rowButton(fixture, 'Project 10').click();
    await fixture.whenStable();
    expect(rowButton(fixture, 'Project 10').getAttribute('aria-expanded')).toBe('false');
    expect(text(fixture)).not.toContain('Loading…');
    expect(text(fixture)).not.toContain('Task 100');

    rowButton(fixture, 'Project 10').click(); // retry
    await fixture.whenStable();
    expect(api.getTasks).toHaveBeenCalledTimes(2);
    expect(rowButton(fixture, 'Project 10').getAttribute('aria-expanded')).toBe('true');
    expect(text(fixture)).toContain('Task 100');
  });

  it('shows Load more for projects after a full page and appends the next offset', async () => {
    const firstPage = Array.from({ length: 10 }, (_, i) => makeProject(i + 1, 1));
    api.getProjects
      .mockReturnValueOnce(of(firstPage))
      .mockReturnValueOnce(of([makeProject(11, 1)]));
    const fixture = await create();

    rowButton(fixture, 'Client 1').click();
    await fixture.whenStable();
    const loadMore = loadMoreButton(fixture);
    expect(loadMore).not.toBeNull();

    loadMore!.click();
    await fixture.whenStable();
    expect(api.getProjects).toHaveBeenCalledTimes(2);
    expect(api.getProjects).toHaveBeenLastCalledWith(1, { limit: 10, offset: 10 });
    expect(text(fixture)).toContain('Project 11');
    expect(loadMoreButton(fixture)).toBeNull();
  });

  it('shows a loading indicator in place of Load more while fetching the next page of projects', async () => {
    const firstPage = Array.from({ length: 10 }, (_, i) => makeProject(i + 1, 1));
    const secondPage$ = new Subject<Project[]>();
    api.getProjects
      .mockReturnValueOnce(of(firstPage))
      .mockReturnValueOnce(secondPage$.asObservable());
    const fixture = await create();

    rowButton(fixture, 'Client 1').click();
    await fixture.whenStable();
    loadMoreButton(fixture)!.click();
    await fixture.whenStable();

    expect(loadMoreButton(fixture)).toBeNull();
    expect(text(fixture)).toContain('Loading…');

    secondPage$.next([makeProject(11, 1)]);
    secondPage$.complete();
    await fixture.whenStable();
    expect(text(fixture)).toContain('Project 11');
  });

  it('does not refetch projects when the row is clicked again while already loading', async () => {
    const projects$ = new Subject<Project[]>();
    api.getProjects.mockReturnValue(projects$.asObservable());
    const fixture = await create();

    rowButton(fixture, 'Client 1').click();
    rowButton(fixture, 'Client 1').click(); // second click while in flight: ignored
    await fixture.whenStable();
    expect(api.getProjects).toHaveBeenCalledTimes(1);

    projects$.next([makeProject(10, 1)]);
    projects$.complete();
    await fixture.whenStable();
    expect(text(fixture)).toContain('Project 10');
  });

  it('does not refetch tasks when the row is clicked again while already loading', async () => {
    api.getProjects.mockReturnValue(of([makeProject(10, 1)]));
    const tasks$ = new Subject<Task[]>();
    api.getTasks.mockReturnValue(tasks$.asObservable());
    const fixture = await create();
    rowButton(fixture, 'Client 1').click();
    await fixture.whenStable();

    rowButton(fixture, 'Project 10').click();
    rowButton(fixture, 'Project 10').click(); // second click while in flight: ignored
    await fixture.whenStable();
    expect(api.getTasks).toHaveBeenCalledTimes(1);

    tasks$.next([makeTask(100, 10)]);
    tasks$.complete();
    await fixture.whenStable();
    expect(text(fixture)).toContain('Task 100');
  });

  it('a task\'s "Log time" button navigates to time-entries with the task id as a query param', async () => {
    api.getProjects.mockReturnValue(of([makeProject(10, 1)]));
    api.getTasks.mockReturnValue(of([makeTask(100, 10)]));
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const fixture = await create();

    rowButton(fixture, 'Client 1').click();
    await fixture.whenStable();
    rowButton(fixture, 'Project 10').click();
    await fixture.whenStable();

    const logTime = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      'button.log-time',
    );
    expect(logTime).not.toBeNull();
    logTime!.click();
    expect(navigate).toHaveBeenCalledExactlyOnceWith(['/time-entries'], {
      queryParams: { taskId: 100 },
    });
  });

  it('shows Load more for tasks after a full page and appends the next offset', async () => {
    api.getProjects.mockReturnValue(of([makeProject(10, 1)]));
    const firstPage = Array.from({ length: 10 }, (_, i) => makeTask(i + 1, 10));
    api.getTasks.mockReturnValueOnce(of(firstPage)).mockReturnValueOnce(of([makeTask(11, 10)]));
    const fixture = await create();

    rowButton(fixture, 'Client 1').click();
    await fixture.whenStable();
    rowButton(fixture, 'Project 10').click();
    await fixture.whenStable();

    const loadMore = loadMoreButton(fixture);
    expect(loadMore).not.toBeNull();
    loadMore!.click();
    await fixture.whenStable();

    expect(api.getTasks).toHaveBeenCalledTimes(2);
    expect(api.getTasks).toHaveBeenLastCalledWith(10, { limit: 10, offset: 10 });
    expect(text(fixture)).toContain('Task 11');
    expect(loadMoreButton(fixture)).toBeNull();
  });

  it('shows a loading indicator in place of Load more while fetching the next page of tasks', async () => {
    api.getProjects.mockReturnValue(of([makeProject(10, 1)]));
    const firstPage = Array.from({ length: 10 }, (_, i) => makeTask(i + 1, 10));
    const secondPage$ = new Subject<Task[]>();
    api.getTasks.mockReturnValueOnce(of(firstPage)).mockReturnValueOnce(secondPage$.asObservable());
    const fixture = await create();
    rowButton(fixture, 'Client 1').click();
    await fixture.whenStable();
    rowButton(fixture, 'Project 10').click();
    await fixture.whenStable();

    loadMoreButton(fixture)!.click();
    await fixture.whenStable();
    expect(loadMoreButton(fixture)).toBeNull();
    expect(text(fixture)).toContain('Loading…');

    secondPage$.next([makeTask(11, 10)]);
    secondPage$.complete();
    await fixture.whenStable();
    expect(text(fixture)).toContain('Task 11');
  });
});
