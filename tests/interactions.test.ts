import { GuildMemberFlags, MessageFlags, type APIInteractionGuildMember, type InteractionDeferReplyOptions, type InteractionEditReplyOptions, type InteractionReplyOptions, type InteractionUpdateOptions, type ModalBuilder } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PageDirectory } from '../src/pages.js';
import { ClaimPrompts } from '../src/claim-prompts.js';
import type { AppContext } from '../src/context.js';
import type { Store } from '../src/db.js';
import { CLAIM_MODAL_ID, handleClaim, handleClaimButton, handleClaimChoice, handleClaimModal } from '../src/discord/commands/claim.js';
import { handleForgetChoice } from '../src/discord/commands/donor-forget.js';
import { handleDonorStatus, handleStatusChoice } from '../src/discord/commands/donor-status.js';
import { commandDefinitions } from '../src/discord/definitions.js';
import { USER_A, USER_B, charity, donation, setup, site } from './helpers.js';

class Interaction {
  readonly events: { kind: string; payload: unknown }[] = [];
  readonly user: { id: string };
  member: APIInteractionGuildMember | null = null;
  customId = CLAIM_MODAL_ID;
  input = '123456789/1';
  modal: ModalBuilder | null = null;
  readonly fields = { getTextInputValue: () => this.input };
  // Stale registered commands must not read/bypass consent with this option.
  readonly options = { getString: () => { throw new Error('Old slash option was consumed'); } };
  constructor(userId = USER_A) { this.user = { id: userId }; }
  async reply(payload: InteractionReplyOptions) { this.events.push({ kind: 'reply', payload }); }
  async deferReply(payload: InteractionDeferReplyOptions) { this.events.push({ kind: 'defer', payload }); }
  async editReply(payload: InteractionEditReplyOptions) { this.events.push({ kind: 'edit', payload }); }
  async update(payload: InteractionUpdateOptions) { this.events.push({ kind: 'update', payload }); }
  async showModal(modal: ModalBuilder) {
    this.modal = modal;
    this.customId = modal.toJSON().custom_id;
    this.events.push({ kind: 'modal', payload: modal.toJSON() });
  }
  get text() { return JSON.stringify(this.events); }
}

const stores: Store[] = [];
function fixture() {
  const f = setup((t) => ({
    donations: { '100': donation('100', t.a, 'Accepted', 'C1', null, '123456789') },
    pages: { 'page-one': ['100'] },
  }));
  stores.push(f.store);
  const ctx: AppContext = {
    claimPrompts: new ClaimPrompts(),
    config: {
      discordToken: 'fixture', guildId: '100000000000000000', charity, site,
      justGivingAppId: 'fixture', justGivingApiBase: 'https://api.test',
      publicBaseUrl: 'https://donate.test', port: 0, databasePath: ':memory:',
      sendDmOnSuccess: false, inviteUrl: 'https://discord.gg/example', driveEndsAt: null,
    },
    donations: f.deps, pages: new PageDirectory(f.deps.justGiving, charity), profiles: { getMany: async () => new Map() },
  };
  return { ...f, ctx };
}
afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
});

