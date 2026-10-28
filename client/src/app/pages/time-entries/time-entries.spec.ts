import { formatDate } from '@angular/common';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Subject, of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { ApiService } from '../../api.service';
import { TimeEntry } from '../../api.types';
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
  let api: { getTimeEntries: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    api = { getTimeEntries: vi.fn().mockReturnValue(of([makeEntry(1), makeEntry(2)])) };
    await TestBed.configureTestingModule({
      imports: [TimeEntries],
      providers: [{ provide: ApiService, useValue: api }],
    }).compileComponents();
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
    const [, , , start, end, createdAt] = cells(fixture, 0);
    expect(start).not.toBe(START);
    expect(start).toBe(formatDate(START, 'medium', 'en-US'));
    expect(end).toBe(formatDate(END, 'medium', 'en-US'));
    expect(createdAt).toBe(formatDate(CREATED, 'short', 'en-US'));
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
    api.getTimeEntries
      .mockReturnValueOnce(of(fullPage(1)))
      .mockReturnValueOnce(of([]));
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
});
