import type { CharityConfig } from './config.js';
import type { Store } from './db.js';
import { JustGivingError, type JustGivingApi } from './justgiving.js';
import type { PageDirectory } from './pages.js';

/**
 * Every acceptance rule for a donation lives here. A donation is accepted only if:
 *  1. JustGiving returns it.
 *  2. Its reference maps to one of our tokens, owned by the right Discord user
 *     (redirect: the token in the return URL; /claim: the user running the command).
 *  3. Its status is Accepted.
 *  4. It went to the charity of our configured page (charity ID from the donation
 *     record or the reference lookup), or failing that, it is listed on our page.
 *  5. It hasn't been claimed before.
 *  6. It was made before the drive deadline, if one is set.
 * Amounts are not checked: JustGiving's own minimum (2 in every currency) is enough.
 */

export type VerifyRequest =
  | { source: 'redirect'; donationId: string; token: string }
  | { source: 'claim'; donationId: string; discordUserId: string };

export type FailureReason =
  | 'invalid_donation_id'
  | 'invalid_token'
  | 'not_configured'
  | 'already_claimed'
  | 'already_claimed_by_you'
  | 'donation_not_found'
  | 'missing_reference'
  | 'reference_mismatch'
  | 'not_your_reference'
  | 'pending'
  | 'not_accepted'
  | 'after_deadline'
  | 'wrong_page'
  | 'api_error';

export type VerifyResult =
  | { ok: true; discordUserId: string; token: string; pageShortName: string }
  | { ok: false; reason: FailureReason; discordUserId?: string; detail?: string };

export interface VerifyDeps {
  justGiving: JustGivingApi;
  store: Pick<Store, 'getTokenOwner' | 'getClaim'>;
  charity: CharityConfig;
  driveEndsAt?: Date | null;
  pages: Pick<PageDirectory, 'getPageOrThrow'>;
  /**
   * JustGiving can take a few seconds to list a brand-new donation. When the
   * charity can't be matched yet, retry this many times, waiting retryDelayMs between.
   */
  listingRetries?: number;
  retryDelayMs?: number;
}

const DONATION_ID = /^\d{1,15}$/;
const TOKEN = /^[A-Za-z0-9]{1,8}$/;

export async function verifyDonation(request: VerifyRequest, deps: VerifyDeps): Promise<VerifyResult> {
  const { donationId } = request;
  const knownUser = request.source === 'claim' ? request.discordUserId : undefined;
  const fail = (reason: FailureReason, extra: { discordUserId?: string; detail?: string } = {}): VerifyResult => ({
    ok: false,
    reason,
    discordUserId: extra.discordUserId ?? knownUser,
    detail: extra.detail,
  });

  if (!DONATION_ID.test(donationId)) return fail('invalid_donation_id');
  if (request.source === 'redirect' && !TOKEN.test(request.token)) return fail('invalid_token');

  const pagePath = deps.charity.pageShortName;
  if (!pagePath) return fail('not_configured');

  // Cheap check first; the unique key on insert is the real guard against races.
  const existing = deps.store.getClaim(donationId);
  if (existing) {
    // A donation revoked after a refund stays on record so it can't be claimed again.
    if (existing.status === 'revoked') return fail('not_accepted', { detail: 'revoked' });
    const claimant = request.source === 'claim' ? request.discordUserId : deps.store.getTokenOwner(request.token);
    return fail(existing.discordUserId === claimant ? 'already_claimed_by_you' : 'already_claimed', {
      discordUserId: claimant ?? undefined,
    });
  }

  try {
    const donation = await deps.justGiving.getDonation(donationId);
    if (!donation) return fail('donation_not_found');

    const reference = donation.thirdPartyReference;
    if (!reference) return fail('missing_reference');

    let discordUserId: string;
    if (request.source === 'redirect') {
      if (reference.toUpperCase() !== request.token.toUpperCase()) return fail('reference_mismatch');
      const owner = deps.store.getTokenOwner(request.token.toUpperCase());
      if (!owner) return fail('reference_mismatch');
      discordUserId = owner;
    } else {
      const owner = deps.store.getTokenOwner(reference.toUpperCase());
      if (!owner) return fail('reference_mismatch');
      if (owner !== request.discordUserId) return fail('not_your_reference');
      discordUserId = owner;
    }

    if (donation.status === 'Pending') return fail('pending', { discordUserId });
    if (donation.status !== 'Accepted') return fail('not_accepted', { discordUserId, detail: donation.status });

    if (deps.driveEndsAt && Date.now() >= deps.driveEndsAt.getTime()) {
      if (donation.donatedAtMs === null) return fail('api_error', { discordUserId, detail: 'donation date missing' });
      if (donation.donatedAtMs >= deps.driveEndsAt.getTime()) return fail('after_deadline', { discordUserId });
    }

    const accept = (): VerifyResult => ({
      ok: true,
      discordUserId,
      token: reference.toUpperCase(),
      pageShortName: pagePath,
    });

    // Primary: the donation's charity ID must match the charity our page raises money for.
    // It's on the donation record itself; the reference lookup is a second source.
    const attempts = 1 + (deps.listingRetries ?? 0);
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const charityId = donation.charityId ?? (await deps.justGiving.getDonationCharityId(reference, donationId));
      if (charityId) {
        const info = await deps.pages.getPageOrThrow();
        if (info?.charityId === charityId) return accept();
        return fail('wrong_page', { discordUserId, detail: `charity ${charityId}` });
      }

      // Fallback (JustGiving hasn't said which charity yet): look for it on our page.
      if (await deps.justGiving.pageHasDonation(pagePath, donationId)) return accept();
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, deps.retryDelayMs ?? 3000));
    }
    return fail('wrong_page', { discordUserId, detail: 'not listed yet' });
  } catch (error) {
    if (error instanceof JustGivingError) return fail('api_error', { detail: error.message });
    throw error;
  }
}
