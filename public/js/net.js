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
