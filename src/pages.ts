import type { CharityConfig } from './config.js';
import type { JustGivingApi, PageInfo, PageTotals } from './justgiving.js';

const TOTALS_TTL_MS = 2 * 60 * 1000;
const AMOUNTS_TTL_MS = 5 * 60 * 1000;

/**
 * The charity's JustGiving page: caches its numeric page ID (for SDI links) and charity
 * ID (for matching donations), plus short-lived totals and public amounts. Settings only
 * hold the page address.
 */
export class PageDirectory {
  private page: PageInfo | null = null;
  private totals: { at: number; value: PageTotals } | null = null;
  private amounts: { at: number; value: Map<string, number> } | null = null;
  private amountsRefresh: Promise<void> | null = null;

  constructor(
    private readonly justGiving: JustGivingApi,
    private readonly charity: CharityConfig,
  ) {}

  /** Returns null if there's no page yet or JustGiving can't be reached (errors are logged). */
  async getPage(): Promise<PageInfo | null> {
    try {
      return await this.getPageOrThrow();
    } catch (error) {
      console.error(`Could not look up JustGiving page for ${this.charity.name}:`, error instanceof Error ? error.message : error);
      return null;
    }
  }

  /** Like getPage but lets JustGiving errors propagate (used during verification). */
  async getPageOrThrow(): Promise<PageInfo | null> {
    if (!this.charity.pageShortName) return null;
    this.page ??= await this.justGiving.getPage(this.charity.pageShortName);
    return this.page;
  }

  /** Fundraising totals, cached for a couple of minutes. Null if unavailable (never blocks a page). */
  async getTotals(): Promise<PageTotals | null> {
    if (!this.charity.pageShortName) return null;
    const cached = this.totals;
    if (cached && Date.now() - cached.at < TOTALS_TTL_MS) return cached.value;
    try {
      const value = await this.justGiving.getPageTotals(this.charity.pageShortName);
      this.totals = { at: Date.now(), value };
      return value;
    } catch (error) {
      console.error(`Could not load totals for ${this.charity.name}:`, error instanceof Error ? error.message : error);
      return cached?.value ?? null;
    }
  }

  /**
   * Public donation amounts by donation ID, for the top donors list. Never stored in the
   * database: kept in memory and re-pulled from JustGiving every five minutes. While a
   * refresh is running, callers get the previous copy straight away.
   */
  async getPublicAmounts(): Promise<Map<string, number>> {
    const path = this.charity.pageShortName;
    if (!path) return new Map();
    const cached = this.amounts;
    const fresh = cached && Date.now() - cached.at < AMOUNTS_TTL_MS;
    if (!fresh && !this.amountsRefresh) {
      this.amountsRefresh = this.justGiving
        .getPublicDonationAmounts(path)
        .then((value) => {
          this.amounts = { at: Date.now(), value };
        })
        .catch((error: unknown) => {
          console.error(`Could not load donation amounts for ${this.charity.name}:`, error instanceof Error ? error.message : error);
          // Keep showing the old copy and try again in a minute rather than on every request.
          if (cached) this.amounts = { at: Date.now() - AMOUNTS_TTL_MS + 60_000, value: cached.value };
        })
        .finally(() => {
          this.amountsRefresh = null;
        });
    }
    if (cached) return cached.value;
    await this.amountsRefresh;
    return this.amounts?.value ?? new Map();
  }

  /** Looks the page up once at startup so problems show in the logs straight away. */
  async warmUp(): Promise<void> {
    if (!this.charity.pageShortName) {
      console.warn(`${this.charity.name}: no JustGiving page set yet (CHARITY_PAGE). /donate will say donations aren't open yet.`);
      return;
    }
    const info = await this.getPage();
    if (info) {
      console.log(`${this.charity.name}: JustGiving page "${this.charity.pageShortName}" (page ID ${info.pageId}, charity ${info.charityName ?? info.charityId}).`);
    }
  }
}
