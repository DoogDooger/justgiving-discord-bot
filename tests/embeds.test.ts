import { describe, expect, it } from 'vitest';
import { WALL_HIDE_ID, WALL_SHOW_ID, wallChoiceButtons } from '../src/discord/commands/donate.js';
import {
  COLORS,
  announcementEmbed,
  brandColor,
  donateEmbed,
  failureEmbed,
  statusEmbed,
  successEmbed,
  thankYouDmEmbed,
  wallChoiceEmbed,
  wallField,
} from '../src/discord/embeds.js';
import { charity, site } from './helpers.js';

describe('embeds', () => {
  it('explains the drive, the reward and the end date on /donate', () => {
    const endsAt = new Date('2027-01-01T00:00:00Z');
    const json = donateEmbed({ charity, site, endsAt }).toJSON();
    expect(json.title).toBe('💖 Charity One charity drive');
    expect(json.color).toBe(0x7c5cff);
    expect(json.description).toContain('Test Community is raising money for **Charity One** until <t:1798761600:D>');
    expect(json.description).toContain(`you'll get the <@&${charity.roleId}> role as a thank you.`);
    expect(json.fields?.map((f) => f.name)).toEqual(['How it works', 'Drive ends', 'Role not added?']);
  });

  it('uses the community\'s own reward wording and accent colour', () => {
    const custom = { ...site, accentColor: '#ff3131', rewardText: "you'll unlock {role} plus extra giveaway entries" };
    const json = donateEmbed({ charity, site: custom, endsAt: null }).toJSON();
    expect(json.color).toBe(0xff3131);
    expect(brandColor(custom)).toBe(0xff3131);
    expect(json.description).toContain(`you'll unlock <@&${charity.roleId}> plus extra giveaway entries.`);
    expect(json.fields?.map((f) => f.name)).toEqual(['How it works', 'Role not added?']);
  });

  it('asks the donor wall question before showing the link', () => {
    const question = wallChoiceEmbed(site, 'https://donate.test/').toJSON();
    expect(question.title).toBe('Before you donate: the donor wall');
    expect(question.description).toContain('either way');
    expect(wallChoiceButtons().toJSON().components).toMatchObject([
      { custom_id: WALL_SHOW_ID, label: 'Show me on the donor wall' },
      { custom_id: WALL_HIDE_ID, label: 'Hide me from the donor wall' },
    ]);
    expect(JSON.stringify(wallChoiceButtons().toJSON())).not.toContain('emoji');
  });

  it('states the choice on the /donate card', () => {
    const shown = donateEmbed({ charity, site, endsAt: null, wallUrl: 'https://donate.test/' }).toJSON();
    expect(shown.fields?.at(-1)).toEqual(wallField('https://donate.test/', false));
    expect(shown.fields?.at(-1)?.value).toContain("You'll be shown");

    const hidden = donateEmbed({ charity, site, endsAt: null, wallUrl: 'https://donate.test/', hiddenFromWall: true }).toJSON();
    expect(hidden.fields?.at(-1)?.value).toContain("You're hidden");
  });

  it('colours outcomes', () => {
    expect(successEmbed(charity, 'added', '100').toJSON().color).toBe(COLORS.success);
    expect(failureEmbed('pending').toJSON().color).toBe(COLORS.warning);
    expect(failureEmbed('already_claimed').toJSON().color).toBe(COLORS.danger);
    expect(statusEmbed(site, charity, null).toJSON().description).toContain('/donate');
    expect(statusEmbed(site, charity, { donations: 2, state: 'active' }).toJSON().description).toContain('2 donations');
    expect(statusEmbed(site, charity, { donations: 1, state: 'failed' }).toJSON().description).toContain("couldn't add the role");
    expect(thankYouDmEmbed(site, charity, '100').toJSON().description).toContain('Test Community');
  });

  it('builds the announcement from settings, with nothing community-specific baked in', () => {
    const json = announcementEmbed({ charity, site, endsAt: null, donateCommand: '</donate:123>' }).toJSON();
    expect(json.title).toBe('💖 Support Charity One, get the donor role');
    expect(json.description).toContain('Test Community is raising money for **Charity One**.');
    expect(json.fields?.[0]?.value).toContain('</donate:123>');
    expect(JSON.stringify(json)).not.toMatch(/perks|badge|limited-time/i);
  });
});
