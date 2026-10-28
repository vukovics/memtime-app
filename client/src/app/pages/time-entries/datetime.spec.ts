import { isoToLocalInput, localInputToIso } from './datetime';

// Expectations are computed with the same Date APIs the converters use, so the
// tests pass in any timezone. Winter and summer dates cover DST offset changes.
const ISO_WINTER = '2026-01-15T09:30:00.000Z';
const ISO_SUMMER = '2026-07-15T09:30:00.000Z';

function expectedLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

describe('datetime converters', () => {
  it('isoToLocalInput formats an ISO string as a local datetime-local value', () => {
    expect(isoToLocalInput(ISO_WINTER)).toBe(expectedLocal(ISO_WINTER));
    expect(isoToLocalInput(ISO_SUMMER)).toBe(expectedLocal(ISO_SUMMER));
    // Shape sanity: minute precision, no seconds or zone suffix.
    expect(isoToLocalInput(ISO_WINTER)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it('localInputToIso interprets the value as local time and returns UTC ISO', () => {
    const local = '2026-01-15T09:30';
    expect(localInputToIso(local)).toBe(new Date(local).toISOString());
    expect(localInputToIso(local)).toMatch(/Z$/);
  });

  it('round-trips ISO -> local -> ISO across DST boundaries', () => {
    expect(localInputToIso(isoToLocalInput(ISO_WINTER))).toBe(ISO_WINTER);
    expect(localInputToIso(isoToLocalInput(ISO_SUMMER))).toBe(ISO_SUMMER);
  });

  it('round-trips local -> ISO -> local', () => {
    for (const local of ['2026-01-15T23:59', '2026-07-01T00:00']) {
      expect(isoToLocalInput(localInputToIso(local))).toBe(local);
    }
  });
});
