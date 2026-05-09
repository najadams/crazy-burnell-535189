// phone.ts — Ghana phone validator + normaliser. Ghana phones are
// 10 digits starting with 0 (local form), or +233 followed by 9 digits
// (international form). The DB stores international form via a CHECK
// constraint on every relevant table.

const GHANA_E164 = /^\+233\d{9}$/;

export function isValidGhanaPhone(input: string): boolean {
  return GHANA_E164.test(input);
}

/**
 * Best-effort normalise to +233-prefixed E.164. Returns null if the
 * input doesn't look like a Ghana number after stripping spaces and
 * dashes. The caller surfaces the failure to the user.
 */
export function normalizeGhanaPhone(input: string): string | null {
  const cleaned = input.replace(/[\s-()]/g, '');
  if (GHANA_E164.test(cleaned)) return cleaned;
  if (/^0\d{9}$/.test(cleaned)) return '+233' + cleaned.slice(1);
  if (/^233\d{9}$/.test(cleaned)) return '+' + cleaned;
  return null;
}

/** Format for display; minimal grouping for legibility. */
export function formatGhanaPhone(phone: string): string {
  if (!isValidGhanaPhone(phone)) return phone;
  // +233 XX XXX XXXX
  return `${phone.slice(0, 4)} ${phone.slice(4, 6)} ${phone.slice(6, 9)} ${phone.slice(9)}`;
}
