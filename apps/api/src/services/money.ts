/** Formats stored minor units without assuming every currency has cents. */
export function formatCurrencyAmount(amountCents: number, currency: string): string {
  try {
    const minorDigits = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).resolvedOptions().maximumFractionDigits;
    if (minorDigits === undefined) return `${currency} ${amountCents} minor units`;
    return `${currency} ${(amountCents / 10 ** minorDigits).toFixed(minorDigits)}`;
  } catch {
    return `${currency} ${amountCents} minor units`;
  }
}
