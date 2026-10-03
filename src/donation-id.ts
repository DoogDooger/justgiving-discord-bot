/** Parse and canonicalise a provider donation ID, including legacy leading-zero aliases. */
export function donationId(input: string): string | null {
  return /^\d{1,15}$/.test(input) ? BigInt(input).toString() : null;
}
