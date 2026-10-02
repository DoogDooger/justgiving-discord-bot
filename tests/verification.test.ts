import { describe, expect, it, vi } from 'vitest';
import { verifyDonation } from '../src/verification.js';
import { USER_A, USER_B, charity, donation, setup } from './helpers.js';

describe('verifyDonation: redirect flow', () => {
  it('accepts a valid donation that is listed on our page', async () => {
    const { deps, tokens } = setup((t) => ({ donations: { '100': donation('100', t.a) }, pages: { 'page-one': ['100'] } }));
    const result = await verifyDonation({ source: 'redirect', donationId: '100', token: tokens.a }, deps);
    expect(result).toMatchObject({ ok: true, discordUserId: USER_A, pageShortName: 'page-one' });
  });

  it('rejects a donation made on a page that is not ours', async () => {
    const { deps, tokens } = setup((t) => ({ donations: { '100': donation('100', t.a) }, pages: { 'someone-else': ['100'] } }));
    const result = await verifyDonation({ source: 'redirect', donationId: '100', token: tokens.a }, deps);
    expect(result).toMatchObject({ ok: false, reason: 'wrong_page', discordUserId: USER_A });
  });

  it('reports pending donations as pending', async () => {
    const { deps, tokens } = setup((t) => ({ donations: { '100': donation('100', t.a, 'Pending') }, pages: { 'page-one': ['100'] } }));
    expect(await verifyDonation({ source: 'redirect', donationId: '100', token: tokens.a }, deps)).toMatchObject({ ok: false, reason: 'pending' });
  });

  it.each(['Refunded', 'Rejected', 'Cancelled'])('rejects %s donations', async (status) => {
    const { deps, tokens } = setup((t) => ({ donations: { '100': donation('100', t.a, status) }, pages: { 'page-one': ['100'] } }));
    expect(await verifyDonation({ source: 'redirect', donationId: '100', token: tokens.a }, deps)).toMatchObject({
      ok: false,
      reason: 'not_accepted',
      detail: status,
    });
  });

  it('rejects when the donation reference does not match the token in the URL', async () => {
    const { deps, tokens } = setup((t) => ({ donations: { '100': donation('100', t.b) }, pages: { 'page-one': ['100'] } }));
    expect(await verifyDonation({ source: 'redirect', donationId: '100', token: tokens.a }, deps)).toMatchObject({
      ok: false,
      reason: 'reference_mismatch',
    });
  });

  it('rejects a reference that is not one of our tokens', async () => {
    const { deps } = setup(() => ({ donations: { '100': donation('100', 'ZZZZZZZZ') }, pages: { 'page-one': ['100'] } }));
    expect(await verifyDonation({ source: 'redirect', donationId: '100', token: 'ZZZZZZZZ' }, deps)).toMatchObject({
      ok: false,
      reason: 'reference_mismatch',
    });
  });

  it('rejects malformed tokens and donation IDs before calling JustGiving', async () => {
    const { deps } = setup(() => ({ fail: true }));
    expect(await verifyDonation({ source: 'redirect', donationId: '12a', token: 'ABCDEFGH' }, deps)).toMatchObject({ reason: 'invalid_donation_id' });
    expect(await verifyDonation({ source: 'redirect', donationId: '100', token: '<script>' }, deps)).toMatchObject({ reason: 'invalid_token' });
  });

  it('reports a donation JustGiving does not know', async () => {
    const { deps, tokens } = setup();
    expect(await verifyDonation({ source: 'redirect', donationId: '404', token: tokens.a }, deps)).toMatchObject({ ok: false, reason: 'donation_not_found' });
  });

  it('turns JustGiving errors and timeouts into api_error', async () => {
    const { deps, tokens } = setup(() => ({ fail: true }));
    expect(await verifyDonation({ source: 'redirect', donationId: '100', token: tokens.a }, deps)).toMatchObject({ ok: false, reason: 'api_error' });
  });

  it('refuses when no charity pages are configured', async () => {
    const { deps, tokens } = setup((t) => ({ donations: { '100': donation('100', t.a) } }));
    deps.charity = { ...charity, pageShortName: null };
    expect(await verifyDonation({ source: 'redirect', donationId: '100', token: tokens.a }, deps)).toMatchObject({ reason: 'not_configured' });
  });
});

