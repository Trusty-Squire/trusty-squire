/** operate_drive marks a checkout total it could not read on the approval's
 * item; every human-facing surface that renders such an amount must say so
 * rather than show a 0.00 nobody read. */
const CHECKOUT_TOTAL_UNREADABLE = "total not readable";

export function approvalAmountLabel(
  amountCents: number,
  currency: string,
  item: string | undefined,
): string {
  return amountCents === 0 && item !== undefined && item.includes(CHECKOUT_TOTAL_UNREADABLE)
    ? CHECKOUT_TOTAL_UNREADABLE
    : formatCurrencyAmount(amountCents, currency);
}

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
