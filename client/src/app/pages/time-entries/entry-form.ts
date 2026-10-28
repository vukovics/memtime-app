import { HttpErrorResponse } from '@angular/common/http';
import { Component, effect, inject, input, output, signal } from '@angular/core';
import {
  AbstractControl,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  ValidationErrors,
  Validators,
} from '@angular/forms';
import { ApiService } from '../../api.service';
import { TimeEntry, TimeEntryInput } from '../../api.types';
import { isoToLocalInput, localInputToIso } from './datetime';

type Field = 'taskId' | 'comment' | 'start' | 'end';

/** Create/edit form for a time entry. Pass `entry` to edit; omit it to create. */
@Component({
  selector: 'app-entry-form',
  imports: [ReactiveFormsModule],
  templateUrl: './entry-form.html',
  styleUrl: './entry-form.css',
})
export class EntryForm {
  private readonly api = inject(ApiService);

  /** Entry being edited, or null for a new one. */
  readonly entry = input<TimeEntry | null>(null);
  /** Task ID to prefill when creating (e.g. "Log time" from the browse tree). */
  readonly initialTaskId = input<number | null>(null);
  readonly saved = output<TimeEntry>();
  readonly cancelled = output<void>();

  readonly saving = signal(false);
  /** Server message shown near the form (the global banner shows it too). */
  readonly apiError = signal<string | null>(null);

  readonly form = new FormGroup(
    {
      taskId: new FormControl<number | null>(null, [
        Validators.required,
        Validators.min(1),
        integer,
      ]),
      comment: new FormControl('', { nonNullable: true, validators: [nonBlank] }),
      start: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
      end: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    },
    { validators: endAfterStart },
  );

  constructor() {
    // Prefill on edit; clear when the page switches back to "New entry".
    effect(() => {
      const entry = this.entry();
      if (entry) {
        this.form.setValue({
          taskId: entry.taskId,
          comment: entry.comment,
          start: isoToLocalInput(entry.start),
          end: isoToLocalInput(entry.end),
        });
      } else {
        // New entries default to a plausible recent interval: the last hour.
        const end = new Date();
        const start = new Date(end.getTime() - 60 * 60 * 1000);
        this.form.reset({
          taskId: this.initialTaskId(),
          comment: '',
          start: isoToLocalInput(start.toISOString()),
          end: isoToLocalInput(end.toISOString()),
        });
      }
      this.apiError.set(null);
    });
  }

  /** Field errors appear once the control was touched or edited (submit touches all). */
  showError(field: Field): boolean {
    const control = this.form.controls[field];
    return control.invalid && (control.touched || control.dirty);
  }

  showEndNotAfterStart(): boolean {
    const { start, end } = this.form.controls;
    return (
      this.form.hasError('endNotAfterStart') &&
      (start.touched || start.dirty) &&
      (end.touched || end.dirty)
    );
  }

  submit(): void {
    this.apiError.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const value = this.form.getRawValue();
    const body: TimeEntryInput = {
      taskId: value.taskId as number,
      comment: value.comment.trim(),
      start: localInputToIso(value.start),
      end: localInputToIso(value.end),
    };
    const entry = this.entry();
    const request$ = entry
      ? this.api.updateTimeEntry(entry.id, body)
      : this.api.createTimeEntry(body);
    this.saving.set(true);
    request$.subscribe({
      next: (saved) => {
        this.saving.set(false);
        this.saved.emit(saved);
      },
      // The interceptor already showed the banner; keep the typed values and
      // surface the server message next to the form as well.
      error: (error: unknown) => {
        this.saving.set(false);
        this.apiError.set(serverMessage(error));
      },
    });
  }
}

function integer(control: AbstractControl): ValidationErrors | null {
  return control.value === null || Number.isInteger(control.value) ? null : { integer: true };
}

/** Like Validators.required, but whitespace-only values also fail (server trims). */
function nonBlank(control: AbstractControl): ValidationErrors | null {
  return typeof control.value === 'string' && control.value.trim().length > 0
    ? null
    : { required: true };
}

function endAfterStart(group: AbstractControl): ValidationErrors | null {
  const { start, end } = group.value as { start: string; end: string };
  if (!start || !end) {
    return null;
  }
  return new Date(end) > new Date(start) ? null : { endNotAfterStart: true };
}

function serverMessage(error: unknown): string {
  const body = error instanceof HttpErrorResponse ? (error.error as { error?: unknown }) : null;
  return typeof body?.error === 'string' && body.error.length > 0
    ? body.error
    : 'Request failed. Please try again.';
}
