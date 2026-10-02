import { describe, expect, it } from 'vitest';
import { processDonation, recheckDonations, syncPendingRoles } from '../src/donations.js';
import { verifyDonation } from '../src/verification.js';
import { USER_A, USER_B, charity, donation, setup } from './helpers.js';

describe('processDonation', () => {
  it('records the claim, adds the role and sends a DM', async () => {
    const { deps, store, discord, tokens } = setup((t) => ({ donations: { '100': donation('100', t.a) }, pages: { 'page-one': ['100'] } }));
    const outcome = await processDonation({ source: 'redirect', donationId: '100', token: tokens.a }, deps);

    expect(outcome).toMatchObject({ ok: true, role: 'added' });
    expect(discord.calls).toEqual([{ userId: USER_A, roleId: charity.roleId }]);
    expect(discord.dms).toEqual([USER_A]);
    expect(store.getClaim('100')).toMatchObject({ discordUserId: USER_A, source: 'redirect', status: 'granted' });
  });

  it('only lets a donation be claimed once', async () => {
    const { deps, discord, tokens } = setup((t) => ({ donations: { '100': donation('100', t.a) }, pages: { 'page-one': ['100'] } }));
    await processDonation({ source: 'redirect', donationId: '100', token: tokens.a }, deps);
    const second = await processDonation({ source: 'claim', donationId: '100', discordUserId: USER_A }, deps);

    expect(second).toEqual({ ok: false, reason: 'already_claimed_by_you' });
    expect(discord.calls).toHaveLength(1);
  });

  it('still records the claim when the user is not in the server', async () => {
    const { deps, store, discord, tokens } = setup(
      (t) => ({ donations: { '100': donation('100', t.a) }, pages: { 'page-one': ['100'] } }),
      'not_member',
    );
    const outcome = await processDonation({ source: 'redirect', donationId: '100', token: tokens.a }, deps);

    expect(outcome).toMatchObject({ ok: true, role: 'not_member' });
    expect(store.getClaim('100')).not.toBeNull();
    expect(discord.dms).toEqual([]);
  });

  it('does not record anything when verification fails', async () => {
    const { deps, store, discord, tokens } = setup((t) => ({ donations: { '100': donation('100', t.a, 'Pending') }, pages: { 'page-one': ['100'] } }));
    const outcome = await processDonation({ source: 'redirect', donationId: '100', token: tokens.a }, deps);

    expect(outcome).toEqual({ ok: false, reason: 'pending' });
    expect(store.getClaim('100')).toBeNull();
    expect(discord.calls).toEqual([]);
  });

  it('lets a user link several donations', async () => {
    const { deps, store, tokens } = setup((t) => ({
      donations: { '100': donation('100', t.a), '200': donation('200', t.a) },
      pages: { 'page-one': ['100', '200'] },
    }));
    await processDonation({ source: 'redirect', donationId: '100', token: tokens.a }, deps);
    await processDonation({ source: 'claim', donationId: '200', discordUserId: USER_A }, deps);

    expect(store.getClaimsForUser(USER_A).map((c) => c.donationId)).toEqual(['100', '200']);
  });
});

