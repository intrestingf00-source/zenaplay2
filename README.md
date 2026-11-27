# 💣 Time Bomb Games

A games menu with two realtime wallet games:

- **Time Bomb** (`/game`) — a game of chicken. The fuse starts at 30s; every fixed-fee push
  grows the pot and resets the fuse. When it hits 00:00 nobody can push anymore and the
  last depositor takes **90%** of the pot — the house keeps **10%**.
- **Crash** (`/crash`) — a shared rocket. Bets open for a few seconds, then the multiplier
  climbs; cash out before it flies away and keep `bet × multiplier`. The crash point is
  provably fair (commit hash before, seed after) and the house edge is configurable.

- **Player apps** (`/`, `/game`, `/crash`): mobile-first Telegram Mini Apps. No sign-up or password — the player's Telegram name is the account. Live countdown ring, pot, last depositor, live push feed, animated crash chart, auto cash-out, wallet, leaderboard, round history.
- **Admin panel** (`/admin`): a menu on the left (Overview / Time Bomb / Crash / Deposits / Players / Bomb rounds). The Overview lists every game with its live state, a pause switch, Manage and Play. Inside a game: pause/resume, force-settle, cancel & refund, manual round start, live settings (fee, fuse, house cut) or **Crash settings (min/max bet, betting window, house edge, pause, crash now)**; plus deposit requests, **deposit / withdraw player wallets**, bans, round history and house earnings.
- **English / አማርኛ** toggle on every page; the choice is remembered per device.
- **Realtime** over Socket.IO; timers and money are settled by the server only.
- **Storage** MongoDB via `MONGODB_URI`, with an in-memory fallback for local play.

## Project layout

```
time-bomb/
  server.js               # app boot, sockets, static mounts
  src/
    engine.js             # authoritative fuse + settlement
    crash.js              # authoritative crash rounds, provably-fair points
    db.js                 # MongoDB / memory storage
    auth.js               # Telegram initData verification, sessions, admin password
    http.js               # async wrapper, rate limiting, JSON errors
    routes/
      game.js             # /api  — players
      crash.js            # /api/crash — crash bets and cash-outs
      admin.js            # /api/admin — admin panel
  public/
    menu/                 # games menu (root)
    game/                 # Time Bomb: index.html, app.js, style.css
    crash/                # Crash: index.html, app.js, style.css
    admin/                # admin app:  index.html, admin.js, admin.css
    shared/i18n.js        # English + Amharic dictionary and toggle
```

The two apps share only the API and the `shared/` dictionary — no shared page or
stylesheet — so each can be changed or deployed separately.

## Languages

Every visible string goes through `public/shared/i18n.js` (`window.I18n.t(key)`),
with static markup marked by `data-i18n`, `data-i18n-ph` or `data-i18n-html`.
Both tables hold the same keys; add a key to **both** `en` and `am` when you
introduce new text. Server errors return a stable `code` (for example
`insufficient_funds`) which the clients translate too. Bump the `?v=` query on
the scripts in both `index.html` files when you change JS so cached phones pick
it up.

## Run locally

```bash
cd time-bomb
cp .env.example .env      # optional: fill MONGODB_URI / ADMIN_PASSWORD
npm install
npm start
```

Open http://127.0.0.1:3000 (games menu), http://127.0.0.1:3000/game (Time Bomb),
http://127.0.0.1:3000/crash (Crash) and http://127.0.0.1:3000/admin.
Without `ADMIN_PASSWORD` the server prints a temporary admin password in the console.
Without `MONGODB_URI` it runs in memory mode (data resets on restart).
Without `TELEGRAM_BOT_TOKEN` the game can still be opened in a normal browser for local
testing and gets a “Local Player” account per browser (`?name=Abebe` overrides the name).

## Telegram Mini App setup

The player page is meant to run inside Telegram. Telegram passes a signed `initData`
payload, the server verifies it with `TELEGRAM_BOT_TOKEN`, and the Telegram profile
name / id become the player account. There is nothing for the player to type.

