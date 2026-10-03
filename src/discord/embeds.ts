import { EmbedBuilder } from 'discord.js';
import type { CharityConfig, SiteConfig } from '../config.js';
import type { RoleOutcome } from '../donations.js';
import { failureMessage, isRetryable } from '../messages.js';
import type { FailureReason } from '../verification.js';

/** Side-bar colours for outcomes. The drive's own colour comes from ACCENT_COLOR (see brandColor). */
export const COLORS = {
  success: 0x3ba55d,
  warning: 0xf0b232,
  danger: 0xed4245,
  neutral: 0x5865f2,
} as const;

/** The community's accent colour as the number Discord embeds expect. */
export function brandColor(site: Pick<SiteConfig, 'accentColor'>): number {
  return Number.parseInt(site.accentColor.slice(1), 16);
}

const FOOTER = 'Donations go straight to the charity through JustGiving. This bot never sees your payment details.';

const role = (charity: CharityConfig) => `<@&${charity.roleId}>`;
const discordDate = (date: Date, style: 'D' | 'R' | 'f') => `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;

/** The reward line from REWARD_TEXT, with "{role}" turned into the role mention. */
export function rewardLine(site: Pick<SiteConfig, 'rewardText'>, charity: CharityConfig): string {
  return site.rewardText.replaceAll('{role}', role(charity));
}

export function donateEmbed(options: {
  charity: CharityConfig;
  site: SiteConfig;
  endsAt: Date | null;
  /** Public donor wall (the web home page). */
  wallUrl?: string;
  /** Whether this user has hidden themselves from the wall. */
  hiddenFromWall?: boolean;
}): EmbedBuilder {
  const { charity, site, endsAt, wallUrl, hiddenFromWall = false } = options;
  const until = endsAt ? ` until ${discordDate(endsAt, 'D')}` : '';

  const embed = new EmbedBuilder()
    .setColor(brandColor(site))
    .setFooter({ text: FOOTER })
    .setTitle(`💖 ${charity.name} charity drive`)
    .setDescription([`${site.communityName} is raising money for **${charity.name}**${until}.`, '', `Donate **any amount** and ${rewardLine(site, charity)}.`].join('\n'));

  embed.addFields({
    name: 'How it works',
    value: [
      `**1.** Tap **Donate** below. It opens JustGiving with a link that's personal to you, so don't share it.`,
      '**2.** Give any amount (JustGiving has a small minimum, £2 in the UK).',
      "**3.** You'll be brought back to a page that confirms your donation, and your role is added automatically.",
    ].join('\n'),
  });

  if (endsAt) embed.addFields({ name: 'Drive ends', value: `${discordDate(endsAt, 'f')} (${discordDate(endsAt, 'R')})`, inline: true });
  embed.addFields({ name: 'Role not added?', value: "Tap **I've already donated** and enter the reference from your JustGiving receipt email.", inline: true });
  if (wallUrl) embed.setURL(wallUrl).addFields(wallField(wallUrl, hiddenFromWall));

  return embed;
}

/** The donor wall line on the /donate card: states what the donor just chose. */
export function wallField(wallUrl: string, hidden: boolean): { name: string; value: string } {
  return {
    name: 'Donor wall',
    value: hidden
      ? `**You're hidden.** Your name and picture won't appear on the [public donor wall](${wallUrl}) or in the top donors list. Your donation still counts and you still get the role.`
      : `**You'll be shown** on the [public donor wall](${wallUrl}) with your Discord name and picture. Changed your mind? Run \`/donate\` again and choose Hide.`,
  };
}

/** Asked on every /donate, before the donation link is shown. */
export function wallChoiceEmbed(site: SiteConfig, wallUrl: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(brandColor(site))
    .setTitle('Before you donate: the donor wall')
    .setURL(wallUrl)
    .setDescription(
      [
        `Would you like to appear on our [public donor wall](${wallUrl})?`,
        '',
        'Donors are shown there with their **Discord name and picture**. The three biggest givers are also listed with their total, but only if the amount is public on JustGiving.',
        '',
        'Your donation counts and you get the role **either way**.',
        'This choice updates **all your linked donations**, now and in future, immediately—even if you cancel the form. Change it any time with /donor-wall.',
      ].join('\n'),
    )
    .setFooter({ text: 'Pick one to get your donation link.' });
}

