import { describe, expect, it } from 'vitest';
import { processDonation, resolveClaimInput } from '../src/donations.js';
import { JustGivingError, type Donation } from '../src/justgiving.js';
import { ReceiptDirectory } from '../src/receipts.js';
import { USER_A, charity, donation, setup } from './helpers.js';

/** A page whose donations each have a receipt reference, counting every JustGiving call. */
function fakePage(donations: Record<string, string | null>) {
  const calls = { lists: 0, lookups: [] as string[] };
  const control = { failList: false, failLookup: new Set<string>() };
  const directory = new ReceiptDirectory(
    {
      async getPageDonationIds() {
        calls.lists++;
        if (control.failList) throw new JustGivingError('JustGiving request timed out');
        return Object.keys(donations);
      },
      async getDonation(id): Promise<Donation | null> {
        calls.lookups.push(id);
        if (control.failLookup.has(id)) throw new JustGivingError('JustGiving returned HTTP 503', 503);
        return id in donations ? donation(id, null, 'Accepted', 'C1', null, donations[id]) : null;
      },
    },
    charity,
  );
  return { directory, calls, control, donations };
}

describe('ReceiptDirectory', () => {
  it('finds the donation on our page that a receipt reference belongs to', async () => {
    const { directory, calls } = fakePage({ '9000000001': '123456789', '9000000002': '234567890' });
    expect(await directory.find('123456789')).toBe('9000000001');
    expect(await directory.find('234567890')).toBe('9000000002');
    // The whole page was indexed by the first search; the second cost nothing.
    expect(calls).toMatchObject({ lists: 1 });
    expect(calls.lookups.sort()).toEqual(['9000000001', '9000000002']);
  });

  it('returns null for a receipt from a donation that is not on our page', async () => {
    const { directory } = fakePage({ '9000000001': '123456789' });
    expect(await directory.find('987654321')).toBeNull();
  });

  it('looks each donation up only once, and picks up new ones on a later refresh', async () => {
    const { directory, calls, donations } = fakePage({ '1': '111111111' });
    await directory.refresh();
    donations['2'] = '222222222';
    await directory.refresh();
    expect(calls.lookups).toEqual(['1', '2']);
    expect(await directory.find('222222222')).toBe('2');
  });

  it('shares one refresh between claims that arrive together', async () => {
    const { directory, calls } = fakePage({ '1': '111111111', '2': '222222222' });
    expect(await Promise.all([directory.find('111111111'), directory.find('222222222'), directory.find('333333333')])).toEqual(['1', '2', null]);
    expect(calls.lists).toBe(1);
    expect(calls.lookups).toHaveLength(2);
  });

  it('does not re-read the page for every unknown reference', async () => {
    const { directory, calls } = fakePage({ '1': '111111111' });
    expect(await directory.find('999999999')).toBeNull();
    expect(await directory.find('888888888')).toBeNull();
    expect(calls.lists).toBe(1);
  });

  it('retries a donation whose lookup failed, and reports a page it cannot read', async () => {
    const { directory, calls, control } = fakePage({ '1': '111111111' });
    control.failLookup.add('1');
    await directory.refresh();
    expect(calls.lookups).toEqual(['1']);

    control.failLookup.clear();
    await directory.refresh();
    expect(calls.lookups).toEqual(['1', '1']);
    expect(await directory.find('111111111')).toBe('1');

    control.failList = true;
    await expect(directory.refresh()).rejects.toBeInstanceOf(JustGivingError);
  });

  it('does nothing before the JustGiving page is set', async () => {
    const directory = new ReceiptDirectory(
      { getPageDonationIds: async () => ['1'], getDonation: async () => null },
      { ...charity, pageShortName: null },
    );
    expect(await directory.find('111111111')).toBeNull();
  });
});

describe('claiming with what the receipt shows', () => {
  // A receipt reads "123456789/1"; the donation it belongs to has the ID 9000000001.
  const page = (reference: string | null) => ({
    donations: { '9000000001': donation('9000000001', reference, 'Accepted', 'C1', null, '123456789') },
    pages: { 'page-one': ['9000000001'] },
  });

  it.each(['123456789/1', '123456789', ' 123456789 / 1 '])('turns %j into the donation ID', async (input) => {
    const { deps } = setup((t) => page(t.a));
    expect(await resolveClaimInput(input, deps)).toBe('9000000001');
  });

  it('still accepts the donation ID itself', async () => {
    const { deps } = setup((t) => page(t.a));
    expect(await resolveClaimInput('9000000001', deps)).toBe('9000000001');
  });

  it('knows a receipt for a different page is not ours, and leaves a bare unknown number to verification', async () => {
    const { deps } = setup((t) => page(t.a));
    expect(await resolveClaimInput('987654321/1', deps)).toBeNull();
    expect(await resolveClaimInput('987654321', deps)).toBe('987654321');
    expect(await processDonation({ source: 'claim', donationId: '987654321', discordUserId: USER_A }, deps)).toEqual({ ok: false, reason: 'donation_not_found' });
  });

  it('passes anything that is not a number through, to be refused as invalid', async () => {
    const { deps } = setup((t) => page(t.a));
    expect(await resolveClaimInput('my receipt', deps)).toBe('my receipt');
    expect(await processDonation({ source: 'claim', donationId: 'my receipt', discordUserId: USER_A }, deps)).toEqual({ ok: false, reason: 'invalid_donation_id' });
  });

  it('gives the role from the receipt reference, once', async () => {
    const { deps, discord, store, tokens } = setup((t) => page(t.a));
    const donationId = (await resolveClaimInput('123456789/1', deps))!;
    expect(await processDonation({ source: 'claim', donationId, discordUserId: USER_A }, deps)).toMatchObject({ ok: true, role: 'added' });
    expect(discord.calls).toEqual([{ userId: USER_A, roleId: charity.roleId }]);
    expect(store.getClaim('9000000001')).toMatchObject({ discordUserId: USER_A, token: tokens.a });

    const again = (await resolveClaimInput('123456789/1', deps))!;
    expect(await processDonation({ source: 'claim', donationId: again, discordUserId: USER_A }, deps)).toEqual({ ok: false, reason: 'already_claimed_by_you' });
  });

  it('finding a donation does not change the rules: one made without /donate is still refused', async () => {
    const { deps } = setup(() => page(null));
    const donationId = (await resolveClaimInput('123456789/1', deps))!;
    expect(await processDonation({ source: 'claim', donationId, discordUserId: USER_A }, deps)).toEqual({ ok: false, reason: 'missing_reference' });
  });

  it('reports JustGiving being down rather than "not found"', async () => {
    const { deps } = setup(() => ({ fail: true }));
    await expect(resolveClaimInput('123456789/1', deps)).rejects.toBeInstanceOf(JustGivingError);
  });
});
