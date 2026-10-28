import { DatePipe } from '@angular/common';
import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiService } from '../../api.service';
import { TimeEntry } from '../../api.types';
import { formatDuration } from './datetime';
import { EntryForm } from './entry-form';

const PAGE_SIZE = 10;

@Component({
  selector: 'app-time-entries',
  imports: [DatePipe, EntryForm],
  templateUrl: './time-entries.html',
  styleUrl: './time-entries.css',
})
export class TimeEntries {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  /** Bound from the `taskId` query param ("Log time" in the browse tree). */
  readonly taskId = input<string>();

  readonly entries = signal<TimeEntry[]>([]);
  readonly loading = signal(false);
  readonly failed = signal(false);
  readonly offset = signal(0);

  readonly formOpen = signal(false);
  readonly editing = signal<TimeEntry | null>(null);
  /** Task ID prefill for the create form, carried over from the query param. */
  readonly prefillTaskId = signal<number | null>(null);
  readonly successMessage = signal<string | null>(null);

  readonly page = computed(() => this.offset() / PAGE_SIZE + 1);
  // Upstream returns no total count, so a full page is assumed to mean more data exists.
  readonly hasNext = computed(() => this.entries().length === PAGE_SIZE);

  protected readonly formatDuration = formatDuration;

  constructor() {
    this.reload();
    // A taskId query param opens the create form prefilled; the param is then
    // removed from the URL so a refresh does not re-open the form.
    effect(() => {
      const raw = this.taskId();
      if (raw === undefined) return;
      const id = Number(raw);
      this.openNew();
      this.prefillTaskId.set(Number.isInteger(id) && id > 0 ? id : null);
      void this.router.navigate([], {
        relativeTo: this.route,
        queryParams: { taskId: null },
        queryParamsHandling: 'merge',
        replaceUrl: true,
      });
    });
  }

  /** Refetches the current page. Called after mutations (MT-11/12) and by Retry. */
  reload(): void {
    this.loading.set(true);
    this.failed.set(false);
    this.api.getTimeEntries({ limit: PAGE_SIZE, offset: this.offset() }).subscribe({
      next: (entries) => {
        this.entries.set(entries);
        this.loading.set(false);
      },
      // The interceptor already showed the error banner; just stop loading and offer a retry.
      error: () => {
        this.loading.set(false);
        this.failed.set(true);
      },
    });
  }

  openNew(): void {
    this.successMessage.set(null);
    this.editing.set(null);
    this.prefillTaskId.set(null);
    this.formOpen.set(true);
  }

  openEdit(entry: TimeEntry): void {
    this.successMessage.set(null);
    this.editing.set(entry);
    this.formOpen.set(true);
  }

  onSaved(entry: TimeEntry): void {
    this.successMessage.set(`Entry #${entry.id} ${this.editing() ? 'updated' : 'created'}`);
    this.closeForm();
    this.reload();
  }

  onCancelled(): void {
    this.closeForm();
  }

  dismissSuccess(): void {
    this.successMessage.set(null);
  }

  deleteEntry(entry: TimeEntry): void {
    if (!this.confirmDelete(`Delete entry #${entry.id}?`)) return;
    this.successMessage.set(null);
    this.api.deleteTimeEntry(entry.id).subscribe({
      next: () => {
        this.successMessage.set(`Entry #${entry.id} deleted`);
        this.reload();
      },
      // The interceptor already showed the global error banner; nothing to do here.
      error: () => undefined,
    });
  }

  /** Thin wrapper over the native dialog so tests can override the answer. */
  protected confirmDelete(message: string): boolean {
    return confirm(message);
  }

  private closeForm(): void {
    this.formOpen.set(false);
    this.editing.set(null);
    this.prefillTaskId.set(null);
  }

  nextPage(): void {
    this.offset.update((offset) => offset + PAGE_SIZE);
    this.reload();
  }

  prevPage(): void {
    this.offset.update((offset) => Math.max(0, offset - PAGE_SIZE));
    this.reload();
  }
}
