import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', redirectTo: 'browse', pathMatch: 'full' },
  { path: 'browse', loadComponent: () => import('./pages/browse/browse').then((m) => m.Browse) },
  {
    path: 'time-entries',
    loadComponent: () => import('./pages/time-entries/time-entries').then((m) => m.TimeEntries),
  },
  { path: '**', redirectTo: 'browse' },
];
