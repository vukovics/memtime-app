import { formatDate } from '@angular/common';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { Subject, of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { ApiService } from '../../api.service';
import { TimeEntry } from '../../api.types';
import { appConfig } from '../../app.config';
import { isoToLocalInput } from './datetime';
import { EntryForm } from './entry-form';
import { TimeEntries } from './time-entries';

const START = '2026-01-15T09:00:00.000Z';
const END = '2026-01-15T10:30:00.000Z';
const CREATED = '2026-01-10T08:00:00.000Z';

function makeEntry(id: number): TimeEntry {
  return {
    id,
    taskId: id * 10,
    userId: 'user-1',
    comment: `Entry ${id}`,
    start: START,
    end: END,
    createdAt: CREATED,
    updatedAt: CREATED,
  };
}

function fullPage(startId: number): TimeEntry[] {
  return Array.from({ length: 10 }, (_, i) => makeEntry(startId + i));
}

describe('TimeEntries', () => {
  let api: {
    getTimeEntries: ReturnType<typeof vi.fn>;
    deleteTimeEntry: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    api = {
      getTimeEntries: vi.fn().mockReturnValue(of([makeEntry(1), makeEntry(2)])),
      deleteTimeEntry: vi.fn().mockReturnValue(of({ success: true })),
    };
    await TestBed.configureTestingModule({
      imports: [TimeEntries],
      providers: [provideRouter([]), { provide: ApiService, useValue: api }],
    }).compileComponents();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function create(): Promise<ComponentFixture<TimeEntries>> {
    const fixture = TestBed.createComponent(TimeEntries);
    await fixture.whenStable();
    return fixture;
  }

  function text(fixture: ComponentFixture<TimeEntries>): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  }

  function cells(fixture: ComponentFixture<TimeEntries>, row: number): string[] {
    const rows = (fixture.nativeElement as HTMLElement).querySelectorAll('tbody tr');
    return Array.from(rows[row].querySelectorAll('td'), (td) => td.textContent?.trim() ?? '');
  }

  function button(fixture: ComponentFixture<TimeEntries>, label: string): HTMLButtonElement {
    const match = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent?.trim() === label);
    if (!match) throw new Error(`No button labeled "${label}"`);
    return match;
  }

  it('fetches the first page on init and renders the rows', async () => {
    const fixture = await create();
    expect(api.getTimeEntries).toHaveBeenCalledTimes(1);
    expect(api.getTimeEntries).toHaveBeenCalledWith({ limit: 10, offset: 0 });
    const [id, taskId, comment] = cells(fixture, 0);
    expect(id).toBe('1');
    expect(taskId).toBe('10');
    expect(comment).toBe('Entry 1');
    expect(text(fixture)).toContain('Page 1');
  });

  it('shows "Loading…" while the fetch is in flight', async () => {
    const entries$ = new Subject<TimeEntry[]>();
    api.getTimeEntries.mockReturnValue(entries$.asObservable());
    const fixture = await create();
    expect(text(fixture)).toContain('Loading…');

    entries$.next([makeEntry(1)]);
    entries$.complete();
    await fixture.whenStable();
    expect(text(fixture)).not.toContain('Loading…');
    expect(text(fixture)).toContain('Entry 1');
  });

  it('renders dates in a human-readable format, not raw ISO strings', async () => {
    const fixture = await create();
    const [, , , start, end, , createdAt] = cells(fixture, 0);
    expect(start).not.toBe(START);
    expect(start).toBe(formatDate(START, 'medium', 'en-US'));
    expect(end).toBe(formatDate(END, 'medium', 'en-US'));
    expect(createdAt).toBe(formatDate(CREATED, 'short', 'en-US'));
  });

  it('renders a Duration column between End and Created At', async () => {
    const fixture = await create();
    const headers = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('th'),
      (th) => th.textContent?.trim() ?? '',
    );
    expect(headers.slice(4, 7)).toEqual(['End', 'Duration', 'Created At']);
    const [, , , , , duration] = cells(fixture, 0);
    expect(duration).toBe('1h 30m'); // 09:00Z -> 10:30Z
  });

  it('fetches the next offset on Next when the page is full, and Prev returns', async () => {
    api.getTimeEntries
      .mockReturnValueOnce(of(fullPage(1)))
      .mockReturnValueOnce(of([makeEntry(11)]))
      .mockReturnValueOnce(of(fullPage(1)));
    const fixture = await create();

    button(fixture, 'Next').click();
    await fixture.whenStable();
    expect(api.getTimeEntries).toHaveBeenLastCalledWith({ limit: 10, offset: 10 });
    expect(text(fixture)).toContain('Page 2');
    expect(text(fixture)).toContain('Entry 11');

    button(fixture, 'Prev').click();
    await fixture.whenStable();
    expect(api.getTimeEntries).toHaveBeenLastCalledWith({ limit: 10, offset: 0 });
    expect(text(fixture)).toContain('Page 1');
  });

  it('disables Prev on the first page and Next on a short page', async () => {
    const fixture = await create(); // 2 entries: short page
    expect(button(fixture, 'Prev').disabled).toBe(true);
    expect(button(fixture, 'Next').disabled).toBe(true);
  });

  it('enables Next only when the current page is full', async () => {
    api.getTimeEntries.mockReturnValue(of(fullPage(1)));
    const fixture = await create();
    expect(button(fixture, 'Next').disabled).toBe(false);
    expect(button(fixture, 'Prev').disabled).toBe(true);
  });

  it('shows the empty state when there are no entries', async () => {
    api.getTimeEntries.mockReturnValue(of([]));
    const fixture = await create();
    expect(text(fixture)).toContain('No time entries yet');
    expect((fixture.nativeElement as HTMLElement).querySelector('table')).toBeNull();
  });

  it('keeps Prev reachable when a later page comes back empty (e.g. entries deleted)', async () => {
    api.getTimeEntries.mockReturnValueOnce(of(fullPage(1))).mockReturnValueOnce(of([]));
    const fixture = await create();

    button(fixture, 'Next').click();
    await fixture.whenStable();
    expect(text(fixture)).toContain('No time entries yet');
    const prev = button(fixture, 'Prev');
    expect(prev.disabled).toBe(false);

    prev.click();
    await fixture.whenStable();
    expect(api.getTimeEntries).toHaveBeenLastCalledWith({ limit: 10, offset: 0 });
    expect(text(fixture)).toContain('Entry 1');
  });

  it('stops loading on failure and the retry button refetches the current page', async () => {
    api.getTimeEntries
      .mockReturnValueOnce(throwError(() => new Error('upstream down')))
      .mockReturnValueOnce(of([makeEntry(1)]));
    const fixture = await create();
    expect(text(fixture)).not.toContain('Loading…');
    expect((fixture.nativeElement as HTMLElement).querySelector('table')).toBeNull();

    button(fixture, 'Retry').click();
    await fixture.whenStable();
    expect(api.getTimeEntries).toHaveBeenCalledTimes(2);
    expect(api.getTimeEntries).toHaveBeenLastCalledWith({ limit: 10, offset: 0 });
    expect(text(fixture)).toContain('Entry 1');
  });

  function entryForm(fixture: ComponentFixture<TimeEntries>): EntryForm | null {
    return fixture.debugElement.query(By.directive(EntryForm))?.componentInstance ?? null;
  }

  it('"New entry" opens an empty form; Cancel closes it without refetching', async () => {
    const fixture = await create();
    expect(entryForm(fixture)).toBeNull();

    button(fixture, 'New entry').click();
    await fixture.whenStable();
    const form = entryForm(fixture);
    expect(form).not.toBeNull();
    expect(form!.entry()).toBeNull();
    expect(form!.form.getRawValue()).toMatchObject({ taskId: null, comment: '' });

    button(fixture, 'Cancel').click();
    await fixture.whenStable();
    expect(entryForm(fixture)).toBeNull();
    expect(api.getTimeEntries).toHaveBeenCalledTimes(1);
  });

  it("a row's Edit button opens the form prefilled with that entry", async () => {
    const fixture = await create();
    button(fixture, 'Edit').click(); // first row: entry 1
    await fixture.whenStable();
    const form = entryForm(fixture);
    expect(form!.entry()?.id).toBe(1);
    expect(form!.form.getRawValue()).toEqual({
      taskId: 10,
      comment: 'Entry 1',
      start: isoToLocalInput(START),
      end: isoToLocalInput(END),
    });
  });

  it('switching from Edit to "New entry" without closing clears the stale edit target', async () => {
    const fixture = await create();
    button(fixture, 'Edit').click(); // first row: entry 1
    await fixture.whenStable();
    expect(entryForm(fixture)!.entry()?.id).toBe(1);

    button(fixture, 'New entry').click();
    await fixture.whenStable();
    const form = entryForm(fixture);
    expect(form!.entry()).toBeNull();
    expect(form!.form.getRawValue()).toMatchObject({ taskId: null, comment: '' });
  });

  it('on saved it reloads the list, closes the form, and shows a dismissible success message', async () => {
    const fixture = await create();
    button(fixture, 'New entry').click();
    await fixture.whenStable();

    entryForm(fixture)!.saved.emit(makeEntry(5));
    await fixture.whenStable();
    expect(entryForm(fixture)).toBeNull();
    expect(api.getTimeEntries).toHaveBeenCalledTimes(2);
    expect(text(fixture)).toContain('Entry #5 created');

    button(fixture, '×').click();
    await fixture.whenStable();
    expect(text(fixture)).not.toContain('Entry #5 created');
  });

  it('reports "updated" when the save came from an edit', async () => {
    const fixture = await create();
    button(fixture, 'Edit').click();
    await fixture.whenStable();

    entryForm(fixture)!.saved.emit(makeEntry(1));
    await fixture.whenStable();
    expect(text(fixture)).toContain('Entry #1 updated');
    expect(api.getTimeEntries).toHaveBeenCalledTimes(2);
  });

  it('reload() refetches the current page in place', async () => {
    api.getTimeEntries
      .mockReturnValueOnce(of(fullPage(1)))
      .mockReturnValueOnce(of(fullPage(11)))
      .mockReturnValueOnce(of(fullPage(21)));
    const fixture = await create();
    button(fixture, 'Next').click();
    await fixture.whenStable();

    fixture.componentInstance.reload();
    await fixture.whenStable();
    expect(api.getTimeEntries).toHaveBeenCalledTimes(3);
    expect(api.getTimeEntries).toHaveBeenLastCalledWith({ limit: 10, offset: 10 });
    expect(text(fixture)).toContain('Entry 21');
    expect(text(fixture)).toContain('Page 2');
  });

  it("a row's Delete button confirms, deletes, reloads, and reports success", async () => {
    const confirmSpy = vi.fn().mockReturnValue(true);
    vi.stubGlobal('confirm', confirmSpy);
    const fixture = await create();

    button(fixture, 'Delete').click(); // first row: entry 1
    await fixture.whenStable();
    expect(confirmSpy).toHaveBeenCalledExactlyOnceWith('Delete entry #1?');
    expect(api.deleteTimeEntry).toHaveBeenCalledExactlyOnceWith(1);
    expect(api.getTimeEntries).toHaveBeenCalledTimes(2); // initial load + reload
    expect(text(fixture)).toContain('Entry #1 deleted');
  });

  it('does not delete when the confirmation is declined', async () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(false));
    const fixture = await create();

    button(fixture, 'Delete').click();
    await fixture.whenStable();
    expect(api.deleteTimeEntry).not.toHaveBeenCalled();
    expect(api.getTimeEntries).toHaveBeenCalledTimes(1);
    expect(text(fixture)).not.toContain('deleted');
  });

  it('shows no success message and does not reload when the delete fails', async () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    api.deleteTimeEntry.mockReturnValue(throwError(() => new Error('upstream down')));
    const fixture = await create();

    button(fixture, 'Delete').click();
    await fixture.whenStable();
    expect(api.deleteTimeEntry).toHaveBeenCalledExactlyOnceWith(1);
    expect(api.getTimeEntries).toHaveBeenCalledTimes(1);
    expect(text(fixture)).not.toContain('deleted');
  });

  it('opens an unprefilled create form for an unparseable taskId query param and cleans the URL', async () => {
    const fixture = await create();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

    fixture.componentRef.setInput('taskId', 'abc');
    await fixture.whenStable();
    const form = entryForm(fixture);
    expect(form).not.toBeNull();
    expect(form!.entry()).toBeNull();
    expect(form!.form.getRawValue().taskId).toBeNull();
    expect(navigate).toHaveBeenCalledExactlyOnceWith(
      [],
      expect.objectContaining({
        queryParams: { taskId: null },
        queryParamsHandling: 'merge',
        replaceUrl: true,
      }),
    );
  });
});

describe('TimeEntries routed with a taskId query param', () => {
  it('opens a prefilled create form and removes the param from the URL', async () => {
    const api = {
      getTimeEntries: vi.fn().mockReturnValue(of([])),
      deleteTimeEntry: vi.fn(),
    };
    // The real appConfig (routes + withComponentInputBinding) wires the query
    // param to the component input; only the API is stubbed out.
    TestBed.configureTestingModule({
      providers: [...appConfig.providers, { provide: ApiService, useValue: api }],
    });

    const harness = await RouterTestingHarness.create();
    const page = await harness.navigateByUrl('/time-entries?taskId=42', TimeEntries);
    await harness.fixture.whenStable();

    expect(page.formOpen()).toBe(true);
    expect(page.editing()).toBeNull();
    const form = harness.fixture.debugElement.query(By.directive(EntryForm))
      .componentInstance as EntryForm;
    expect(form.form.getRawValue().taskId).toBe(42);
    // The param was consumed and replaced, so a refresh will not re-open the form.
    expect(TestBed.inject(Router).url).toBe('/time-entries');
  });
});
