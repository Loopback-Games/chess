import { DurableObject } from 'cloudflare:workers';
import { Game, TIME_CONTROLS, randomId, sanitizeName } from '../public/js/game.js';

const GAME_ID = /^[a-z0-9]{10}$/;
const IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // delete games untouched for 30 days
const PING = '{"type":"ping"}';
const PONG = '{"type":"pong"}';

// ---------------------------------------------------------------------------
// Worker: HTTP entry point. Creates games and routes WebSockets to their room.
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const allowed = isAllowedOrigin(origin, env);
    const cors = allowed && origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: allowed ? 204 : 403,
        headers: { ...cors, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' },
      });
    }

    if (url.pathname === '/api/games' && request.method === 'POST') {
      if (!allowed) return json({ error: 'Origin not allowed' }, 403);
      let body = {};
      try {
        body = await request.json();
      } catch {
        /* empty body is fine */
      }
      const timeControl = body.timeControl ?? 'none';
      if (!(timeControl in TIME_CONTROLS)) return json({ error: 'Unknown time control' }, 400, cors);
      const id = randomId(10);
      const token = await env.GAMES.get(env.GAMES.idFromName(id)).create({
        id,
        timeControl,
        name: sanitizeName(body.name),
        color: body.color,
      });
      return json({ id, token }, 201, cors);
    }

    const ws = url.pathname.match(/^\/api\/games\/([a-z0-9]+)\/ws$/);
    if (ws) {
      if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'Expected a WebSocket' }, 426);
      if (!allowed) return json({ error: 'Origin not allowed' }, 403);
      if (!GAME_ID.test(ws[1])) return json({ error: 'Game not found' }, 404);
      return env.GAMES.get(env.GAMES.idFromName(ws[1])).fetch(request);
    }

    if (url.pathname === '/') return new Response('Chess game server. Play at the GitHub Pages site.\n');
    return json({ error: 'Not found' }, 404, cors);
  },
};

function isAllowedOrigin(origin, env) {
  if (!origin) return false;
  const list = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.includes(origin)) return true;
  return env.ALLOW_LOCALHOST === 'true' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

// ---------------------------------------------------------------------------
// GameRoom: one Durable Object per game. Authoritative state + WebSockets.
// Uses the Hibernation API so idle games cost nothing between moves.
// ---------------------------------------------------------------------------

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.game = null;
    // Pings are answered by the runtime without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get(['game', 'lastActivity']);
      if (saved.get('game')) this.game = Game.fromJSON(saved.get('game'));
      this.lastActivity = saved.get('lastActivity') ?? Date.now();
    });
  }

  /** RPC from the Worker: initialise a new game and seat its creator. Returns the creator's token. */
  async create({ id, timeControl, name, color }) {
    if (this.game) throw new Error('Game already exists');
    this.game = new Game({ id, timeControl });
    const { token } = this.game.join({ name, preferColor: color });
    this.game.seats[this.game.colorOf(token)].connected = false;
    await this.save();
    return token;
  }

  async fetch() {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ token: null, joined: false });
    if (!this.game) {
      server.send(JSON.stringify({ type: 'error', message: 'Game not found', fatal: true }));
      server.close(4404, 'Game not found');
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    if (!this.game || typeof raw !== 'string' || raw.length > 4096) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const game = this.game;
    const att = ws.deserializeAttachment() ?? {};

    if (msg.type === 'join') {
      if (att.joined) return;
      const { token } = game.join({ token: typeof msg.token === 'string' ? msg.token : null, name: msg.name });
      ws.serializeAttachment({ token, joined: true, name: sanitizeName(msg.name) });
      send(ws, { type: 'joined', token });
      this.refreshPresence();
      return this.commit();
    }
    if (!att.joined) return;

    const color = game.colorOf(att.token);
    if (msg.type === 'chat') {
      const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, 300) : '';
      if (!text) return;
      const from = color ? game.seats[color].name : att.name || 'Spectator';
      const out = { type: 'chat', from, color, text, at: Date.now() };
      for (const peer of this.ctx.getWebSockets()) send(peer, out);
      return;
    }

    if (!color) return send(ws, { type: 'error', message: 'Spectators cannot do that' });
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
          return send(ws, { type: 'error', message: 'Unknown action' });
      }
    } catch (err) {
      send(ws, { type: 'error', message: err.message });
      // A flag may have ended the game while validating; persist and resync everyone.
      return this.commit();
    }
    return this.commit();
  }

  async webSocketClose(ws) {
    ws.close();
    if (!this.game) return;
    this.refreshPresence(ws);
    await this.commit();
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  /** Clock flag or idle expiry. */
  async alarm() {
    if (!this.game) return;
    if (this.game.checkFlag()) return this.commit();
    if (Date.now() - this.lastActivity >= IDLE_TTL_MS && this.ctx.getWebSockets().length === 0) {
      this.game = null;
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.scheduleAlarm();
  }

  /** Seat "connected" flags mirror whether any open socket holds that seat's token. */
  refreshPresence(closing) {
    const tokens = new Set(
      this.ctx
        .getWebSockets()
        .filter((s) => s !== closing && s.readyState === WebSocket.OPEN)
        .map((s) => s.deserializeAttachment()?.token)
        .filter(Boolean),
    );
    for (const c of ['w', 'b']) if (this.game.seats[c]) this.game.seats[c].connected = tokens.has(this.game.seats[c].token);
  }

  async commit() {
    this.broadcast();
    await this.save();
  }

  broadcast() {
    const state = this.game.publicState();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (att?.joined) send(ws, { type: 'state', state, you: this.game.colorOf(att.token) });
    }
  }

  async save() {
    this.lastActivity = Date.now();
    await this.ctx.storage.put({ game: this.game.toJSON(), lastActivity: this.lastActivity });
    await this.scheduleAlarm();
  }

  async scheduleAlarm() {
    const flag = this.game?.flagTime();
    const expiry = this.lastActivity + IDLE_TTL_MS;
    await this.ctx.storage.setAlarm(flag != null ? Math.min(flag, expiry) : expiry);
  }
}

function send(ws, msg) {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    /* socket already closed */
  }
}
