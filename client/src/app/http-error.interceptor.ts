import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { ErrorService } from './error.service';

/** Reports failed HTTP requests to the ErrorService as a user-readable message. */
export const httpErrorInterceptor: HttpInterceptorFn = (req, next) => {
  const errorService = inject(ErrorService);

  return next(req).pipe(
    catchError((error: unknown) => {
      errorService.show(toMessage(error));
      return throwError(() => error);
    }),
  );
};

function toMessage(error: unknown): string {
  if (error instanceof HttpErrorResponse) {
    // The server responds with { error: string } on failures.
    const serverError = (error.error as { error?: unknown } | null)?.error;
    if (typeof serverError === 'string' && serverError.length > 0) {
      return serverError;
    }
    if (error.status === 0) {
      return 'Could not reach the server. Please check your connection.';
    }
    return `Request failed (${error.status} ${error.statusText}).`;
  }
  return 'An unexpected error occurred.';
}
