import { test } from 'node:test';
import assert from 'node:assert/strict';

// net.js imports peerjs (browser-only); stub it and localStorage before loading.
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
const { register } = await import('node:module');
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(spec, ctx, next) {
    if (spec === 'peerjs') return { url: 'data:text/javascript,export class Peer {}', shortCircuit: true };
    return next(spec, ctx);
  }`));
const { GameHost, createHostedGame } = await import('../public/js/net.js');

const client = () => {
  const inbox = [];
  return { inbox, send: (m) => inbox.push(m), last: (type) => inbox.filter((m) => m.type === type).at(-1) };
};

test('host relays moves between peers and rejects spectator actions', () => {
  const id = createHostedGame({ timeControl: 'none', name: 'Hostie', color: 'w' });
  const host = GameHost.load(id);
  clearInterval(host.tick);
  const hostUi = client();
  const guest = client();
  const spectator = client();
  for (const c of [hostUi, guest, spectator]) host.addClient(c);

  host.handle(hostUi, { type: 'join', token: localStorage.getItem(`chess:token:${id}`), name: 'Hostie' });
  host.handle(guest, { type: 'join', name: 'Guest' });
  host.handle(spectator, { type: 'join', name: 'Watcher' });
  assert.equal(hostUi.last('state').you, 'w');
  assert.equal(guest.last('state').you, 'b');
  assert.equal(spectator.last('state').you, null);
  assert.equal(guest.last('state').state.status, 'active');

  host.handle(hostUi, { type: 'move', from: 'e2', to: 'e4' });
  assert.deepEqual(guest.last('state').state.history, ['e4']);

  host.handle(spectator, { type: 'move', from: 'e7', to: 'e5' });
  assert.match(spectator.last('error').message, /Spectators/);

  host.handle(guest, { type: 'chat', text: 'gl hf' });
  assert.equal(hostUi.last('chat').from, 'Guest');

  // State persists so the host can reload.
  const reloaded = GameHost.load(id);
  clearInterval(reloaded.tick);
  assert.deepEqual(reloaded.game.chess.history(), ['e4']);

  host.removeClient(guest);
  assert.equal(hostUi.last('state').state.players.b.connected, false);
});
