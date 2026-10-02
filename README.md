# justgiving-discord-bot

A Discord bot for charity drives. Members who donate to your charity through **JustGiving** automatically get a **donor role** in your server, and appear on a public **donor wall**.

- **Donations go straight to the charity through JustGiving.** The bot never sees or handles money or payment details.
- **Fully automatic.** No moderator has to check or approve anything.
- **Yours to brand.** Your community name, colour, logo and wording, set in one file.
- **You run your own copy** on [Fly.io](https://fly.io), with your own Discord bot and your own data.

## What members see

1. They run **`/donate`** in your server. The bot privately asks whether they want to appear on the public donor wall, then shows a card with a **personal JustGiving link**.
2. They donate on JustGiving as normal.
3. JustGiving sends them back to your bot's web page, which confirms the donation and **adds the donor role**. They also get a thank-you DM.

Other commands:

| Command | What it does |
|---|---|
| `/claim` | Links a donation if the automatic step didn't happen (closed tab, slow connection). The member enters the reference from their JustGiving receipt email (it looks like `123456789/1`). There's also an **I've already donated** button under `/donate`. |
| `/donor-status` | Shows how many donations a member has linked, and adds the role back if it's missing. |
| `/donor-wall` | Shows or hides the member on the donor wall. |
| `/donor-forget` | Deletes everything the bot stores about the member, after a confirmation. |

The **website** (your bot's home page) shows the total raised, progress towards your JustGiving target, days left, the top three donors and a wall of recent donors with their Discord names and pictures.

### What counts as a valid donation

A donation only earns the role if **all** of these are true:

1. JustGiving confirms it exists and its status is **Accepted**.
2. It was made with a personal link from `/donate`, belonging to the member getting the role.
3. JustGiving says it went to the charity your page raises money for.
4. It hasn't been claimed before. One donation, one Discord account.

There's no minimum amount beyond JustGiving's own (£2 in the UK). Once a day the bot re-checks claimed donations and removes the role for any that were refunded.

---

## Setup

You'll need:

- A Discord server where you can manage roles.
- A [JustGiving](https://www.justgiving.com) fundraising page for your charity.
- A [Fly.io](https://fly.io) account. The bot costs a few dollars a month to run; Fly asks for a card.
- [Node.js 22 or newer](https://nodejs.org) and [git](https://git-scm.com) on your computer.

Allow about half an hour. Every setting lives in **[`fly.toml`](fly.toml)**; you'll fill it in as you go, and `npm run check-config` tells you in plain English what's still missing.

> **Prefer to be guided?** Give [`SETUP.md`](SETUP.md) to an AI assistant (Claude Code, Cursor, ChatGPT and similar) and say "help me set this up". It asks you the questions below one at a time, fills in the settings and checks each step. It's written so the assistant never asks you to paste your secrets into the chat.

### 1. Get your own copy

1. Click **Use this template → Create a new repository** at the top of this page. A private repository is fine.
2. Download it and install its dependencies:

   ```sh
   git clone https://github.com/YOUR-NAME/YOUR-REPO.git
   cd YOUR-REPO
   npm install
   ```

### 2. Create the Discord bot

1. Go to <https://discord.com/developers/applications> and click **New Application**. The name is what members will see.
2. Open the **Bot** tab:
   - Click **Reset Token** and copy the token. You'll need it in step 4. **Never share it.**
   - Under **Privileged Gateway Intents**, leave **all three switched off**. The bot doesn't need them.
3. In your Discord server, turn on **User Settings → Advanced → Developer Mode**, so you can copy IDs.
4. Create the role donors will get: **Server Settings → Roles → Create Role**. It needs no special permissions.
5. Copy two IDs into `fly.toml`:
   - **`DISCORD_GUILD_ID`**: right-click your server's icon → **Copy Server ID**.
   - **`DONOR_ROLE_ID`**: in **Server Settings → Roles**, right-click the donor role → **Copy Role ID**.

### 3. Set up JustGiving

1. Create a free developer account at <https://developer.justgiving.com>, open **Applications** and copy your **App ID**. You'll need it in step 4.
2. Create your fundraising page on justgiving.com and copy its address into `fly.toml` as **`CHARITY_PAGE`**, for example `https://www.justgiving.com/page/your-page`.

The bot doesn't need your JustGiving password. If the page isn't ready yet, leave `CHARITY_PAGE` empty: the bot still runs and `/donate` says donations aren't open yet.

### 4. Fill in your settings

1. In `fly.toml`, fill in **`CHARITY_NAME`** and **`COMMUNITY_NAME`**. The other branding settings are optional; see [Make it yours](#make-it-yours).
2. Put your two secrets in a local file that is never uploaded:

   ```sh
   cp .env.example .env
   ```

   Open `.env` and paste your Discord token after `DISCORD_TOKEN=` and your App ID after `JUSTGIVING_APP_ID=`.

### 5. Put it on Fly.io

1. Install the [Fly command-line tool](https://fly.io/docs/flyctl/install/) and log in:

   ```sh
   fly auth login
   ```

2. Create your app. Pick a name; it becomes your web address, `https://<name>.fly.dev`:

   ```sh
   fly apps create my-donor-bot
   ```

3. In `fly.toml`, set **`app`** to that name and **`PUBLIC_BASE_URL`** to `https://<name>.fly.dev`. Change `primary_region` if London isn't close to your members.
4. Create the storage for the database (1 GB is plenty):

   ```sh
   fly volumes create donor_data --region lhr --size 1 --yes
   ```

   Use the same region as `primary_region`.

5. Give Fly your two secrets. Type the real values in place of the placeholders:

   ```sh
   fly secrets set --stage DISCORD_TOKEN=paste-token-here JUSTGIVING_APP_ID=paste-app-id-here
   ```

6. Check everything:

   ```sh
   npm run check-config
   ```

   It tests your settings, your Discord token, the JustGiving page and `fly.toml`. It also prints an **invite link** for your bot. At this point it will say the bot isn't in your server yet: open the invite link, add the bot, then in **Server Settings → Roles** drag the bot's role **above** the donor role. Discord only lets a bot give out roles below its own. Run the check again until every line has a ✓.

7. Deploy, then register the slash commands:

   ```sh
   fly deploy --ha=false
   npm run register-commands
   ```

   `--ha=false` tells Fly to run one machine, which is what this bot needs. Later deploys are just `fly deploy`.

Your bot is live. Open `https://<name>.fly.dev` to see your donor wall, and run `/donate` in your server. To test the whole flow, make a small real donation through your own `/donate` link: you should land on a thank-you page and get the role.

### 6. Tell your members

Post the announcement card in a channel (the bot needs **View Channel**, **Send Messages** and **Embed Links** there):

```sh
npm run announce -- CHANNEL_ID
```

Right-click a channel → **Copy Channel ID** to get the ID. To change the post later, run the same command with the message ID added: `npm run announce -- CHANNEL_ID MESSAGE_ID`.

---

## Make it yours

All of these are in the `[env]` block of `fly.toml`. After changing any of them, run `fly deploy`.

| Setting | What it does |
|---|---|
| `COMMUNITY_NAME` | Your community's name, shown in the site header and in Discord messages. |
| `COMMUNITY_URL` | Where the header name or logo links to. Optional. |
| `ACCENT_COLOR` | The colour of buttons, highlights and the Discord cards, as `#rrggbb`. |
| `SITE_LOGO` | A logo to show instead of the name. Put the file in `public/` and set this to its path, e.g. `/logo.svg`. |
| `SITE_PREVIEW_IMAGE` | A 16:9 image shown when your link is shared in Discord or on social media. Put it in `public/`, e.g. `/preview.png`. |
| `SITE_HEADLINE` | The big headline on the website. Default: "Raising money for <charity>". |
| `REWARD_TEXT` | What donors get, shown on the `/donate` card and the website. Write `{role}` where the role should be mentioned. Default: `you'll get the {role} role as a thank you`. |
| `DISCORD_INVITE_URL` | A permanent invite link, shown as the **Join** button on the website. |
| `DRIVE_ENDS_AT` | When the drive ends, in UTC, e.g. `2027-01-01T00:00:00Z`. After that `/donate` says the drive has ended; earlier donations can still be claimed. Empty means no end date. |
| `SEASONAL_THEME` | `true` adds light snow and a festive footer to the website during December. |
| `TIME_ZONE`, `LOCALE` | How dates and numbers are shown, e.g. `Europe/London` and `en-GB`. |
| `SEND_DM_ON_SUCCESS` | Whether donors get a thank-you DM. |

To see your branding without deploying, run `npm run preview:web` and open <http://localhost:4321>. It shows the website with sample donors and doesn't start the Discord bot.

To change the look beyond colours and logo, edit the variables at the top of [`web/styles/global.css`](web/styles/global.css). The pages themselves are in [`web/pages/`](web/pages).

### Your own domain

1. `fly certs add donate.example.org`
2. Add the DNS record Fly shows you. If your DNS is on Cloudflare, leave the proxy **off** (grey cloud).
3. Set `PUBLIC_BASE_URL` in `fly.toml` to `https://donate.example.org` and run `fly deploy`.

The `.fly.dev` address then redirects to your domain, so links already handed out keep working.

---

## Day to day

| I want to… | Do this |
|---|---|
| See what the bot is doing | `fly logs` |
| Check my settings | `npm run check-config` |
| Change a setting | Edit `fly.toml`, then `fly deploy` |
| Change a secret | `fly secrets set DISCORD_TOKEN=new-token` |
| Pause or resume the bot | `fly scale count 0` / `fly scale count 1` |
| Fix a member's role by hand | Give or remove the role in Discord as usual |
| Get updates to this template | Copy the changes you want from the template repository into yours, then `fly deploy` |

### Releasing updates automatically (optional)

The repository includes a GitHub Actions workflow that deploys whenever you push a version tag, so you don't have to run `fly deploy` yourself.

1. Create a deploy token that can only deploy this app: `fly tokens create deploy --expiry 8760h`
2. In your GitHub repository, open **Settings → Secrets and variables → Actions → New repository secret**, name it `FLY_API_TOKEN` and paste the token.
3. To release: `git tag -a v1.0.1 -m "Release v1.0.1"` then `git push origin v1.0.1`. GitHub runs the tests and deploys.

If you add or change a slash command, run `npm run register-commands` after the deploy.

### Troubleshooting

- **`check-config` says the bot's role must be above the donor role:** drag the bot's role higher in **Server Settings → Roles**.
- **The commands don't appear in Discord:** run `npm run register-commands`, then press Ctrl+R in Discord.
- **`/donate` says donations aren't open yet:** `CHARITY_PAGE` is empty or wrong. `npm run check-config` tells you which.
- **"We couldn't match this donation to our charity":** JustGiving can take a few seconds to list a new donation. The bot retries for about ten seconds; after that, the donor can press **Try again** on the page or **I've already donated** in Discord.
- **"Your role is on its way" but no role yet:** normal when many people donate at once. Discord limits how fast roles can be added, so the bot works through a queue. `/donor-status` adds the role straight away.
- **A member donated without using `/donate`:** the bot can't tell which Discord account made that donation. Give them the role by hand.
- **The bot answers twice, or oddly:** two copies are running with the same token, for example one on your computer and one on Fly. Stop one of them.

---

## Privacy

The bot stores, in a database on your Fly volume:

- Discord user IDs, each with a personal donation code.
- The JustGiving donation IDs each member has linked.
- Whether a member has hidden themselves from the donor wall.
- A log of what the bot did (roles given, checks failed).

It does **not** store names, emails, addresses, payment details or donation amounts. The top donors list reads public amounts from JustGiving and keeps them in memory for five minutes; donors who hid their amount on JustGiving aren't ranked. `/donor-forget` deletes everything the bot holds about a member.

You are responsible for the data your copy of the bot holds. Tell your members what it stores; the website's footer does this by default.

## For developers

```sh
npm run typecheck        # TypeScript, source and tests
npm test                 # unit tests (JustGiving and Discord are faked)
npm run dev              # the bot and website on http://localhost:3000, using fly.toml + .env
npm run preview:web      # the website only, with sample data
```

- **Stack:** Node.js 22, TypeScript, discord.js (with no privileged or gateway intents), Express, Astro for the web pages, SQLite.
- **One process** runs the bot and the website, on a single Fly machine. Don't scale beyond one: the database and the Discord connection can't be shared.
- **Settings** come from `fly.toml`'s `[env]` block, overridden by `.env` on your computer. On Fly they arrive as environment variables plus the two secrets. See [`src/config.ts`](src/config.ts).
- **Code map:** [`src/verification.ts`](src/verification.ts) (the rules for accepting a donation), [`src/donations.ts`](src/donations.ts) (verify, record, give the role; the role queue; the refund re-check), [`src/justgiving.ts`](src/justgiving.ts) (JustGiving links and API), [`src/db.ts`](src/db.ts) (storage), [`src/discord/`](src/discord) (commands and message cards), [`src/web/`](src/web) (web server and the data the pages use), [`web/`](web) (the Astro pages and styles).
- **Don't run the bot on your computer while the live one is running** with the same token: both would answer commands.
- See [AGENTS.md](AGENTS.md) for the rules the code follows.

This project isn't affiliated with or endorsed by JustGiving or Discord.

## Licence

[MIT](LICENSE). Use it, change it, share it.
