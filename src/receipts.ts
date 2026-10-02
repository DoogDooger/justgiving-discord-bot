import type { CharityConfig } from './config.js';
import { JustGivingError, type JustGivingApi } from './justgiving.js';

/** How many donations are looked up at once while filling the index. */
const LOOKUPS_AT_ONCE = 4;
/** After a search that found nothing, don't re-read the page's list again for this long. */
const MIN_REFRESH_GAP_MS = 10_000;

/**
 * Finds a donation on our page from the reference on the donor's receipt.
 *
 * A JustGiving receipt shows "<reference>/1". That reference is not the donation ID, and
 * it's the only number a donor normally has. JustGiving only reveals it when a donation is
 * looked up on its own (about a second each), so this keeps an index of receipt reference
 * -> donation ID for every donation on our page: filled once in the background at startup,
 * then topped up with whatever is new each time someone claims. Kept in memory only.
 */
export class ReceiptDirectory {
  private readonly byRef = new Map<string, string>();
  /** Donation IDs already looked up, so each one costs a single request for the life of the process. */
  private readonly seen = new Set<string>();
  private refreshing: Promise<void> | null = null;
  private refreshedAt = 0;

  constructor(
    private readonly justGiving: Pick<JustGivingApi, 'getPageDonationIds' | 'getDonation'>,
    private readonly charity: CharityConfig,
  ) {}

  /**
   * The ID of the donation on our page with this receipt reference, or null if there isn't one
   * (the donor gave to a different page, mistyped it, or JustGiving hasn't listed it yet).
   * Throws JustGivingError if the page's donation list can't be read.
   */
  async find(receiptRef: string): Promise<string | null> {
    const known = this.byRef.get(receiptRef);
    if (known) return known;
    if (this.refreshing || Date.now() - this.refreshedAt >= MIN_REFRESH_GAP_MS) await this.refresh();
    return this.byRef.get(receiptRef) ?? null;
  }

  /** Looks up every donation on the page that isn't in the index yet. One run at a time; callers share it. */
  refresh(): Promise<void> {
    this.refreshing ??= this.fill().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** Fills the index at startup so the first claim doesn't have to wait for it. */
  async warmUp(): Promise<void> {
    try {
      await this.refresh();
      console.log(`${this.charity.name}: ${this.seen.size} donation${this.seen.size === 1 ? '' : 's'} on the page indexed by receipt reference.`);
    } catch (error) {
      console.error('Could not index receipt references:', error instanceof Error ? error.message : error);
    }
  }

  private async fill(): Promise<void> {
    const pagePath = this.charity.pageShortName;
    if (!pagePath) return;
    const todo = (await this.justGiving.getPageDonationIds(pagePath)).filter((id) => !this.seen.has(id));
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const id = todo[next++]!;
        try {
          const donation = await this.justGiving.getDonation(id);
          if (donation?.receiptRef) this.byRef.set(donation.receiptRef, id);
          this.seen.add(id);
        } catch (error) {
          // Left out of `seen`, so the next refresh tries this one again.
          if (!(error instanceof JustGivingError)) throw error;
        }
      }
    };
    await Promise.all(Array.from({ length: LOOKUPS_AT_ONCE }, worker));
    this.refreshedAt = Date.now();
  }
}
