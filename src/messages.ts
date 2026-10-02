import type { FailureReason } from './verification.js';

/** Plain-English explanation for each failure, shared by Discord replies and the web page. */
export function failureMessage(reason: FailureReason): { title: string; text: string } {
  switch (reason) {
    case 'invalid_donation_id':
      return {
        title: "That doesn't look like a receipt reference",
        text: 'Enter the reference from your JustGiving receipt email. It is a number that looks like 123456789/1.',
      };
    case 'invalid_token':
      return {
        title: 'This link is incomplete',
        text: 'Something was missing from the link JustGiving sent you back with. Use /claim with the reference from your JustGiving receipt email.',
      };
    case 'not_configured':
      return {
        title: "Donations aren't open yet",
        text: "The charity drive isn't open yet. Please check back soon.",
      };
    case 'already_claimed_by_you':
      return {
        title: "You've already claimed this donation",
        text: 'This donation is already linked to your account. If your role is missing, run /donor-status in the server.',
      };
    case 'already_claimed':
      return {
        title: 'This donation has already been claimed',
        text: 'Each donation can only be linked to one Discord account. If you think this is wrong, ask a moderator.',
      };
    case 'donation_not_found':
      return {
        title: "We couldn't find that donation on our page",
        text: "No donation on our JustGiving page has that reference. Check it against your receipt email (it looks like 123456789/1). If you've only just donated, wait a few minutes and try /claim again. A donation made to a different JustGiving page can't be linked here.",
      };
    case 'missing_reference':
      return {
        title: "This donation wasn't made through /donate",
        text: "We can only match donations made with your personal link from /donate. Next time, run /donate first. If you need help, ask a moderator.",
      };
    case 'reference_mismatch':
      return {
        title: "This donation doesn't match your link",
        text: "The donation wasn't made with a link from this bot. Run /donate to get your personal link. If you need help, ask a moderator.",
      };
    case 'not_your_reference':
      return {
        title: 'This donation belongs to someone else',
        text: "It was made with another member's personal link, so it can only be claimed by them.",
      };
    case 'pending':
      return {
        title: 'Your donation is still processing',
        text: 'JustGiving is still processing your donation. Try /claim with your receipt reference again in a few minutes.',
      };
    case 'not_accepted':
      return {
        title: "This donation didn't go through",
        text: 'JustGiving shows this donation as not completed (for example cancelled, rejected or refunded), so it can\'t be used for a role.',
      };
    case 'after_deadline':
      return {
        title: 'This donation was made after the drive ended',
        text: 'Only donations made before the drive ended unlock the donor role. Your donation still supports the charity.',
      };
    case 'wrong_page':
      return {
        title: "We couldn't match this donation to our charity",
        text: "It doesn't match our JustGiving page yet. If you've only just donated, wait a minute and try /claim again.",
      };
    case 'api_error':
      return {
        title: "We couldn't reach JustGiving",
        text: 'JustGiving didn\'t respond properly. Please try /claim again in a few minutes. Your donation is safe.',
      };
  }
}

/** Failures worth retrying later (shown with a "try again" tone rather than a hard failure). */
export function isRetryable(reason: FailureReason): boolean {
  return reason === 'pending' || reason === 'api_error' || reason === 'donation_not_found' || reason === 'wrong_page';
}
