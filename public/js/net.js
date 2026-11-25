import { API_BASE } from './config.js';

const tokenKey = (id) => `chess:token:${id}`;
// The server answers pings without waking the game; silence means a dead link.
const PING = '{"type":"ping"}';
const PING_MS = 10_000;
const TIMEOUT_MS = 25_000;

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

export const getToken = (id) => storage.get(tokenKey(id));
export const setToken = (id, token) => storage.set(tokenKey(id), token);

/** Create a game on the server and remember the creator's seat token. */
export async function createGame({ timeControl, name, color }) {
  const res = await fetch(`${API_BASE}/api/games`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timeControl, name, color }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Server error (${res.status})`);
  setToken(data.id, data.token);
  return data.id;
}

/**
 * Connect the page to a game. Returns { send } for UI actions.
 * `ui` receives: onMessage(msg) and onStatus(text | null) for connection problems.
 */
export function connectToGame(id, ui, { name }) {
  const wsUrl = `${API_BASE.replace(/^http/, 'ws')}/api/games/${encodeURIComponent(id)}/ws`;
  let ws;
  let attempt = 0;
  let lastHeard = 0;
  let stopped = false;

  function open() {
    ws = new WebSocket(wsUrl);
    const sock = ws;
    sock.onopen = () => {
      lastHeard = Date.now();
      sock.send(JSON.stringify({ type: 'join', token: getToken(id), name }));
    };
    sock.onmessage = (ev) => {
      lastHeard = Date.now();
      if (ev.data === '{"type":"pong"}') return;
      const msg = JSON.parse(ev.data);
      if (msg.type === 'joined') {
        attempt = 0;
        ui.onStatus(null);
      }
      if (msg.type === 'error' && msg.fatal) {
        stopped = true;
        ui.onStatus(msg.message);
        return;
      }
      ui.onMessage(msg);
    };
    sock.onclose = () => {
      if (sock !== ws || stopped) return;
      const delay = Math.min(500 * 2 ** attempt++, 10_000);
      ui.onStatus('Connection lost — reconnecting…');
      setTimeout(open, delay);
    };
  }

  setInterval(() => {
    if (ws?.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastHeard > TIMEOUT_MS) ws.close();
    else ws.send(PING);
  }, PING_MS);

  open();
  return { send: (msg) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg)) };
}

/** Public summary of a game (no tokens), or null if it no longer exists. */
export async function fetchGame(id) {
  const res = await fetch(`${API_BASE}/api/games/${encodeURIComponent(id)}`, { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Server error (${res.status})`);
  return res.json();
}

// ---- "Your games": games this browser holds a seat in, for the lobby list ----
const GAMES_KEY = 'chess:games';
const MAX_GAMES = 50;

export function listGames() {
  try {
    return JSON.parse(storage.get(GAMES_KEY) ?? '[]');
  } catch {
    return [];
  }
}

export function rememberGame(entry) {
  const games = listGames().filter((g) => g.id !== entry.id);
  games.unshift({ ...entry, seen: Date.now() });
  storage.set(GAMES_KEY, JSON.stringify(games.slice(0, MAX_GAMES)));
}

export function forgetGame(id) {
  storage.set(GAMES_KEY, JSON.stringify(listGames().filter((g) => g.id !== id)));
}

/** Clock text: "2d 14h", "5h 12m", "4:59", or "0:08.3" in the last ten seconds. */
export function formatClock(ms) {
  const H = 3_600_000;
  if (ms >= 24 * H) {
    const d = Math.floor(ms / (24 * H));
    return `${d}d ${Math.floor((ms % (24 * H)) / H)}h`;
  }
  if (ms >= H) return `${Math.floor(ms / H)}h ${Math.floor((ms % H) / 60_000)}m`;
  if (ms < 10_000) return `0:${(Math.ceil(ms / 100) / 10).toFixed(1).padStart(4, '0')}`;
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
