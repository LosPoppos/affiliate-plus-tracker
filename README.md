# Affiliate Plus Tracker – Twitch / OBS

A very small OBS browser source modeled after Twitch's own Plus Program goal styling.

## Goal

The broadcaster authenticates once. The app then creates a read-only public OBS URL.

Streamer workflow:

1. Open `/`
2. Click **Mit Twitch verbinden**
3. Authorize Twitch
4. Enter the current Plus Points shown in Twitch (only needed once when bootstrapping)
5. Choose title, subtitle, target, and optional Twitch emote/image
6. Click **Speichern & OBS-Link erzeugen**
7. Paste the generated `/o/<public-key>` URL into an OBS Browser Source

The overlay itself shows only:

- icon
- title
- current/target
- subtitle
- progress bar

Default dimensions: 420 × 80 px.

## Why this uses a backend

GitHub Pages alone is static. Twitch EventSub subscription tracking and OAuth token handling require server-side infrastructure.

Recommended simple deployment:

- GitHub = repository / source control
- Cloudflare Worker = app + Twitch OAuth/EventSub webhook
- Cloudflare D1 = small database

This gives the streamer one stable OBS URL and keeps OAuth credentials out of OBS.

## Twitch rules implemented

Current Twitch Plus Program documentation:

- Level 1: 100+ Plus Points in each of 3 consecutive months
- Tier 1 = 1 Plus Point
- Tier 2 = 2 Plus Points
- Tier 3 = 6 Plus Points
- paid recurring subscriptions count
- gift subscriptions do not count towards Plus Points
- Prime subscriptions do not count
- Prime/gift -> paid upgrade counts in the month the paid recurring period begins
- points are evaluated/reset by calendar month at UTC

This project shows the **current month's point total only**, which matches the simple Twitch-style goal in the supplied screenshot.

## Deployment

Prerequisites:

- Twitch Developer application
- Cloudflare account
- Node.js + npm

### 1. Create Twitch app

In Twitch Developer Console:

OAuth Redirect URL:

`https://YOUR-WORKER-DOMAIN/auth/callback`

Keep the Client Secret private.

The app requests these scopes:

`channel:read:subscriptions user:read:chat user:bot channel:bot`

### 2. Create Cloudflare D1

Create a database called:

`affiliate_plus_tracker`

Run `schema.sql`:

`npx wrangler d1 execute affiliate_plus_tracker --remote --file=./schema.sql`

Copy the D1 database ID into `wrangler.toml`.

### 3. Set worker variables/secrets

Set:

`TWITCH_CLIENT_ID`
`TWITCH_CLIENT_SECRET`
`TOKEN_ENCRYPTION_KEY`
`EVENTSUB_SECRET`

TOKEN_ENCRYPTION_KEY should be a random 32-byte key encoded as Base64.

Example:

`openssl rand -base64 32`

EVENTSUB_SECRET can be any random 32+ character secret, for example:

`openssl rand -hex 32`

Also replace:

`PUBLIC_BASE_URL = "https://YOUR-WORKER-DOMAIN"`

### 4. Deploy

`npm install`

`npx wrangler deploy`

The app serves both the setup page and the OBS overlay.

## Important: EventSub

The app creates these EventSub subscriptions for each authorized broadcaster:

- channel.chat.notification
- channel.subscribe
- channel.subscription.message
- channel.subscription.end
- channel.subscription.gift

The point calculation itself is driven by `channel.chat.notification`, because its subscription notice payload distinguishes paid recurring subscriptions from Prime and gift cases.

The other subscription types are intentionally not added to the points total, avoiding double counting.

## Current-month bootstrap

Twitch does not expose the historical Plus Program point total as a normal public Helix field.

Therefore the streamer enters their current Plus Point total once during setup. From that point forward, the app increments the current UTC calendar month based on Twitch events.

## Custom icon

Three choices:

- Star (default)
- Twitch emote ID
- Any HTTPS/HTTP image URL

Twitch emote ID example:

`25`

This resolves to the Twitch CDN URL for Kappa. Channel-specific emotes can also be supplied by image URL.

## Security

- Twitch Client Secret stays server-side.
- OAuth access/refresh tokens are encrypted before D1 storage.
- The public OBS URL contains only a random read-only public key.
- EventSub webhook requests are verified using Twitch's message signature.
