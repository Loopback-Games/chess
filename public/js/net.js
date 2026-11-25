import { Peer } from 'peerjs';
import { Game, sanitizeName } from './game.js';

// Public PeerJS broker ids are global, so namespace ours.
const PEER_PREFIX = 'loopback-chess-v1-';
const hostKey = (id) => `chess:hosted:${id}`;
const tokenKey = (id) => `chess:token:${id}`;
// WebRTC links can die without a close event, so both sides ping and time out.
const PING_MS = 2000;
const TIMEOUT_MS = 8000;

export const storage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* private mode etc. */
    }
  },
};

/** Create a new game hosted by this browser and seat the creator. */
export function createHostedGame({ timeControl, name, color }) {
  const game = new Game({ timeControl });
  const { token } = game.join({ name, preferColor: color });
  storage.set(hostKey(game.id), JSON.stringify(game.toJSON()));
  storage.set(tokenKey(game.id), token);
  return game.id;
}

export const isHostOf = (id) => !!storage.get(hostKey(id));
export const getToken = (id) => storage.get(tokenKey(id));
export const setToken = (id, token) => storage.set(tokenKey(id), token);

/**
 * The authoritative side of a game. Runs in the creator's browser and plays the
 * role a server would: validates every action and broadcasts state to all peers.
 */
export class GameHost {
  constructor(game) {
    this.game = game;
    this.clients = new Set(); // { send(msg), token }
    this.tick = setInterval(() => {
      if (this.game.checkFlag()) this.broadcast();
      const now = Date.now();
      for (const c of this.clients) {
        if (c.remote && now - c.lastSeen > TIMEOUT_MS) {
          c.close?.();
          this.removeClient(c);
        }
      }
    }, 200);
  }

  static load(id) {
    const raw = storage.get(hostKey(id));
    return raw ? new GameHost(Game.fromJSON(JSON.parse(raw))) : null;
  }

  save() {
    storage.set(hostKey(this.game.id), JSON.stringify(this.game.toJSON()));
  }

  broadcast() {
    const state = this.game.publicState();
    for (const c of this.clients) c.send({ type: 'state', state, you: this.game.colorOf(c.token) });
    this.save();
  }

  addClient(client) {
    this.clients.add(client);
  }

  removeClient(client) {
    if (!this.clients.delete(client)) return;
    const color = this.game.colorOf(client.token);
    const stillHere = [...this.clients].some((c) => c.token && c.token === client.token);
    if (color && !stillHere) {
      this.game.setConnected(color, false);
      this.broadcast();
    }
  }

  handle(client, msg) {
    const game = this.game;
    if (!msg || typeof msg !== 'object') return;
    client.lastSeen = Date.now();
    if (msg.type === 'ping') return client.send({ type: 'pong' });

    if (msg.type === 'join') {
      if (client.joined) return;
      client.joined = true;
      const { token } = game.join({ token: msg.token, name: msg.name });
      client.token = token;
      client.send({ type: 'joined', token });
      // Clocks paused while the host was away resume once both players are back.
      if (game.seats.w?.connected && game.seats.b?.connected) game.resumeClock();
      return this.broadcast();
    }
    if (!client.joined) return;

    const color = game.colorOf(client.token);
    if (msg.type === 'chat') {
      const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, 300) : '';
      if (!text) return;
      const from = color ? game.seats[color].name : sanitizeName(msg.name) || 'Spectator';
      for (const c of this.clients) c.send({ type: 'chat', from, color, text, at: Date.now() });
      return;
    }

    if (!color) return client.send({ type: 'error', message: 'Spectators cannot do that' });
    try {
      switch (msg.type) {
        case 'move':
          game.move(color, { from: msg.from, to: msg.to, promotion: msg.promotion });
          break;
        case 'resign':
          game.resign(color);
          break;
        case 'offerDraw':
          game.offerDraw(color);
          break;
        case 'respondDraw':
          game.respondDraw(color, !!msg.accept);
          break;
        case 'rematch':
          game.requestRematch(color);
          break;
        default:
          return client.send({ type: 'error', message: 'Unknown action' });
      }
    } catch (err) {
      client.send({ type: 'error', message: err.message });
      // Resync so an optimistic UI can roll back.
      return client.send({ type: 'state', state: game.publicState(), you: color });
    }
    this.broadcast();
  }
}