1. In **@BotFather**: `/newbot` (or pick your bot) → copy the **API token** into
   `TELEGRAM_BOT_TOKEN`.
2. Deploy this app over **HTTPS** (Telegram refuses plain HTTP Mini Apps).
3. `/newapp` in @BotFather (or **Bot Settings → Menu Button**) and point the Web App URL
   at `https://your-domain/`.
4. Open the bot in Telegram and tap the menu button. Accounts are created automatically
   the first time each Telegram user opens the game.

Server-side safety: the HMAC hash and the `auth_date` (max 24h) are both checked, so a
forged `initData` is rejected. With a bot token configured, sign-in accepts Telegram
payloads only. Old username/password accounts from earlier versions are not linked to
a Telegram id and are effectively retired.

## Topping up player wallets

Players have no payment gateway; the admin funds them. In `/admin` → **Players**, search
by name or Telegram ID (the ID is shown under each name), press **Deposit**, type the
amount and confirm. **Withdraw** takes money back out but never below zero.

## Crash — cash out before it flies away

One round for everybody: a betting window (`betSeconds`, default 7s), then the
multiplier climbs from 1.00x until the round crashes. A player may cash out at any
moment while the round is running and is paid `floor(bet × multiplier)`; auto cash-out
fires at the chosen multiplier. Bets are taken from the wallet when placed and refunded
if the player cancels during the betting window.

**Provably fair.** Before each round the server generates a random seed, publishes its
SHA-256 commit, and derives the crash point from `HMAC-SHA256(seed, roundNo)`. After the
crash it reveals the seed, so anyone can recompute the result. The clients show the
commit while betting and the seed after the crash (with a copy button).

**House edge.** `houseEdge` (default 5%) is applied directly in the crash distribution:
`P(crash ≥ m) = (1 − edge) / m`. Cashing out at any target therefore returns
`1 − edge` of the stake in expectation, and house profit per round is
`stakes − payouts`, shown in `/admin`.

Admin controls: min/max bet, betting window, house edge, pause (refunds the open
betting window and stops new rounds), and **Crash now**, which ends the flying round
immediately — everybody still in loses. Rounds and their bets are stored (Mongo) for
history and accounting.

## Environment variables

| Variable         | Required | Purpose                                            |
| ---------------- | -------- | -------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN` | prod | Bot token used to verify Mini App `initData`     |
| `MONGODB_URI`    | prod     | MongoDB Atlas connection string                    |
| `JWT_SECRET`     | prod     | Signs player/admin sessions                        |
| `ADMIN_PASSWORD` | prod     | Admin panel password                               |
| `ALLOW_DEV_LOGIN`| no       | `1` = allow browser sign-in outside Telegram       |
| `PORT`           | no       | Server port (Render sets it)                       |
| `HOST`           | no       | Bind address (defaults to 127.0.0.1, 0.0.0.0 on Render) |

## Deploy on Render

1. Push this repo to GitHub.
2. **New → Blueprint** and point at the repo (`render.yaml` is included), or **New → Web Service**:
   - **Root Directory**: `time-bomb`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Health Check Path**: `/healthz`
3. Add `MONGODB_URI`, `JWT_SECRET`, `ADMIN_PASSWORD` in the Render dashboard.
4. In MongoDB Atlas → Network Access, allow `0.0.0.0/0` (Render's IPs are dynamic).
5. Deploy, then open `/admin` and set the entry fee / fuse / house cut.

Render's free plan spins down when idle; the live timer is in memory, so a spin-down
settles the round on wake. Use a paid instance for real continuous play. Run **one**
instance — the engine is a single in-process authority, not a clustered one.

## Money model

This build keeps an internal ETB wallet (no payment gateway). New players get a
configurable demo balance; the admin deposits/withdraws from the Players table.
Winner payouts and house cuts are recorded per round for accounting.