describe('manual claim consent', () => {
  it('registers /claim with no input option', () => {
    expect(commandDefinitions.find((c) => c.name === 'claim')?.options ?? []).toEqual([]);
  });

  it.each([handleClaim, handleClaimButton])('always asks first, including repeat users and after the deadline', async (entry) => {
    const { ctx, store, discord } = fixture();
    ctx.config.driveEndsAt = new Date(0);
    store.setHiddenFromWall(USER_A, false);
    for (let attempt = 0; attempt < 2; attempt++) {
      const interaction = new Interaction();
      await entry(interaction, ctx);
      expect(interaction.events.map((e) => e.kind)).toEqual(['reply']);
      expect(interaction.text).toContain('donor:claim-show');
      expect(interaction.text).toContain('donor:claim-hide');
      expect(interaction.text).toContain('all your linked donations');
      expect(interaction.events[0]?.payload).toMatchObject({ flags: MessageFlags.Ephemeral });
      expect(interaction.modal).toBeNull();
    }
    expect(discord.calls).toEqual([]);
  });

  it.each([true, false])('saves choice %s, shows modal as first response, then claims', async (hidden) => {
    const { ctx, store, discord } = fixture();
    const interaction = new Interaction();
    await handleClaimChoice(interaction, ctx, hidden);
    expect(interaction.events.map((e) => e.kind)).toEqual(['modal']);
    expect(store.isHiddenFromWall(USER_A)).toBe(hidden);
    expect(interaction.modal?.toJSON().title).toBe('Link your donation');
    await handleClaimModal(interaction, ctx);
    expect(interaction.events.map((e) => e.kind)).toEqual(['modal', 'defer', 'edit']);
    expect(store.getClaim('100')?.discordUserId).toBe(USER_A);
    expect(discord.calls).toHaveLength(1);
    await handleClaimModal(interaction, ctx);
    expect(interaction.text).toContain('expired');
    expect(discord.calls).toHaveLength(1);
  });

  it('keeps the explicit account-wide preference when cancelled or verification fails', async () => {
    const { ctx, store } = fixture();
    const cancelled = new Interaction();
    await handleClaimChoice(cancelled, ctx, true);
    expect(store.isHiddenFromWall(USER_A)).toBe(true);
    const failed = new Interaction();
    failed.input = 'not a receipt';
    await handleClaimChoice(failed, ctx, false);
    await handleClaimModal(failed, ctx);
    expect(store.isHiddenFromWall(USER_A)).toBe(false);
    expect(store.getClaim('100')).toBeNull();
    await handleClaimModal(cancelled, ctx);
    expect(cancelled.text).toContain('expired');
  });

  it('rejects legacy, other-user, expired and forgotten forms without provider/role writes', async () => {
    vi.useFakeTimers();
    const { ctx, store, discord } = fixture();
    const legacy = new Interaction();
    await handleClaimModal(legacy, ctx);
    expect(legacy.text).toContain('expired');

    const owner = new Interaction();
    await handleClaimChoice(owner, ctx, true);
    const other = new Interaction(USER_B);
    other.customId = owner.customId;
    await handleClaimModal(other, ctx);
    expect(other.text).toContain('expired');
    vi.advanceTimersByTime(10 * 60_000);
    await handleClaimModal(owner, ctx);
    expect(owner.text).toContain('expired');

    const forgotten = new Interaction();
    await handleClaimChoice(forgotten, ctx, true);
    await handleForgetChoice(new Interaction(), ctx, true);
    await handleClaimModal(forgotten, ctx);
    expect(forgotten.text).toContain('expired');
    expect(store.getClaimsForUser(USER_A)).toEqual([]);
    expect(discord.calls).toEqual([]);
  });
});

describe('role restoration consent', () => {
  it('does not ask on read-only status; asks before restoring and rechecks the claim', async () => {
    const { ctx, store, tokens, discord } = fixture();
    const noClaims = new Interaction();
    await handleDonorStatus(noClaims, ctx);
    expect(noClaims.text).not.toContain('donor:status-show');
    store.insertClaim({ donationId: '100', discordUserId: USER_A, token: tokens.a, pageShortName: 'page-one', source: 'claim' });
    const active = new Interaction();
    active.member = { user: { id: USER_A, username: 'Fixture', discriminator: '0', avatar: null, global_name: null }, roles: [charity.roleId], joined_at: '2026-01-01T00:00:00Z', deaf: false, mute: false, flags: GuildMemberFlags.CompletedOnboarding, permissions: '0' };
    await handleDonorStatus(active, ctx);
    expect(active.text).not.toContain('donor:status-show');
    const missing = new Interaction();
    await handleDonorStatus(missing, ctx);
    expect(missing.text).toContain('donor:status-show');
    expect(discord.calls).toEqual([]);
    await handleStatusChoice(new Interaction(), ctx, true);
    expect(store.isHiddenFromWall(USER_A)).toBe(true);
    expect(discord.calls).toHaveLength(1);
    store.forgetUser(USER_A);
    await handleStatusChoice(new Interaction(), ctx, false);
    expect(discord.calls).toHaveLength(1);
  });
});
