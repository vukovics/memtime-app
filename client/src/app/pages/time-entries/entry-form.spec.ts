import { HttpErrorResponse } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Subject, of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { ApiService } from '../../api.service';
import { TimeEntry } from '../../api.types';
import { isoToLocalInput, localInputToIso } from './datetime';
import { EntryForm } from './entry-form';

const ENTRY: TimeEntry = {
  id: 7,
  taskId: 42,
  userId: 'user-1',
  comment: 'Existing work',
  start: '2026-01-15T09:00:00.000Z',
  end: '2026-01-15T10:30:00.000Z',
  createdAt: '2026-01-10T08:00:00.000Z',
  updatedAt: '2026-01-10T08:00:00.000Z',
};

const START_LOCAL = '2026-01-15T09:00';
const END_LOCAL = '2026-01-15T10:30';

describe('EntryForm', () => {
  let api: {
    createTimeEntry: ReturnType<typeof vi.fn>;
    updateTimeEntry: ReturnType<typeof vi.fn>;
  };
  let fixture: ComponentFixture<EntryForm>;
  let saved: ReturnType<typeof vi.fn<(entry: TimeEntry) => void>>;
  let cancelled: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(async () => {
    api = {
      createTimeEntry: vi.fn().mockReturnValue(of({ ...ENTRY, id: 99 })),
      updateTimeEntry: vi.fn().mockReturnValue(of(ENTRY)),
    };
    await TestBed.configureTestingModule({
      imports: [EntryForm],
      providers: [{ provide: ApiService, useValue: api }],
    }).compileComponents();
    fixture = TestBed.createComponent(EntryForm);
    saved = vi.fn<(entry: TimeEntry) => void>();
    cancelled = vi.fn<() => void>();
    fixture.componentInstance.saved.subscribe(saved);
    fixture.componentInstance.cancelled.subscribe(cancelled);
    await fixture.whenStable();
  });

  function root(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function field(name: string): HTMLInputElement {
    const el = root().querySelector<HTMLInputElement>(`input[formControlName="${name}"]`);
    if (!el) throw new Error(`No input for "${name}"`);
    return el;
  }

  function setField(name: string, value: string): void {
    const el = field(name);
    el.value = value;
    el.dispatchEvent(new Event('input'));
  }

  async function fillValid(): Promise<void> {
    setField('taskId', '42');
    setField('comment', 'Did work');
    setField('start', START_LOCAL);
    setField('end', END_LOCAL);
    await fixture.whenStable();
  }

  async function submit(): Promise<void> {
    root().querySelector('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
  }

  function saveButton(): HTMLButtonElement {
    return root().querySelector<HTMLButtonElement>('button[type="submit"]')!;
  }

  it('shows required errors on submitting the emptied form and does not call the API', async () => {
    expect(root().textContent).not.toContain('required');
    setField('start', ''); // create mode defaults start/end, so clear them first
    setField('end', '');
    await submit();
    const text = root().textContent ?? '';
    expect(text).toContain('Task ID is required.');
    expect(text).toContain('Comment is required.');
    expect(text).toContain('Start is required.');
    expect(text).toContain('End is required.');
    expect(api.createTimeEntry).not.toHaveBeenCalled();
    expect(saved).not.toHaveBeenCalled();
  });

  it('defaults a new entry to the last hour, ending about now (minute precision)', () => {
    const value = fixture.componentInstance.form.getRawValue();
    expect(value.taskId).toBeNull();
    expect(value.comment).toBe('');
    // Minute truncation can lose up to 59s; compare with a one-minute tolerance.
    expect(Math.abs(new Date(value.end).getTime() - Date.now())).toBeLessThanOrEqual(60_000);
    expect(new Date(value.end).getTime() - new Date(value.start).getTime()).toBe(3_600_000);
    expect(value.start).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(value.end).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it('prefills Task ID from initialTaskId in create mode', async () => {
    fixture.componentRef.setInput('initialTaskId', 42);
    await fixture.whenStable();
    expect(field('taskId').value).toBe('42');
    expect(root().textContent).toContain('New entry');
  });

  it('shows a single group error when end is not after start', async () => {
    // Programmatically set (pristine, untouched) values keep the error hidden.
    fixture.componentInstance.form.setValue({
      taskId: 42,
      comment: 'Did work',
      start: END_LOCAL,
      end: START_LOCAL,
    });
    await fixture.whenStable();
    expect(root().textContent).not.toContain('End must be after start.');

    // Still hidden when only one of the two fields was interacted with.
    fixture.componentInstance.form.controls.start.markAsTouched();
    await fixture.whenStable();
    expect(root().textContent).not.toContain('End must be after start.');

    await fillValid();
    setField('end', START_LOCAL); // equal to start: strictly-after fails
    await fixture.whenStable();
    // Dirty fields reveal the error even before a submit attempt.
    expect(root().textContent).toContain('End must be after start.');

    await submit();
    const matches = (root().textContent ?? '').match(/End must be after start\./g) ?? [];
    expect(matches).toHaveLength(1);
    expect(api.createTimeEntry).not.toHaveBeenCalled();
  });

  it('rejects a non-positive or non-integer Task ID', async () => {
    await fillValid();
    setField('taskId', '0');
    await submit();
    expect(root().textContent).toContain('Task ID must be a positive integer.');
    setField('taskId', '1.5');
    await fixture.whenStable();
    expect(root().textContent).toContain('Task ID must be a positive integer.');
    expect(api.createTimeEntry).not.toHaveBeenCalled();
  });

  it('rejects a whitespace-only comment', async () => {
    await fillValid();
    setField('comment', '   ');
    await submit();
    expect(root().textContent).toContain('Comment is required.');
    expect(api.createTimeEntry).not.toHaveBeenCalled();
  });

  it('creates the entry with an exact ISO payload and emits saved', async () => {
    await fillValid();
    await submit();
    expect(api.createTimeEntry).toHaveBeenCalledExactlyOnceWith({
      taskId: 42,
      comment: 'Did work',
      start: localInputToIso(START_LOCAL),
      end: localInputToIso(END_LOCAL),
    });
    expect(saved).toHaveBeenCalledExactlyOnceWith({ ...ENTRY, id: 99 });
  });

  it('prefills the fields from the entry in edit mode and calls update', async () => {
    fixture.componentRef.setInput('entry', ENTRY);
    await fixture.whenStable();
    expect(root().textContent).toContain('Edit entry #7');
    expect(field('taskId').value).toBe('42');
    expect(field('comment').value).toBe('Existing work');
    expect(field('start').value).toBe(isoToLocalInput(ENTRY.start));
    expect(field('end').value).toBe(isoToLocalInput(ENTRY.end));

    setField('comment', 'Updated work');
    await submit();
    expect(api.updateTimeEntry).toHaveBeenCalledExactlyOnceWith(7, {
      taskId: 42,
      comment: 'Updated work',
      start: ENTRY.start,
      end: ENTRY.end,
    });
    expect(api.createTimeEntry).not.toHaveBeenCalled();
    expect(saved).toHaveBeenCalledExactlyOnceWith(ENTRY);
  });

  it('shows the server message near the form on API error and preserves the typed values', async () => {
    api.createTimeEntry
      .mockReturnValueOnce(
        throwError(
          () => new HttpErrorResponse({ status: 400, error: { error: 'end must be after start' } }),
        ),
      )
      .mockReturnValueOnce(throwError(() => new Error('boom')));
    await fillValid();
    await submit();
    expect(root().querySelector('.api-error')?.textContent).toContain('end must be after start');
    expect(field('comment').value).toBe('Did work');
    expect(field('start').value).toBe(START_LOCAL);
    expect(saveButton().disabled).toBe(false); // in-flight flag cleared
    expect(saved).not.toHaveBeenCalled();

    // Errors without a server-provided message fall back to a generic one.
    await submit();
    expect(root().querySelector('.api-error')?.textContent).toContain(
      'Request failed. Please try again.',
    );
  });

  it('disables submit only while the request is in flight', async () => {
    const response$ = new Subject<TimeEntry>();
    api.createTimeEntry.mockReturnValue(response$.asObservable());
    expect(saveButton().disabled).toBe(false); // invalid form still allows the click
    await fillValid();
    await submit();
    expect(saveButton().disabled).toBe(true);
    expect(saveButton().textContent).toContain('Saving…');

    response$.next(ENTRY);
    response$.complete();
    await fixture.whenStable();
    expect(saved).toHaveBeenCalledExactlyOnceWith(ENTRY);
  });

  it('emits cancelled on Cancel without calling the API', async () => {
    await fillValid();
    root().querySelector<HTMLButtonElement>('button.cancel')!.click();
    await fixture.whenStable();
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(api.createTimeEntry).not.toHaveBeenCalled();
    expect(api.updateTimeEntry).not.toHaveBeenCalled();
  });
});
