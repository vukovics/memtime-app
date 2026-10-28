// Converters between <input type="datetime-local"> values ("YYYY-MM-DDTHH:mm",
// in the user's local timezone) and the ISO 8601 UTC strings the API uses.

/** Converts a datetime-local input value to an ISO 8601 UTC string. */
export function localInputToIso(value: string): string {
  return new Date(value).toISOString();
}

/** Converts an ISO 8601 string to a datetime-local input value (minute precision). */
export function isoToLocalInput(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * Formats the interval between two ISO timestamps as "2h 15m", "2h" or "45m"
 * (whole minutes; zero or negative intervals render as "0m").
 */
export function formatDuration(startIso: string, endIso: string): string {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
