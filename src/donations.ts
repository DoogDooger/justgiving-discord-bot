import type { CharityConfig } from './config.js';
import type { Store } from './db.js';
import { donationId as canonicalDonationId } from './donation-id.js';
import { JustGivingError, type JustGivingApi } from './justgiving.js';
import type { UserOperation, UserOperations } from './user-operations.js';
import type { PageDirectory } from './pages.js';
import { receiptReference, type ReceiptDirectory } from './receipts.js';
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
  operations: UserOperations;
  justGiving: JustGivingApi;
  store: Store;
  charity: CharityConfig;
  driveEndsAt?: Date | null;
  pages: Pick<PageDirectory, 'getPageOrThrow'>;
  /** Finds a donation on our page from the reference on a donor's receipt. */
  receipts: Pick<ReceiptDirectory, 'find'>;
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
  | { ok: true; donationId: string; discordUserId: string; role: RoleOutcome }
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
  // Forget cannot recall an already sent REST request, but must not recreate audit/DM work.
  if (store.getClaim(claim.donationId)?.discordUserId !== claim.discordUserId) return role;
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

/** Provider-backed receipt resolution; null receiptRef preserves the legacy tagged-ID fallback. */
export interface ResolvedClaim {
  readonly donationId: string;
  readonly receiptRef: string | null;
}

/** Translate a receipt reference to its donation ID without treating the reference as payer authentication. */
export async function resolveClaimInput(input: string, deps: Pick<DonationDeps, 'receipts'>): Promise<ResolvedClaim | null> {
  const value = input.trim();
  const ref = receiptReference(value);
  if (ref === null) return { donationId: value, receiptRef: null };
  const found = await deps.receipts.find(ref);
  if (found) return { donationId: found, receiptRef: ref };
  return value.includes('/') ? null : { donationId: ref, receiptRef: null };
}

/** Manual claim boundary: track the whole lookup/verification so forget cannot be undone by a late result. */
export async function processClaim(
  input: string,
  discordUserId: string,
  deps: DonationDeps,
  options: { readonly operation?: UserOperation } = {},
): Promise<ProcessOutcome> {
  const operation = options.operation ?? deps.operations.begin(discordUserId);
  try {
    if (!operation.isCurrent()) return { ok: false, reason: 'claim_cancelled' };
    const resolved = await resolveClaimInput(input, deps);
    if (!operation.isCurrent()) return { ok: false, reason: 'claim_cancelled' };
    if (!resolved) {
      deps.store.audit('verification_failed', {
        discordUserId,
        detail: 'claim: receipt reference not on our page',
      });
      return { ok: false, reason: 'donation_not_found' };
    }
    return await processDonation({ source: 'claim', discordUserId, ...resolved }, deps, { operation });
  } catch (error) {
    if (!(error instanceof JustGivingError)) throw error;
    return { ok: false, reason: operation.isCurrent() ? 'api_error' : 'claim_cancelled' };
  } finally {
    if (!options.operation) operation.finish();
  }
}

/** Verify, atomically record use, then give the role. Failed Discord calls keep the durable claim for retry. */
export async function processDonation(
  request: VerifyRequest,
  deps: DonationDeps,
  options: { readonly operation?: UserOperation } = {},
): Promise<ProcessOutcome> {
  const { store } = deps;
  const knownUser = request.source === 'claim' ? request.discordUserId : store.getTokenOwner(request.token.toUpperCase());
  const operation = options.operation ?? (knownUser ? deps.operations.begin(knownUser) : null);
  try {
    if (operation && !operation.isCurrent()) return { ok: false, reason: 'claim_cancelled' };
    const result = await verifyDonation(request, deps);
    if (operation && !operation.isCurrent()) return { ok: false, reason: 'claim_cancelled' };

    if (!result.ok) {
      store.audit('verification_failed', {
        discordUserId: result.discordUserId,
        donationId: canonicalDonationId(request.donationId),
        detail: [request.source, result.reason, result.detail].filter((part) => part !== undefined).join(': '),
      });
      return { ok: false, reason: result.reason };
    }

    const { discordUserId, donationId } = result;
    const inserted = store.insertClaim({
      donationId,
      discordUserId,
      token: result.token,
      pageShortName: result.pageShortName,
      source: request.source,
    });
    if (!inserted) {
      const winner = store.getClaim(donationId);
      return { ok: false, reason: winner?.discordUserId === discordUserId ? 'already_claimed_by_you' : 'already_claimed' };
    }

    // Existing bounded wait/role queue: no network work occurs inside the claim transaction.
    const granting = grantRole(deps, { donationId, discordUserId }, request.source).catch((error: unknown) => {
      console.error(`Role grant failed for donation ${donationId}:`, error instanceof Error ? error.message : error);
      return 'failed' as const;
    });
    let timer: NodeJS.Timeout | undefined;
    const waited = new Promise<'queued'>((resolve) => {
      timer = setTimeout(() => resolve('queued'), deps.roleWaitMs ?? DEFAULT_ROLE_WAIT_MS);
    });
    const role = await Promise.race([granting, waited]);
    clearTimeout(timer);
    if (operation && !operation.isCurrent()) return { ok: false, reason: 'claim_cancelled' };
    return { ok: true, donationId, discordUserId, role };
  } finally {
    if (!options.operation) operation?.finish();
  }
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
 * Failed role removals stay queued for the next re-check.
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
    if (store.getClaim(claim.donationId)?.discordUserId !== claim.discordUserId) continue;
    if (status && REVERSED.has(status)) {
      store.revokeClaim(claim.donationId);
      revoked++;
      const stillDonor = store.getClaimsForUser(claim.discordUserId).some((c) => c.status === 'granted');
      if (!stillDonor) store.queueRoleRemoval(claim.discordUserId);
      store.audit('claim_revoked', {
        discordUserId: claim.discordUserId,
        donationId: claim.donationId,
        detail: `${status}; role ${stillDonor ? 'kept (other donations)' : 'removal queued'}`,
      });
    }
    if (options.pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, options.pauseMs));
  }
  for (const discordUserId of store.getPendingRoleRemovals()) {
    const claims = store.getClaimsForUser(discordUserId);
    // Forgotten since the list was read, or donating again: nothing to remove.
    if (claims.length === 0 || claims.some((c) => c.status === 'granted')) {
      store.deletePendingRoleRemoval(discordUserId);
      continue;
    }
    const removed = await deps.discord.removeRole(discordUserId, charity.roleId, 'JustGiving donation refunded, cancelled or rejected');
    if (store.getClaimsForUser(discordUserId).length === 0) continue;
    if (removed) store.deletePendingRoleRemoval(discordUserId);
    store.audit(removed ? 'role_removed' : 'role_remove_failed', { discordUserId });
  }
  return { checked: claims.length, revoked };
}
