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
