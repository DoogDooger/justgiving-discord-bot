import { describe, expect, it } from 'vitest';
import { processClaim, processDonation, recheckDonations, syncPendingRoles } from '../src/donations.js';
import { JustGivingError } from '../src/justgiving.js';
import { USER_A, USER_B, donation, setup } from './helpers.js';

describe('receipt redemption end to end', () => {
  it('claims a pre-launch donation beyond the recent 100, once across input aliases and users', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => String(i + 1));
    const { deps, store, discord } = setup(() => ({
      donations: { '150': donation('150', null, 'Accepted', 'C1', Date.UTC(2025, 0, 1), '700150') },
      pages: { 'page-one': ids },
    }));
    // The legacy recent-page shortcut cannot see this donation.
    deps.justGiving = { ...deps.justGiving, pageHasDonation: async () => false };
    const outcomes = await Promise.all([processClaim('700150/1', USER_A, deps), processClaim('700150', USER_B, deps)]);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.ok)).toEqual([{ ok: false, reason: 'already_claimed' }]);
    expect(store.hasRedeemedDonation('150')).toBe(true);
    expect(discord.calls).toHaveLength(1);
    const owner = store.getClaim('150')?.discordUserId;
    expect(owner).toBeDefined();
    expect(await processDonation({ source: 'claim', donationId: '00150', discordUserId: USER_B }, deps))
      .toMatchObject({ reason: owner === USER_B ? 'already_claimed_by_you' : 'already_claimed' });
  });

  it('keeps a failed role grant reserved and retries it through the existing queue', async () => {
    const { deps, store, discord } = setup(() => ({
      donations: { '100': donation('100', null, 'Accepted', 'C1', null, '700100') },
      pages: { 'page-one': ['100'] },
    }), 'failed');
    expect(await processClaim('700100/1', USER_A, deps)).toMatchObject({ ok: true, role: 'failed' });
    expect(store.getClaim('100')).toMatchObject({ token: null, roleState: 'pending' });
    expect(await processClaim('700100', USER_B, deps)).toMatchObject({ reason: 'already_claimed' });
    discord.control.result = 'added';
    expect(await syncPendingRoles(deps, { maxAgeMs: 60_000, limit: 10 })).toBe(1);
    expect(store.hasRedeemedDonation('100')).toBe(true);
  });

  it('shares refund and removal-retry rules across receipt and bot-linked donations', async () => {
    const direct = donation('100', null, 'Accepted', 'C1', null, '700100');
    const linked = donation('200', '', 'Accepted', 'C1', null, '700200');
    const { deps, store, tokens, discord } = setup((t) => {
      linked.thirdPartyReference = t.a;
      return { donations: { '100': direct, '200': linked }, pages: { 'page-one': ['100', '200'] } };
    });
    await processClaim('700100/1', USER_A, deps);
    await processDonation({ source: 'redirect', donationId: '00200', token: tokens.a }, deps);
    expect(store.getClaim('200')?.token).toBe(tokens.a);
    direct.status = 'Refunded';
    await recheckDonations(deps, { minAgeMs: -1000, pauseMs: 0 });
    expect(store.getClaim('100')?.status).toBe('revoked');
    expect(discord.removed).toEqual([]);
    linked.status = 'Cancelled';
    discord.control.removeResult = false;
    await recheckDonations(deps, { minAgeMs: -1000, pauseMs: 0 });
    expect(store.getPendingRoleRemovals()).toEqual([USER_A]);
    discord.control.removeResult = true;
    await recheckDonations(deps, { minAgeMs: -1000, pauseMs: 0 });
    expect(store.getPendingRoleRemovals()).toEqual([]);
    expect(store.getRecentPublicClaims(10)).toEqual([]);
    expect(store.hasRedeemedDonation('100')).toBe(true);
  });

  it('does not reserve anything on provider failure or a stale cached receipt', async () => {
    const record = donation('100', null, 'Accepted', 'C1', null, '700100');
    const { deps, store } = setup(() => ({ donations: { '100': record }, pages: { 'page-one': ['100'] } }));
    await deps.receipts.find('700100');
    record.receiptRef = '700200';
    expect(await processClaim('700100', USER_A, deps)).toMatchObject({ reason: 'donation_not_found' });
    deps.justGiving = { ...deps.justGiving, getDonation: async () => { throw new JustGivingError('fixture outage'); } };
    expect(await processClaim('700100', USER_A, deps)).toMatchObject({ reason: 'api_error' });
    expect(store.hasRedeemedDonation('100')).toBe(false);
  });
});