describe('busy periods', () => {
  const claimOf = (t: { a: string }) => ({ donations: { '100': donation('100', t.a) }, pages: { 'page-one': ['100'] } });

  it("answers 'queued' when Discord is slow, then finishes the role in the background", async () => {
    const { deps, store, discord, tokens } = setup(claimOf);
    discord.control.delayMs = 80;
    deps.roleWaitMs = 10;

    const outcome = await processDonation({ source: 'redirect', donationId: '100', token: tokens.a }, deps);
    expect(outcome).toMatchObject({ ok: true, role: 'queued' });
    expect(store.getClaim('100')).toMatchObject({ status: 'granted', roleState: 'pending' });

    // While the original request is still waiting on Discord, the queue must not ask again.
    expect(await syncPendingRoles(deps, { maxAgeMs: 60_000, limit: 10 })).toBe(0);
    expect(discord.calls).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(store.getClaim('100')).toMatchObject({ roleState: 'added' });
    expect(discord.dms).toEqual([USER_A]);
  });

  it('retries failed role adds from the background queue', async () => {
    const { deps, store, discord, tokens } = setup(claimOf, 'failed');
    const outcome = await processDonation({ source: 'redirect', donationId: '100', token: tokens.a }, deps);
    expect(outcome).toMatchObject({ ok: true, role: 'failed' });
    expect(store.getClaim('100')).toMatchObject({ roleState: 'pending' });

    discord.control.result = 'added';
    expect(await syncPendingRoles(deps, { maxAgeMs: 60_000, limit: 10 })).toBe(1);
    expect(store.getClaim('100')).toMatchObject({ roleState: 'added' });
    // Nothing left to do on the next pass.
    expect(await syncPendingRoles(deps, { maxAgeMs: 60_000, limit: 10 })).toBe(0);
    expect(discord.calls).toHaveLength(2);
  });

  it('does not keep retrying donors who are not in the server', async () => {
    const { deps, store, discord, tokens } = setup(claimOf, 'not_member');
    await processDonation({ source: 'redirect', donationId: '100', token: tokens.a }, deps);
    expect(store.getClaim('100')).toMatchObject({ roleState: 'not_member' });
    expect(await syncPendingRoles(deps, { maxAgeMs: 60_000, limit: 10 })).toBe(0);
    expect(discord.calls).toHaveLength(1);
  });

  it('handles a burst of 300 donors without losing or duplicating anyone', async () => {
    const ids = Array.from({ length: 300 }, (_, i) => String(1000 + i));
    const { deps, store, discord } = setup((t) => ({
      donations: Object.fromEntries(ids.map((id) => [id, donation(id, t.a, 'Accepted', 'C1')])),
    }));
    discord.control.delayMs = 5;
    deps.roleWaitMs = 1;

    const outcomes = await Promise.all(ids.map((id) => processDonation({ source: 'claim', donationId: id, discordUserId: USER_A }, deps)));
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(store.getClaimsForUser(USER_A)).toHaveLength(300);

    await new Promise((resolve) => setTimeout(resolve, 60));
    await syncPendingRoles(deps, { maxAgeMs: 60_000, limit: 500 });
    expect(store.getPendingRoleClaims(0, 500)).toEqual([]);
    expect(discord.calls).toHaveLength(300);
  });
});

