import { Injectable, signal } from '@angular/core';

/** Holds the current app-wide error message, shown in the shell's banner. */
@Injectable({ providedIn: 'root' })
export class ErrorService {
  private readonly _message = signal<string | null>(null);

  readonly message = this._message.asReadonly();

  show(message: string): void {
    this._message.set(message);
  }

  dismiss(): void {
    this._message.set(null);
  }
}