/**
 * Connect the page to a game. Returns { send } for UI actions.
 * `ui` receives: onMessage(msg), onStatus(text | null), onFatal(text).
 */
export function connectToGame(id, ui, { name }) {
  return isHostOf(id) ? runAsHost(id, ui, { name }) : runAsGuest(id, ui, { name });
}

function runAsHost(id, ui, { name }) {
  const host = GameHost.load(id);
  // The host's own UI talks to the GameHost directly, as a local client.
  const local = { send: (msg) => queueMicrotask(() => ui.onMessage(msg)) };
  host.addClient(local);
  host.handle(local, { type: 'join', token: getToken(id), name });

  let peer;
  let attempts = 0;
  function register() {
    peer = new Peer(PEER_PREFIX + id, { debug: 0 });
    peer.on('open', () => {
      attempts = 0;
      ui.onStatus(null);
    });
    peer.on('connection', (conn) => {
      const client = { remote: true, lastSeen: Date.now(), send: (msg) => conn.open && conn.send(msg), close: () => conn.close() };
      conn.on('open', () => host.addClient(client));
      conn.on('data', (msg) => host.handle(client, msg));
      conn.on('close', () => host.removeClient(client));
      conn.on('error', () => host.removeClient(client));
    });
    peer.on('disconnected', () => {
      ui.onStatus('Lost connection to the matchmaking server — reconnecting…');
      setTimeout(() => !peer.destroyed && peer.reconnect(), 1000);
    });
    peer.on('error', (err) => {
      if (err.type === 'unavailable-id') {
        // After a reload the broker may still hold our old registration for a few seconds.
        peer.destroy();
        attempts++;
        ui.onStatus(
          attempts > 5
            ? 'This game seems to be open in another tab or window. Close it to host from here.'
            : 'Reclaiming the game… (this can take a few seconds after a reload)',
        );
        setTimeout(register, 3000);
      } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
        ui.onStatus('Matchmaking server unreachable — retrying…');
        peer.destroy();
        setTimeout(register, 5000);
      }
    });
  }
  register();
  window.addEventListener('pagehide', () => {
    host.game.pauseClock();
    host.save();
    peer?.destroy();
  });

  return { isHost: true, send: (msg) => host.handle(local, msg) };
}

function runAsGuest(id, ui, { name }) {
  let peer;
  let conn;
  let retryTimer;
  let lastHeard = 0;
  setInterval(() => {
    if (!conn?.open) return;
    if (Date.now() - lastHeard > TIMEOUT_MS) {
      const dead = conn;
      conn = null;
      dead.close();
      retry('Lost connection to the host — reconnecting…', 500);
    } else conn.send({ type: 'ping' });
  }, PING_MS);

  const retry = (text, delay = 3000) => {
    ui.onStatus(text);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(open, delay);
  };

  function open() {
    if (!peer || peer.destroyed) {
      peer = new Peer({ debug: 0 });
      peer.on('open', open);
      peer.on('disconnected', () => !peer.destroyed && peer.reconnect());
      peer.on('error', (err) => {
        if (err.type === 'peer-unavailable') retry("The game's host is offline. Waiting for them to come back…", 4000);
        else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
          peer.destroy();
          retry('Matchmaking server unreachable — retrying…', 5000);
        }
      });
      return;
    }
    if (!peer.open) return;
    conn?.close();
    ui.onStatus('Connecting to host…');
    conn = peer.connect(PEER_PREFIX + id, { reliable: true, serialization: 'json' });
    const c = conn;
    c.on('open', () => {
      lastHeard = Date.now();
      c.send({ type: 'join', token: getToken(id), name });
    });
    c.on('data', (msg) => {
      if (c !== conn) return;
      if (msg.type === 'joined') ui.onStatus(null);
      lastHeard = Date.now();
      if (msg.type !== 'pong') ui.onMessage(msg);
    });
    c.on('close', () => c === conn && retry('Lost connection to the host — reconnecting…', 1500));
    c.on('error', () => c === conn && retry('Lost connection to the host — reconnecting…', 1500));
  }
  open();

  return { isHost: false, send: (msg) => conn?.open && conn.send(msg) };
}