describe('verifyDonation: drive deadline', () => {
  const driveEndsAt = new Date('2026-10-01T00:00:00Z');

  it('accepts a donation with no date before the deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-30T00:00:00Z'));
    try {
      const { deps } = setup((t) => ({ donations: { '100': donation('100', t.a, 'Accepted', 'C1', null) } }));
      expect(await verifyDonation({ source: 'claim', donationId: '100', discordUserId: USER_A }, { ...deps, driveEndsAt })).toMatchObject({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts a pre-deadline donation claimed after the drive ends', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-02T00:00:00Z'));
    try {
      const { deps } = setup((t) => ({ donations: { '100': donation('100', t.a, 'Accepted', 'C1', driveEndsAt.getTime() - 1) } }));
      expect(await verifyDonation({ source: 'claim', donationId: '100', discordUserId: USER_A }, { ...deps, driveEndsAt })).toMatchObject({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([0, 1])('rejects a donation made %s ms after the deadline', async (delay) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-02T00:00:00Z'));
    try {
      const { deps, tokens } = setup((t) => ({ donations: { '100': donation('100', t.a, 'Accepted', 'C1', driveEndsAt.getTime() + delay) } }));
      expect(await verifyDonation({ source: 'redirect', donationId: '100', token: tokens.a }, { ...deps, driveEndsAt })).toMatchObject({
        ok: false, reason: 'after_deadline', discordUserId: USER_A,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([undefined, null])('does not require a donation date when the deadline is %j', async (driveEndsAt) => {
    const { deps, tokens } = setup((t) => ({ donations: { '100': donation('100', t.a, 'Accepted', 'C1') } }));
    expect(await verifyDonation({ source: 'redirect', donationId: '100', token: tokens.a }, { ...deps, driveEndsAt })).toMatchObject({ ok: true });
  });

  it('reports api_error when a deadline is set but the donation date is missing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-02T00:00:00Z'));
    try {
      const { deps, tokens } = setup((t) => ({ donations: { '100': donation('100', t.a, 'Accepted', 'C1') } }));
      expect(await verifyDonation({ source: 'redirect', donationId: '100', token: tokens.a }, { ...deps, driveEndsAt })).toMatchObject({
        ok: false, reason: 'api_error', discordUserId: USER_A, detail: 'donation date missing',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('verifyDonation: charity matching', () => {
  it("accepts a donation whose charity ID matches our page's charity", async () => {
    const { deps, tokens } = setup((t) => ({ donations: { '100': donation('100', t.a) }, charityIds: { '100': 'C1' } }));
    const result = await verifyDonation({ source: 'redirect', donationId: '100', token: tokens.a }, deps);
    expect(result).toMatchObject({ ok: true, pageShortName: 'page-one' });
  });

  it("rejects a donation to a charity that isn't ours, even if it appears on our page's list", async () => {
    const { deps, tokens } = setup((t) => ({
      donations: { '100': donation('100', t.a) },
      charityIds: { '100': 'OTHER' },
      pages: { 'page-one': ['100'] },
    }));
    expect(await verifyDonation({ source: 'redirect', donationId: '100', token: tokens.a }, deps)).toMatchObject({
      ok: false,
      reason: 'wrong_page',
    });
  });

  it('uses the charity ID on the donation record itself (available straight away)', async () => {
    const { deps, tokens } = setup((t) => ({ donations: { '100': donation('100', t.a, 'Accepted', 'C1') } }));
    expect(await verifyDonation({ source: 'redirect', donationId: '100', token: tokens.a }, deps)).toMatchObject({ ok: true });
  });

  it('retries while JustGiving is still listing a new donation', async () => {
    let calls = 0;
    const { deps, tokens } = setup((t) => ({ donations: { '100': donation('100', t.a) } }));
    const original = deps.justGiving.getDonationCharityId;
    deps.justGiving.getDonationCharityId = async (ref, id) => (++calls >= 3 ? 'C1' : original(ref, id));
    deps.listingRetries = 3;
    deps.retryDelayMs = 1;
    expect(await verifyDonation({ source: 'redirect', donationId: '100', token: tokens.a }, deps)).toMatchObject({ ok: true });
    expect(calls).toBe(3);
  });
});

describe('verifyDonation: /claim flow', () => {
  it('accepts a donation made with the same user\'s token', async () => {
    const { deps, tokens } = setup((t) => ({ donations: { '100': donation('100', t.a) }, pages: { 'page-one': ['100'] } }));
    const result = await verifyDonation({ source: 'claim', donationId: '100', discordUserId: USER_A }, deps);
    expect(result).toMatchObject({ ok: true, discordUserId: USER_A, token: tokens.a });
  });

  it("rejects claiming someone else's donation", async () => {
    const { deps } = setup((t) => ({ donations: { '100': donation('100', t.b) }, pages: { 'page-one': ['100'] } }));
    expect(await verifyDonation({ source: 'claim', donationId: '100', discordUserId: USER_A }, deps)).toMatchObject({
      ok: false,
      reason: 'not_your_reference',
    });
  });

  it('rejects a donation with no reference (not made via /donate)', async () => {
    const { deps } = setup(() => ({ donations: { '100': donation('100', null) }, pages: { 'page-one': ['100'] } }));
    expect(await verifyDonation({ source: 'claim', donationId: '100', discordUserId: USER_A }, deps)).toMatchObject({
      ok: false,
      reason: 'missing_reference',
    });
  });

  it('matches references case-insensitively', async () => {
    const { deps } = setup((t) => ({ donations: { '100': donation('100', t.a.toLowerCase()) }, pages: { 'page-one': ['100'] } }));
    // The fake page lookup compares the raw reference, as JustGiving would.
    expect(await verifyDonation({ source: 'claim', donationId: '100', discordUserId: USER_A }, deps)).toMatchObject({ ok: true });
  });
});

describe('verifyDonation: already claimed', () => {
  it('tells the same user they already claimed it', async () => {
    const { deps, store, tokens } = setup((t) => ({ donations: { '100': donation('100', t.a) }, pages: { 'page-one': ['100'] } }));
    store.insertClaim({ donationId: '100', discordUserId: USER_A, token: tokens.a, pageShortName: 'page-one', source: 'redirect' });
    expect(await verifyDonation({ source: 'claim', donationId: '100', discordUserId: USER_A }, deps)).toMatchObject({ reason: 'already_claimed_by_you' });
    expect(await verifyDonation({ source: 'redirect', donationId: '100', token: tokens.a }, deps)).toMatchObject({ reason: 'already_claimed_by_you' });
  });

  it('tells a different user it is already taken', async () => {
    const { deps, store, tokens } = setup((t) => ({ donations: { '100': donation('100', t.a) }, pages: { 'page-one': ['100'] } }));
    store.insertClaim({ donationId: '100', discordUserId: USER_A, token: tokens.a, pageShortName: 'page-one', source: 'redirect' });
    expect(await verifyDonation({ source: 'claim', donationId: '100', discordUserId: USER_B }, deps)).toMatchObject({ reason: 'already_claimed' });
  });
});
