# Guided setup (for an AI assistant)

**If you're a person:** give this file to an AI assistant and say "help me set this up". It works best with a coding assistant that can read this repository and run commands on your computer (Claude Code, Cursor, Copilot and similar). A chat assistant without that access also works: paste this file in, and it will tell you what to type. If you'd rather follow the steps yourself, use the [README](README.md) instead.

**If you're the AI assistant:** the rest of this file is your brief. Read it all before you start.

---

## Your job

Guide the owner of a Discord community through setting up their own copy of this bot, from an untouched copy of this repository to a live bot that gives members a donor role when they donate through JustGiving. You're done when the checklist in [Finished](#finished) is true.

The person you're helping can copy commands into a terminal and edit a text file, but has probably never deployed anything. Assume no knowledge of Fly.io, Discord's developer portal or JustGiving's API.

Read [README.md](README.md) for the full picture and [AGENTS.md](AGENTS.md) for the rules of the codebase. This file tells you how to run the conversation.

## How to work

- **Ask, don't assume.** Ask one small group of questions at a time, wait for the answers, then move on. Never invent a value to keep things moving.
- **Plain language.** Say where to click, in order. Give each ID or value a one-line "where to find this".
- **One settings file.** Every non-secret setting goes in the `[env]` block of `fly.toml`. Don't put settings anywhere else, and don't change code to customise the bot.
- **Check as you go.** `npm run check-config` validates everything and explains problems in plain English. Run it after each stage and act on what it says, rather than guessing.
- **If you can edit files and run commands,** do so for them, and say what you did. **If you can't,** give one command or one edit at a time, in a code block, and ask them to paste back the output.
- **Stop when something fails.** Read the error, explain it simply and fix the cause. Don't retry blindly or work around a failing check.

### Things you must never do

- **Never ask for, repeat or store a secret in the conversation.** There are two: the Discord bot token and the JustGiving App ID. The owner types them into `.env` and into the `fly secrets set` command themselves. If they paste one into the chat anyway, tell them to reset it (Discord: **Bot → Reset Token**) and use the new one.
- **Never print `.env`** or any command output that contains a secret.
- **Never create accounts, enter payment details or log in for them.** They sign in to Discord, JustGiving, GitHub and Fly.io themselves. `fly auth login` opens their browser.
- **Never commit `.env`.** It's already git-ignored; leave it that way.
- **Don't turn on any Privileged Gateway Intents** for the Discord bot. It needs none.

### Things to confirm before doing

Say what's about to happen and wait for a clear yes before each of these:

- **Anything that costs money:** `fly apps create`, `fly volumes create`, `fly deploy`. The bot costs a few dollars a month on Fly.io, and Fly needs a payment card on the account.
- **Anything public:** `npm run announce`, which posts a message in their Discord server.
- **Anything that deletes:** destroying a Fly app, machine or volume.

## Before you start

Check these, and help with whichever is missing:

1. They have **their own copy** of this repository on their computer (created with **Use this template** on GitHub, then `git clone`). If they're working in the original template repository, stop and help them make their own copy first.
2. **Node.js 22 or newer** (`node --version`) and **git** are installed.
3. `npm install` has been run in the project folder.
4. They have, or are willing to create: a Discord server where they can manage roles, a JustGiving account, and a Fly.io account.

## The conversation

Work through these stages in order. Each lists what to ask and what to write down.

### Stage 1: The drive

Ask:

1. What's your community called, as you'd like it shown?
2. Which charity are you raising money for, as you'd like it shown?
3. Do you already have a JustGiving fundraising page for it? If so, what's its address?
4. Does the drive have an end date? If so, when, and in which time zone?

