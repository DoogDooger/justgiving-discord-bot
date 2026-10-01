/** "£1,234" or "£12.50": whole amounts without decimals, otherwise two. */
export function money(amount: number, symbol: string, locale: string): string {
  return `${symbol}${amount.toLocaleString(locale, { minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 2 })}`;
}
