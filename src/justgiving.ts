/**
 * JustGiving integration: Simple Donation Integration (SDI) links and a small
 * read-only API client.
 *
 * API endpoints used (confirmed against https://api.justgiving.com/docs and live
 * responses, 2026-09-30). None need the page owner's login for the fields we use.
 *
 *   GET /{appId}/v1/donation/{donationId}
 *       -> { id, status, thirdPartyReference, charityId, ... }. Status is one of
 *          Accepted | Pending | Rejected | Cancelled | Refunded.
 *          charityId isn't in the docs' example but is returned live; it is
 *          available immediately, unlike the two list endpoints below.
 *   GET /{appId}/v1/donation/ref/{reference}
 *       -> { donations: [{ id, status, thirdPartyReference, charityId, ... }] }
 *          Primary way to find the charity a donation went to.
 *   GET /{appId}/v1/fundraising/pages/{pagePath}
 *       -> { pageId, charity: { id, name }, grandTotalRaisedExcludingGiftAid,
 *            fundraisingTarget, currencySymbol, ... }
 *          pagePath is "page/<name>" for newer ("ONE_PAGE") pages and just
 *          "<name>" for older fundraising pages.
 *   GET /{appId}/v1/fundraising/pages/{pagePath}/donations?pageSize=&pageCursor=
 *       -> { donations: [{ id, amount, ... }], pagination: { nextPageCursor } } newest first.
 *          Fallback check that a donation is on our page, and the source of the public
 *          amounts for the top donors list (amount is null when the donor hid it).
 */

export const DONATION_ID_PLACEHOLDER = 'JUSTGIVING-DONATION-ID';
const SDI_BASE = 'https://link.justgiving.com/v1/fundraisingpage/donate/pageid';
const REQUEST_TIMEOUT_MS = 10_000;
const RETRIES = 2;
const DONATION_PAGE_SIZE = 100;
/** Safety cap when reading a page's whole donation list (100 x 100 = 10,000 donations). */
const MAX_DONATION_PAGES = 100;

export type DonationStatus = 'Accepted' | 'Pending' | 'Rejected' | 'Cancelled' | 'Refunded' | (string & {});

export interface Donation {
  id: string;
  status: DonationStatus;
  thirdPartyReference: string | null;
  /** UTC epoch milliseconds from JustGiving's donationDate, or null when unavailable. */
  donatedAtMs: number | null;
  /** Charity the donation went to, when JustGiving includes it (it does for live donations). */
  charityId: string | null;
}

export interface PageInfo {
  /** Numeric page ID, needed for SDI links. */
  pageId: string;
  /** JustGiving charity ID the page raises money for. */
  charityId: string;
  charityName: string | null;
}

export interface PageTotals {
  /** Total raised excluding Gift Aid, in the page's currency. */
  raised: number;
  target: number | null;
  currencySymbol: string;
}

export interface JustGivingApi {
  /** Returns null if JustGiving has no donation with this ID. */
  getDonation(donationId: string): Promise<Donation | null>;
  /** Charity ID of a donation, looked up through its reference. Null if not found or not included. */
  getDonationCharityId(reference: string, donationId: string): Promise<string | null>;
  /** True if the donation is in the page's (most recent) donations. */
  pageHasDonation(pagePath: string, donationId: string): Promise<boolean>;
  getPage(pagePath: string): Promise<PageInfo>;
  /** Live fundraising totals for a page (the same page-details response, not cached). */
  getPageTotals(pagePath: string): Promise<PageTotals>;
  /**
   * Publicly visible donation amounts on a page, by donation ID, in the page's currency.
   * Donations whose donor hid the amount on JustGiving are left out.
   */
  getPublicDonationAmounts(pagePath: string): Promise<Map<string, number>>;
}

/** Network failure, timeout or unexpected response from JustGiving. */
export class JustGivingError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'JustGivingError';
  }
}

export function buildExitUrl(publicBaseUrl: string, token: string): string {
  // The placeholder must survive untouched: JustGiving swaps it for the real donation ID.
  return `${publicBaseUrl}/justgiving/return?t=${encodeURIComponent(token)}&donationId=${DONATION_ID_PLACEHOLDER}`;
}

export function buildDonateLink(pageId: string, reference: string, exitUrl: string): string {
  return `${SDI_BASE}/${encodeURIComponent(pageId)}?reference=${encodeURIComponent(reference)}&exitUrl=${encodeURIComponent(exitUrl)}`;
}

/** Encodes each segment of "page/<name>" but keeps the slash. */
const encodePagePath = (pagePath: string) => pagePath.split('/').map(encodeURIComponent).join('/');

type FetchLike = typeof fetch;

