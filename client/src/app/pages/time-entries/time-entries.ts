import { DatePipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { ApiService } from '../../api.service';
import { TimeEntry } from '../../api.types';
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

  readonly entries = signal<TimeEntry[]>([]);
  readonly loading = signal(false);
  readonly failed = signal(false);
  readonly offset = signal(0);

  readonly formOpen = signal(false);
  readonly editing = signal<TimeEntry | null>(null);
  readonly successMessage = signal<string | null>(null);

  readonly page = computed(() => this.offset() / PAGE_SIZE + 1);
  // Upstream returns no total count, so a full page is assumed to mean more data exists.
  readonly hasNext = computed(() => this.entries().length === PAGE_SIZE);

  constructor() {
    this.reload();
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

  private closeForm(): void {
    this.formOpen.set(false);
    this.editing.set(null);
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