Write to `fly.toml`: `COMMUNITY_NAME`, `CHARITY_NAME`, `CHARITY_PAGE` (leave empty if there's no page yet), `DRIVE_ENDS_AT` and `TIME_ZONE`.

`DRIVE_ENDS_AT` is in UTC, in the form `2027-01-01T00:00:00Z`. Convert from their time zone and tell them what you wrote. For "until the end of 31 December" in the UK, that's `2027-01-01T00:00:00Z`.

If they have no JustGiving page yet: they create one on justgiving.com (**Start fundraising**, choose the charity). The bot can be set up first and the page added later; until then `/donate` says donations aren't open yet.

### Stage 2: The Discord bot

Walk them through this, one step at a time:

1. At <https://discord.com/developers/applications>, click **New Application** and name it. Members will see this name.
2. On the **Bot** tab, click **Reset Token** and copy the token somewhere safe for Stage 4. Leave all three **Privileged Gateway Intents** off.
3. In Discord, turn on **User Settings → Advanced → Developer Mode**.
4. In **Server Settings → Roles**, create the role donors will receive. It needs no special permissions.

Then ask for these two IDs, which are not secret:

1. Server ID: right-click the server icon → **Copy Server ID**.
2. Donor role ID: **Server Settings → Roles**, right-click the role → **Copy Role ID**.

Also ask whether they have a permanent invite link to the server, for the website's **Join** button.

Write to `fly.toml`: `DISCORD_GUILD_ID`, `DONOR_ROLE_ID`, and `DISCORD_INVITE_URL` if they gave one.

### Stage 3: JustGiving access

1. They create a free developer account at <https://developer.justgiving.com>.
2. On the **Applications** tab, they copy the **App ID** somewhere safe for Stage 4.

The bot doesn't need their JustGiving password, and you must not ask for it.

### Stage 4: Secrets

1. Create the local secrets file: copy `.env.example` to `.env`.
2. Ask them to open `.env` themselves and paste the Discord token after `DISCORD_TOKEN=` and the App ID after `JUSTGIVING_APP_ID=`, then save.
3. Ask them to tell you when it's done. Don't read the file to check; `npm run check-config` will tell you whether the values work.

### Stage 5: Branding (optional)

Tell them the defaults are a dark theme with a purple accent and their community name as text, and that all of this can be changed later. Then ask which of these they want to set now:

1. An accent colour, as a hex code like `#ff3131`? → `ACCENT_COLOR`
2. A logo to show instead of the name? → they put the file in `public/`, and you set `SITE_LOGO` to its path, e.g. `/logo.svg`
3. An image for link previews, 16:9? → file in `public/`, `SITE_PREVIEW_IMAGE`, e.g. `/preview.png`
4. A different headline from "Raising money for <charity>"? → `SITE_HEADLINE`
5. What do donors get? The default is "you'll get the {role} role as a thank you". If they offer more, write one short line for `REWARD_TEXT` that reads naturally after "Donate any amount and…", keeping `{role}` where the role should be mentioned. Don't promise anything they didn't say.
6. A link for the header name or logo? → `COMMUNITY_URL`
7. How dates and numbers should be shown? → `LOCALE`, e.g. `en-GB` or `en-US`
8. Light snow and a festive footer in December? → `SEASONAL_THEME = "true"`

Offer to show the result: `npm run preview:web`, then open <http://localhost:4321>. It uses sample donors and doesn't connect to Discord.

### Stage 6: Fly.io

1. They install the Fly command-line tool (<https://fly.io/docs/flyctl/install/>) and run `fly auth login`. Fly will ask them to add a payment card.
2. Ask what to call the app. The name must be unique on Fly, uses lowercase letters, numbers and hyphens, and becomes the address `https://<name>.fly.dev`.
3. Ask which region is closest to most of their members. `lhr` is London; `fly platform regions` lists the rest.
4. With their go-ahead, create the app: `fly apps create <name>`. If the name is taken, ask for another.
5. In `fly.toml`, set `app` to the name, `primary_region` to the region, and `PUBLIC_BASE_URL` to `https://<name>.fly.dev`.
6. With their go-ahead, create the database volume in the same region: `fly volumes create donor_data --region <region> --size 1 --yes`.
7. Ask them to run this themselves, replacing the placeholders with their real values, so the secrets never pass through you:

   ```sh
   fly secrets set --stage DISCORD_TOKEN=paste-token-here JUSTGIVING_APP_ID=paste-app-id-here
   ```

### Stage 7: Check, invite, deploy

1. Run `npm run check-config`. Fix every line marked ✗. Expect it to say the bot isn't in the server yet.
2. The check prints an **invite link**. They open it, choose their server and authorise. The link asks only for the Manage Roles permission.
3. In **Server Settings → Roles**, they drag the bot's role **above** the donor role. Discord only lets a bot give out roles below its own.
4. Run `npm run check-config` again. Continue only when every line has a ✓.
5. With their go-ahead, deploy: `fly deploy --ha=false`. The first build takes a few minutes. `--ha=false` makes Fly run a single machine, which this bot requires; later deploys are plain `fly deploy`. If `fly status` ever shows two machines, remove one with `fly scale count 1`.
6. Register the slash commands: `npm run register-commands`.
7. Check it started: `fly logs` should show the bot logged in, that it can manage the donor role, and the JustGiving page it found.

### Stage 8: Try it

Ask them to do these, and to tell you what they see:

1. Open `https://<name>.fly.dev`. The donor wall page should load with their branding.
2. Run `/donate` in their server. If the commands don't appear, they press Ctrl+R in Discord. The bot should ask about the donor wall, then show a card with a donate button.
3. If they're willing to make a small real donation through that button: they should land on a thank-you page, get the donor role, and appear on the donor wall within a minute.

Then offer the announcement. With their go-ahead, and once the bot has **View Channel**, **Send Messages** and **Embed Links** in the chosen channel: `npm run announce -- <channel-id>`.

### Optional extras

Offer these at the end; don't push them.

- **Their own domain:** README, "Your own domain".
- **Automatic deploys from GitHub:** README, "Releasing updates automatically". The deploy token goes into a GitHub repository secret, which they paste in themselves.
- **Saving their settings:** `git add fly.toml public/` then commit and push to their own repository. `fly.toml` contains no secrets. Check `git status` first to be sure `.env` isn't listed.

## When things go wrong

| What you see | What it means |
|---|---|
| `… still has its example value` | A `CHANGE-ME` in `fly.toml` hasn't been replaced. |
| `Discord check failed. Is DISCORD_TOKEN correct?` | The token in `.env` is wrong or was reset. They paste the current one. |
| `The bot is not in the Discord server` | They haven't used the invite link yet, or `DISCORD_GUILD_ID` is a different server. |
| `The bot's role must be above "<role>"` | Drag the bot's role higher in **Server Settings → Roles**. |
| `JustGiving rejected the App ID` | `JUSTGIVING_APP_ID` in `.env` is wrong. |
| `JustGiving page "…" was not found` | `CHARITY_PAGE` isn't the address of a live fundraising page. |
| `fly apps create` says the name is taken | App names are shared across all of Fly. Pick another. |
| `fly` isn't recognised after installing | They open a new terminal window. |
| `/donate` says donations aren't open yet | `CHARITY_PAGE` is empty. Set it, then `fly deploy`. |
| The commands don't appear in Discord | Run `npm run register-commands`, then Ctrl+R in Discord. |

For anything else, see the README's troubleshooting section, and `fly logs` for what the live bot is doing.

## Finished

Setup is complete when all of these are true. Tell the owner which you've confirmed and which they confirmed for you:

- `npm run check-config` shows a ✓ on every line.
- `fly status` shows one machine, started, with its health check passing.
- `https://<name>.fly.dev` loads their donor wall.
- `/donate` works in their server.
- They know that settings live in `fly.toml` and take effect with `fly deploy`, and that secrets are changed with `fly secrets set`.

Finish with a short summary: their web address, the commands members can use, and where to look if something breaks (`fly logs`, `npm run check-config`, the README).