describe('refund re-check', () => {
  const now = { minAgeMs: -1000, pauseMs: 0 };

  it('revokes a refunded donation and removes the role', async () => {
    const donations = { '100': donation('100', '', 'Accepted', 'C1') };
    const { deps, store, discord, tokens } = setup((t) => {
      donations['100'] = donation('100', t.a, 'Accepted', 'C1');
      return { donations };
    });
    await processDonation({ source: 'redirect', donationId: '100', token: tokens.a }, deps);

    donations['100'] = donation('100', tokens.a, 'Refunded', 'C1');
    expect(await recheckDonations(deps, now)).toEqual({ checked: 1, revoked: 1 });
    expect(store.getClaim('100')).toMatchObject({ status: 'revoked' });
    expect(discord.removed).toEqual([{ userId: USER_A, roleId: charity.roleId }]);
    expect(store.getRecentPublicClaims(10)).toEqual([]);

    // It can't be claimed again, and a second pass has nothing to do.
    expect(await verifyDonation({ source: 'claim', donationId: '100', discordUserId: USER_A }, deps)).toMatchObject({ ok: false, reason: 'not_accepted' });
    expect(await recheckDonations(deps, now)).toEqual({ checked: 0, revoked: 0 });
  });

  it('retries a failed role removal on the next recheck', async () => {
    const { deps, store, discord, tokens } = setup((t) => ({ donations: { '100': donation('100', t.a, 'Refunded', 'C1') } }));
    store.insertClaim({ donationId: '100', discordUserId: USER_A, token: tokens.a, pageShortName: 'page-one', source: 'claim' });
    discord.control.removeResult = false;

    expect(await recheckDonations(deps, now)).toEqual({ checked: 1, revoked: 1 });
    expect(store.getClaim('100')).toMatchObject({ status: 'revoked' });
    expect(discord.removed).toHaveLength(1);

    discord.control.removeResult = true;
    expect(await recheckDonations(deps, now)).toEqual({ checked: 0, revoked: 0 });
    expect(discord.removed).toHaveLength(2);
    expect(store.getPendingRoleRemovals()).toEqual([]);
  });

  it('clears a pending removal without removing the role when another donation is granted', async () => {
    const { deps, store, discord, tokens } = setup((t) => ({ donations: {
      '100': donation('100', t.a, 'Refunded', 'C1'),
      '200': donation('200', t.a, 'Accepted', 'C1'),
    } }));
    store.insertClaim({ donationId: '100', discordUserId: USER_A, token: tokens.a, pageShortName: 'page-one', source: 'claim' });
    discord.control.removeResult = false;
    await recheckDonations(deps, now);
    expect(store.getPendingRoleRemovals()).toEqual([USER_A]);

    store.insertClaim({ donationId: '200', discordUserId: USER_A, token: tokens.a, pageShortName: 'page-one', source: 'claim' });
    discord.control.removeResult = true;
    await recheckDonations(deps, now);
    expect(discord.removed).toHaveLength(1);
    expect(store.getPendingRoleRemovals()).toEqual([]);
  });

  it('keeps the role when the member has another valid donation', async () => {
    const donations: Record<string, ReturnType<typeof donation>> = {};
    const { deps, store, discord, tokens } = setup((t) => {
      donations['100'] = donation('100', t.a, 'Accepted', 'C1');
      donations['200'] = donation('200', t.a, 'Accepted', 'C1');
      return { donations };
    });
    await processDonation({ source: 'redirect', donationId: '100', token: tokens.a }, deps);
    await processDonation({ source: 'claim', donationId: '200', discordUserId: USER_A }, deps);

    donations['100'] = donation('100', tokens.a, 'Cancelled', 'C1');
    expect(await recheckDonations(deps, now)).toEqual({ checked: 2, revoked: 1 });
    expect(discord.removed).toEqual([]);
    expect(store.getClaimsForUser(USER_A).map((c) => c.status)).toEqual(['revoked', 'granted']);
  });

  it('leaves donations alone when they are still accepted or JustGiving is down', async () => {
    const options: { donations: Record<string, ReturnType<typeof donation>>; fail?: boolean } = { donations: {} };
    const { deps, store, discord, tokens } = setup((t) => {
      options.donations['100'] = donation('100', t.a, 'Accepted', 'C1');
      return options;
    });
    await processDonation({ source: 'redirect', donationId: '100', token: tokens.a }, deps);

    expect(await recheckDonations(deps, now)).toEqual({ checked: 1, revoked: 0 });
    options.fail = true;
    expect(await recheckDonations(deps, now)).toEqual({ checked: 1, revoked: 0 });
    expect(store.getClaim('100')).toMatchObject({ status: 'granted' });
    expect(discord.removed).toEqual([]);
  });
});

describe('forgetting a user', () => {
  it('deletes their claims, code, wall setting and log entries, and nobody else\'s', async () => {
    const { deps, store, tokens } = setup((t) => ({
      donations: { '100': donation('100', t.a, 'Accepted', 'C1'), '200': donation('200', t.b, 'Accepted', 'C1') },
    }));
    await processDonation({ source: 'redirect', donationId: '100', token: tokens.a }, deps);
    await processDonation({ source: 'redirect', donationId: '200', token: tokens.b }, deps);
    store.setHiddenFromWall(USER_A, true);

    expect(store.forgetUser(USER_A)).toBe(1);
    expect(store.getClaimsForUser(USER_A)).toEqual([]);
    expect(store.getTokenOwner(tokens.a)).toBeNull();
    expect(store.isHiddenFromWall(USER_A)).toBe(false);
    expect(store.getClaimsForUser(USER_B)).toHaveLength(1);
    expect(store.getTokenOwner(tokens.b)).toBe(USER_B);

    // Their old donation can't be claimed by anyone afterwards: its code no longer maps to a user.
    expect(await verifyDonation({ source: 'claim', donationId: '100', discordUserId: USER_A }, deps)).toMatchObject({ ok: false, reason: 'reference_mismatch' });
  });
});

describe('store tokens', () => {
  it('reuses one 8-character alphanumeric token per user', () => {
    const { store, tokens } = setup();
    expect(tokens.a).toMatch(/^[A-Z0-9]{8}$/);
    expect(store.getOrCreateToken(USER_A)).toBe(tokens.a);
    expect(tokens.b).not.toBe(tokens.a);
    expect(store.getTokenOwner(tokens.a)).toBe(USER_A);
  });
});
