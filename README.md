# ♞ Chess

Browser-based multiplayer chess that runs entirely on static hosting (GitHub Pages). No accounts, no backend: create a game, share the link, play.

## Features

- Real-time play between two browsers, with any number of spectators
- Full rules via [chess.js](https://github.com/jhlywa/chess.js): check, checkmate, stalemate, castling, en passant, promotion, threefold repetition, fifty-move rule, insufficient material
- Time controls (untimed, 1+0, 3+2, 5+0, 10+0, 15+10) with increment and flagging
- Click-to-move or drag-and-drop (mouse and touch), legal-move hints, last-move and check highlights
- Draw offers, resignation, rematch (colors swap), chat
- Survives reloads: the host's game is saved in `localStorage`, and guests reconnect automatically
- Responsive layout with light/dark themes

## How multiplayer works without a server

GitHub Pages can only serve files, so the game uses **peer-to-peer WebRTC** via [PeerJS](https://peerjs.com/):

1. **The creator's browser is the host.** It runs the authoritative `Game` (`public/js/game.js`), validates every move, runs the clocks, and broadcasts state to everyone connected, just as a server would (`GameHost` in `public/js/net.js`).
2. **Signaling** (the WebRTC handshake) goes through the free public PeerJS broker at `0.peerjs.com`. After that, moves travel directly between browsers. The host registers under the peer id `loopback-chess-v1-<gameId>`, and guests connect to that id from the shared link.
3. **Heartbeats** (ping every 2s, 8s timeout) detect dead connections, which WebRTC doesn't always report, and trigger reconnects.

**Trade-offs to know about**

- If the host closes their tab, the game pauses (clocks too) until they reopen it. Guests reconnect automatically.
- The host's browser is trusted, so this suits friendly games, not ranked play.
- The public PeerJS broker has no uptime guarantee. You can [self-host a PeerServer](https://github.com/peers/peerjs-server) and pass its options to `new Peer(...)` in `net.js`.
- Some very restrictive networks block WebRTC. PeerJS's default ICE config includes STUN/TURN, which covers most cases.

## Project layout

```
public/            # the deployed static site
  index.html       # lobby: name, time control, color, create/join
  game.html        # game page
  style.css
  js/game.js       # rules wrapper, seats, clocks, draw/rematch, (de)serialization
  js/net.js        # GameHost + PeerJS transport (host and guest)
  js/app.js        # board UI and interaction
  js/lobby.js
scripts/serve.js   # zero-dependency static server for local dev
test/              # node:test unit tests for game + host logic
```

Dependencies load in the browser from jsDelivr through an import map (pinned versions). There is no build step.

## Development

```bash
npm install     # only needed for tests (chess.js as a dev dependency)
npm start       # http://localhost:8080
npm test
```

To try multiplayer locally, open the game link in a second browser profile or a private window. The same profile would share `localStorage` and act as the host in both tabs.

## Deploying to GitHub Pages

`.github/workflows/pages.yml` runs the tests, then publishes `public/` on every push to `main`.

One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

The site will be at `https://<owner>.github.io/<repo>/`. All paths are relative, so it works from a subpath.