export function successEmbed(charity: CharityConfig, result: RoleOutcome, donationId: string): EmbedBuilder {
  const description =
    result === 'added'
      ? `Your ${role(charity)} role has been added. Thank you for your support.`
      : result === 'queued'
        ? `Your donation is confirmed and your ${role(charity)} role is on its way. Lots of people are donating right now, so it can take a few minutes to appear. You don't need to do anything.`
        : result === 'not_member'
          ? `Your donation is recorded. Join the server, then run \`/donor-status\` to get your ${role(charity)} role.`
          : `Your donation is recorded, but the ${role(charity)} role couldn't be added just now. Run \`/donor-status\` in a minute to try again.`;
  return new EmbedBuilder()
    .setColor(COLORS.success)
    .setTitle(`✅ Thank you for supporting ${charity.name}!`)
    .setDescription(description)
    .setFooter({ text: `Donation ${donationId}` });
}

export function thankYouDmEmbed(site: SiteConfig, charity: CharityConfig, donationId: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(brandColor(site))
    .setTitle(`💖 Thank you for supporting ${charity.name}!`)
    .setDescription(`Your donation has been confirmed and your donor role has been added in ${site.communityName}.`)
    .setFooter({ text: `Donation ${donationId}` });
}

export function failureEmbed(reason: FailureReason): EmbedBuilder {
  const { title, text } = failureMessage(reason);
  const retry = isRetryable(reason);
  return new EmbedBuilder()
    .setColor(retry ? COLORS.warning : COLORS.danger)
    .setTitle(`${retry ? '⏳' : '❌'} ${title}`)
    .setDescription(text);
}

export function driveEndedEmbed(site: SiteConfig): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(brandColor(site))
    .setTitle('💖 The charity drive has ended')
    .setDescription(
      "Thank you to everyone who donated! New donations no longer unlock the role. If you donated before the drive ended and your role is missing, tap **I've already donated** or run `/donor-status`.",
    );
}

export function notOpenEmbed(): EmbedBuilder {
  const { title, text } = failureMessage('not_configured');
  return new EmbedBuilder().setColor(COLORS.neutral).setTitle(`🕒 ${title}`).setDescription(text);
}

export function genericErrorEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLORS.danger)
    .setTitle('❌ Something went wrong')
    .setDescription("That didn't work on our side. Try again in a minute.");
}

export interface StatusRow {
  donations: number;
  state: 'active' | 'restored' | 'failed';
}

/** row is null when the member hasn't linked a donation yet. */
export function statusEmbed(site: SiteConfig, charity: CharityConfig, row: StatusRow | null): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(brandColor(site)).setTitle('💖 Your donor status');
  if (!row) {
    return embed.setDescription("You haven't linked a donation yet. Run `/donate` to join the charity drive and get the role.");
  }
  const stateText = { active: '✅ role active', restored: '✅ role added back', failed: "⚠️ couldn't add the role, try again in a minute" };
  return embed
    .setDescription(`**${charity.name}** ${role(charity)}\n${row.donations} donation${row.donations === 1 ? '' : 's'} · ${stateText[row.state]}`)
    .setFooter({ text: 'Missing a role? Run /donor-status, then choose Show or Hide to restore it.' });
}

/**
 * The public announcement posted by `npm run announce`. `donateCommand` is the clickable
 * command mention (or plain "/donate" if the command ID isn't known).
 */
export function announcementEmbed(options: { charity: CharityConfig; site: SiteConfig; endsAt: Date | null; donateCommand: string }): EmbedBuilder {
  const { charity, site, endsAt, donateCommand } = options;
  const until = endsAt ? ` until ${discordDate(endsAt, 'D')}` : '';
  return new EmbedBuilder()
    .setColor(brandColor(site))
    .setTitle(`💖 Support ${charity.name}, get the donor role`)
    .setDescription(`${site.communityName} is raising money for **${charity.name}**${until}. Donate **any amount** and ${rewardLine(site, charity)}.`)
    .addFields({
      name: 'How to get it',
      value: [
        `**1.** Run ${donateCommand} to get your personal JustGiving link`,
        '**2.** Donate any amount (JustGiving has a small minimum, £2 in the UK)',
        '**3.** Your role is added automatically, usually within seconds',
      ].join('\n'),
    })
    .setFooter({ text: `Every penny goes straight to ${charity.name} through JustGiving. We never see your payment details.` });
}
