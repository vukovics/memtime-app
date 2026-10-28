import { DatePipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { ApiService } from '../../api.service';
import { TimeEntry } from '../../api.types';

const PAGE_SIZE = 10;

@Component({
  selector: 'app-time-entries',
  imports: [DatePipe],
  templateUrl: './time-entries.html',
  styleUrl: './time-entries.css',
})
export class TimeEntries {
  private readonly api = inject(ApiService);

  readonly entries = signal<TimeEntry[]>([]);
  readonly loading = signal(false);
  readonly failed = signal(false);
  readonly offset = signal(0);

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

  nextPage(): void {
    this.offset.update((offset) => offset + PAGE_SIZE);
    this.reload();
  }

  prevPage(): void {
    this.offset.update((offset) => Math.max(0, offset - PAGE_SIZE));
    this.reload();
  }
}
