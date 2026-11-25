# ♞ Chess

Browser-based multiplayer chess. The site is static (GitHub Pages) and the game server runs on Cloudflare's free tier (a Worker plus Durable Objects). No accounts: create a game, share the link, play.

## Features

- Real-time play between two players, with any number of spectators
- Full rules via [chess.js](https://github.com/jhlywa/chess.js), checked on the server: check, checkmate, stalemate, castling, en passant, promotion, threefold repetition, fifty-move rule, insufficient material
- Time controls (untimed, 1+0, 3+2, 5+0, 10+0, 15+10) with increment. The server flags a player who runs out of time even if nobody is connected.
- Click-to-move or drag-and-drop (mouse and touch), legal-move hints, last-move and check highlights
- Draw offers, resignation, rematch (colors swap), chat
- Survives reloads and dropped connections: the game lives on the server, and clients reconnect automatically
- Responsive layout with light/dark themes

## Architecture

```
 Browser (GitHub Pages)                       Cloudflare
 ┌─────────────────────┐   POST /api/games    ┌────────────────────────────┐
 │ public/  (static)    │ ───────────────────▶ │ Worker  (worker/index.js)  │
 │  lobby, board UI     │                      │  CORS, create, routing     │
 │                      │   WebSocket          │            │               │
 │                      │ ◀──────────────────▶ │  GameRoom Durable Object   │
 └─────────────────────┘  /api/games/:id/ws   │  one per game: rules,      │
                                               │  clocks (alarms), SQLite   │
                                               └────────────────────────────┘
```

- **One Durable Object per game** (`GameRoom`) is the authoritative server. It runs the shared `Game` class (`public/js/game.js`, also used by the unit tests), validates every action, and broadcasts state to everyone connected.
- **The WebSocket Hibernation API** keeps idle games out of memory between moves. Pings get an automatic response without waking the game.
- **Clocks** use Durable Object alarms that fire at the exact moment a player would run out of time.
- **Storage:** each game's state is saved in its object's SQLite-backed storage. Games untouched for 30 days delete themselves.
- **Security:** the Worker only accepts requests from the allowed origins (`ALLOWED_ORIGINS` in `wrangler.toml`). Seats are claimed with random tokens kept in the player's `localStorage`.

### Free-tier budget

The free plan includes 100,000 Durable Object requests and 13,000 GB-s of compute per day. Each move, chat message or join is roughly one request, and hibernated games use no compute. That covers a lot of casual chess. If a limit is exceeded, requests fail until the next UTC day; you are never billed.

## Project layout

```
public/            # static site (deployed to GitHub Pages)
  index.html       # lobby: name, time control, color, create/join
  game.html        # game page
  style.css
  js/config.js     # API_BASE: production Worker URL, or localhost:8787 in dev
  js/game.js       # rules wrapper, seats, clocks, draw/rematch, (de)serialization
  js/net.js        # REST + WebSocket client with heartbeat and reconnect
  js/app.js        # board UI and interaction
  js/lobby.js
worker/index.js    # Cloudflare Worker + GameRoom Durable Object
wrangler.toml      # Worker config (bindings, migrations, allowed origins)
scripts/serve.js   # zero-dependency static server for local dev
test/              # node:test unit tests for the game logic
```

The browser loads chess.js from jsDelivr via an import map (pinned version). There is no build step for the site.

## Development

```bash
npm install
npm run dev:worker   # game server on http://localhost:8787 (local Durable Objects)
npm start            # site on http://localhost:8080 (talks to localhost:8787)
npm test
```

Open the game link in a second browser profile or a private window to play against yourself.

## Deploying

The production Worker is at `https://chess.naponline.workers.dev`. If you rename it or use your own account, update `API_BASE` in `public/js/config.js` and `ALLOWED_ORIGINS` in `wrangler.toml`.

`.github/workflows/deploy.yml` runs on every push to `main`:

1. **test**: unit tests.
2. **pages**: publishes `public/` to GitHub Pages. Requires **Settings → Pages → Source: GitHub Actions**.
3. **worker**: `wrangler deploy`. This job is skipped until you add two repository secrets:
   - `CLOUDFLARE_API_TOKEN`: create it at dash.cloudflare.com → My Profile → API Tokens, using the **Edit Cloudflare Workers** template
   - `CLOUDFLARE_ACCOUNT_ID`: shown on the Workers & Pages overview page

You can also deploy the Worker by hand with `npx wrangler deploy`.