export function createJustGivingClient(options: { appId: string; apiBase: string; fetch?: FetchLike; retryDelayMs?: number }): JustGivingApi {
  const doFetch = options.fetch ?? fetch;
  const retryDelayMs = options.retryDelayMs ?? 500;
  const base = `${options.apiBase}/${encodeURIComponent(options.appId)}/v1`;

  async function getJson(path: string): Promise<unknown | null> {
    // JustGiving can push back (429) or hiccup (5xx) when many donors return at once:
    // retry a couple of times with a short pause before giving up.
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await doFetch(`${base}${path}`, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'network error';
        throw new JustGivingError(`JustGiving request ${reason}`);
      }
      const retryable = response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504;
      if (!retryable || attempt >= RETRIES) break;
      const retryAfter = Number(response.headers.get('retry-after'));
      const pause = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 3000) : retryDelayMs * (attempt + 1);
      await new Promise((resolve) => setTimeout(resolve, pause));
    }
    if (response.status === 404) return null;
    if (!response.ok) throw new JustGivingError(`JustGiving returned HTTP ${response.status}`, response.status);
    try {
      return await response.json();
    } catch {
      throw new JustGivingError('JustGiving returned invalid JSON');
    }
  }

  const str = (value: unknown): string | null =>
    typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : null;

  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

  const epochMs = (value: unknown): number | null => {
    const m = typeof value === 'string' ? /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(value) : null;
    const n = m ? Number(m[1]) : NaN;
    return Number.isFinite(n) ? n : null;
  };

  const toDonation = (raw: unknown): Donation | null => {
    const r = record(raw);
    const id = str(r.id);
    const status = str(r.status);
    if (!id || !status) return null;
    const reference = str(r.thirdPartyReference)?.trim();
    return { id, status, thirdPartyReference: reference ? reference : null, charityId: str(r.charityId), donatedAtMs: epochMs(r.donationDate) };
  };

  const donationList = (raw: unknown): unknown[] => {
    const donations = record(raw).donations;
    return Array.isArray(donations) ? donations : [];
  };

  return {
    async getDonation(donationId) {
      const raw = await getJson(`/donation/${encodeURIComponent(donationId)}`);
      if (raw === null) return null;
      const donation = toDonation(raw);
      if (!donation) throw new JustGivingError('JustGiving donation response was missing id or status');
      return donation;
    },

    async getDonationCharityId(reference, donationId) {
      const raw = await getJson(`/donation/ref/${encodeURIComponent(reference)}`);
      const match = donationList(raw).find((d) => str(record(d).id) === donationId);
      return match ? str(record(match).charityId) : null;
    },

    async pageHasDonation(pagePath, donationId) {
      const raw = await getJson(`/fundraising/pages/${encodePagePath(pagePath)}/donations`);
      return donationList(raw).some((d) => str(record(d).id) === donationId);
    },

    async getPage(pagePath) {
      const raw = await getJson(`/fundraising/pages/${encodePagePath(pagePath)}`);
      if (raw === null) throw new JustGivingError(`JustGiving page "${pagePath}" was not found`, 404);
      const page = record(raw);
      const charity = record(page.charity);
      const pageId = str(page.pageId);
      const charityId = str(charity.id);
      if (!pageId || !charityId) throw new JustGivingError(`JustGiving page "${pagePath}" response had no pageId or charity`);
      return { pageId, charityId, charityName: str(charity.name) };
    },

    async getPublicDonationAmounts(pagePath) {
      const amounts = new Map<string, number>();
      let cursor: string | null = null;
      for (let page = 0; page < MAX_DONATION_PAGES; page++) {
        const query = `?pageSize=${DONATION_PAGE_SIZE}${cursor ? `&pageCursor=${encodeURIComponent(cursor)}` : ''}`;
        const raw = await getJson(`/fundraising/pages/${encodePagePath(pagePath)}/donations${query}`);
        for (const item of donationList(raw)) {
          const donation = record(item);
          const id = str(donation.id);
          // amount is null when the donor chose to hide it.
          const amount = donation.amount === null || donation.amount === undefined ? NaN : Number(donation.amount);
          if (id && Number.isFinite(amount) && amount > 0) amounts.set(id, amount);
        }
        cursor = str(record(record(raw).pagination).nextPageCursor);
        if (!cursor) break;
      }
      return amounts;
    },

    async getPageTotals(pagePath) {
      const raw = await getJson(`/fundraising/pages/${encodePagePath(pagePath)}`);
      if (raw === null) throw new JustGivingError(`JustGiving page "${pagePath}" was not found`, 404);
      const page = record(raw);
      const num = (value: unknown) => {
        const n = Number(str(value));
        return Number.isFinite(n) ? n : null;
      };
      const raised = num(page.grandTotalRaisedExcludingGiftAid) ?? (num(page.totalRaisedOnline) ?? 0) + (num(page.totalRaisedOffline) ?? 0);
      const target = num(page.fundraisingTarget);
      return { raised, target: target && target > 0 ? target : null, currencySymbol: str(page.currencySymbol) ?? '£' };
    },
  };
}
