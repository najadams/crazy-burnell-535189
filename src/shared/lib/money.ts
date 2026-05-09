// money.ts — integer-pesewas arithmetic helpers.
//
// Counter never represents money as a float. The boundary where a
// human types cedis is parseCedisToPesewas; the boundary where a human
// reads cedis is formatMoney / formatMoneyWithCurrency. Any other place
// that converts between units is a bug.

const PESEWAS_PER_CEDI = 100;

/**
 * Parse a cedis-denominated string or number to integer pesewas.
 * Accepts: "5000", "5,000", "5000.00", "5,000.5", "GH₵ 5000", 5000, 5000.25.
 * Throws on invalid input — surface to the user as "Invalid amount."
 */
export function parseCedisToPesewas(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) {
      throw new Error('Amount must be a non-negative number.');
    }
    return Math.round(input * PESEWAS_PER_CEDI);
  }
  const cleaned = input
    .trim()
    .replace(/,/g, '')
    .replace(/^GH[Sx₵]?\s*/i, '')
    .replace(/^₵\s*/, '')
    .trim();
  if (!cleaned) throw new Error('Amount is empty.');
  const m = cleaned.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) throw new Error(`Invalid amount: "${input}".`);
  const cedis = parseInt(m[1]!, 10);
  const pesewas = m[2] ? parseInt(m[2]!.padEnd(2, '0').slice(0, 2), 10) : 0;
  return cedis * PESEWAS_PER_CEDI + pesewas;
}

/** Format pesewas as cedis (no currency symbol). 12345 → "123.45". */
export function formatMoney(pesewas: number): string {
  if (!Number.isFinite(pesewas)) return '—';
  const sign = pesewas < 0 ? '-' : '';
  const abs = Math.abs(pesewas);
  const cedis = Math.floor(abs / PESEWAS_PER_CEDI);
  const rem = abs % PESEWAS_PER_CEDI;
  return `${sign}${cedis.toLocaleString('en-GB')}.${rem.toString().padStart(2, '0')}`;
}

/** Like formatMoney but prefixed with the cedis symbol ₵. */
export function formatMoneyWithCurrency(pesewas: number): string {
  return `₵${formatMoney(pesewas)}`;
}
