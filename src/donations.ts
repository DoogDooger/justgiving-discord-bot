import type { CharityConfig } from './config.js';
import type { Store } from './db.js';
import type { JustGivingApi } from './justgiving.js';
import type { PageDirectory } from './pages.js';
import { verifyDonation, type FailureReason, type VerifyRequest } from './verification.js';

export type RoleResult = 'added' | 'not_member' | 'failed';

/** The Discord side effects the donation flow needs. Implemented over REST in discord/roles.ts. */
export interface DiscordActions {
  addRole(discordUserId: string, roleId: string, reason: string): Promise<RoleResult>;
  /** Takes the role away. Resolves false if Discord refused (the caller logs it and moves on). */
  removeRole(discordUserId: string, roleId: string, reason: string): Promise<boolean>;
  /** Thank-you DM. Rejects when the user has DMs closed; callers ignore that. */
  sendThanks(discordUserId: string, charity: CharityConfig, donationId: string): Promise<void>;
}

export interface DonationDeps {
  justGiving: JustGivingApi;
  store: Store;
  charity: CharityConfig;
  driveEndsAt?: Date | null;
  pages: Pick<PageDirectory, 'getPageOrThrow'>;
  listingRetries?: number;
  retryDelayMs?: number;
  /** How long processDonation waits for the role before answering 'queued'. */
  roleWaitMs?: number;
  discord: DiscordActions;
  sendDmOnSuccess: boolean;
}

/** 'queued' = the claim is recorded and the role is waiting in Discord's rate-limit queue. */
export type RoleOutcome = RoleResult | 'queued';

export type ProcessOutcome =
  | { ok: true; discordUserId: string; role: RoleOutcome }
  | { ok: false; reason: FailureReason };

/** How long a donor waits for their role before being told it's on its way. */
const DEFAULT_ROLE_WAIT_MS = 6000;

/** Donations whose role request is already waiting on Discord, so the queue doesn't ask twice. */
const inFlight = new Set<string>();

/**
 * Gives the role for one recorded claim and saves the result. Discord only allows a
 * few role changes per second per server, so with many donors at once this can take
 * a while; callers must not make a donor wait on it.
 */
async function grantRole(deps: DonationDeps, claim: { donationId: string; discordUserId: string }, source: string): Promise<RoleResult> {
  const { store, charity } = deps;
  inFlight.add(claim.donationId);
  let role: RoleResult;
  try {
    role = await deps.discord.addRole(claim.discordUserId, charity.roleId, `JustGiving donation ${claim.donationId} to ${charity.name}`);
  } finally {
    inFlight.delete(claim.donationId);
  }
  if (role === 'added') store.setRoleState(claim.donationId, 'added');
  else if (role === 'not_member') store.setRoleState(claim.donationId, 'not_member');
  store.audit(role === 'added' ? 'role_granted' : role === 'not_member' ? 'role_pending_not_member' : 'role_add_failed', {
    discordUserId: claim.discordUserId,
    donationId: claim.donationId,
    detail: source,
  });
  if (deps.sendDmOnSuccess && role === 'added') {
    // Courtesy only: never hold anything up for a DM, and ignore closed DMs.
    void deps.discord.sendThanks(claim.discordUserId, charity, claim.donationId).catch(() => undefined);
  }
  return role;
}

/** Verifies a donation, records the claim, and gives the charity's role. */
export async function processDonation(request: VerifyRequest, deps: DonationDeps): Promise<ProcessOutcome> {
  const { store } = deps;
  const result = await verifyDonation(request, deps);

  if (!result.ok) {
    store.audit('verification_failed', {
      discordUserId: result.discordUserId,
      donationId: request.donationId,
      detail: [request.source, result.reason, result.detail].filter(Boolean).join(': '),
    });
    return { ok: false, reason: result.reason };
  }

  const { discordUserId } = result;
  const inserted = store.insertClaim({
    donationId: request.donationId,
    discordUserId,
    token: result.token,
    pageShortName: result.pageShortName,
    source: request.source,
  });
  if (!inserted) {
    const winner = store.getClaim(request.donationId);
    return { ok: false, reason: winner?.discordUserId === discordUserId ? 'already_claimed_by_you' : 'already_claimed' };
  }

  // The claim is safe in the database. Wait briefly for the role; if Discord's queue is
  // busy, answer now and let the role arrive in the background (syncPendingRoles also
  // picks it up if this process restarts first).
  const granting = grantRole(deps, { donationId: request.donationId, discordUserId }, request.source).catch((error: unknown) => {
    console.error(`Role grant failed for donation ${request.donationId}:`, error instanceof Error ? error.message : error);
    return 'failed' as const;
  });
  let timer: NodeJS.Timeout | undefined;
  const waited = new Promise<'queued'>((resolve) => {
    timer = setTimeout(() => resolve('queued'), deps.roleWaitMs ?? DEFAULT_ROLE_WAIT_MS);
  });
  const role = await Promise.race([granting, waited]);
  clearTimeout(timer);

  return { ok: true, discordUserId, role };
}

/**
 * Background role queue: retries claims whose role hasn't been given yet (Discord was
 * busy, the bot restarted, or a call failed). Run on a timer from index.ts.
 */
export async function syncPendingRoles(deps: DonationDeps, options: { maxAgeMs: number; limit: number }): Promise<number> {
  const pending = deps.store.getPendingRoleClaims(Date.now() - options.maxAgeMs, options.limit);
  let added = 0;
  for (const claim of pending) {
    // Skip claims another path (the original request, /donor-status) is handling or has finished.
    if (inFlight.has(claim.donationId) || deps.store.getClaim(claim.donationId)?.roleState !== 'pending') continue;
    const role = await grantRole(deps, claim, 'queue').catch(() => 'failed' as const);
    if (role === 'added') added++;
  }
  return added;
}

/** JustGiving statuses that mean the money didn't stay with the charity. */
const REVERSED = new Set(['Refunded', 'Cancelled', 'Rejected']);

/**
 * Refund re-check: asks JustGiving about every claimed donation again. A donation that has
 * since been refunded, cancelled or rejected is revoked (it leaves the donor wall and top
 * donors), and the role is removed if the member has no other donation left. Run daily from
 * index.ts. Paced so a long list doesn't hammer JustGiving; any lookup error just skips that
 * donation until the next run.
 */
export async function recheckDonations(deps: DonationDeps, options: { minAgeMs: number; pauseMs: number }): Promise<{ checked: number; revoked: number }> {
  const { store, charity } = deps;
  const claims = store.getGrantedClaims(Date.now() - options.minAgeMs);
  let revoked = 0;
  for (const claim of claims) {
    let status: string | undefined;
    try {
      status = (await deps.justGiving.getDonation(claim.donationId))?.status;
    } catch {
      continue;
    }
    if (status && REVERSED.has(status)) {
      store.revokeClaim(claim.donationId);
      revoked++;
      const stillDonor = store.getClaimsForUser(claim.discordUserId).some((c) => c.status === 'granted');
      const removed = stillDonor ? false : await deps.discord.removeRole(claim.discordUserId, charity.roleId, `JustGiving donation ${claim.donationId} was ${status.toLowerCase()}`);
      store.audit('claim_revoked', {
        discordUserId: claim.discordUserId,
        donationId: claim.donationId,
        detail: `${status}; role ${stillDonor ? 'kept (other donations)' : removed ? 'removed' : 'not removed'}`,
      });
    }
    if (options.pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, options.pauseMs));
  }
  return { checked: claims.length, revoked };
}
