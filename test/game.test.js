import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../public/js/game.js';

function seated(opts) {
  const g = new Game(opts);
  const a = g.join({ name: 'Alice', preferColor: 'w' });
  const b = g.join({ name: 'Bob' });
  return { g, w: a.token, b: b.token };
}

test('seats two players then spectators; tokens reclaim seats', () => {
  const g = new Game();
  const a = g.join({ name: 'Alice', preferColor: 'b' });
  assert.equal(a.color, 'b');
  assert.equal(g.status, 'waiting');
  const b = g.join({ name: 'Bob' });
  assert.equal(b.color, 'w');
  assert.equal(g.status, 'active');
  assert.equal(g.join({ name: 'Eve' }).color, null);
  assert.deepEqual(g.join({ token: a.token }), { color: 'b', token: a.token });
});

test('rejects out-of-turn and illegal moves', () => {
  const { g } = seated();
  assert.throws(() => g.move('b', { from: 'e7', to: 'e5' }), /Not your turn/);
  assert.throws(() => g.move('w', { from: 'e2', to: 'e5' }), /Illegal/);
  g.move('w', { from: 'e2', to: 'e4' });
  assert.equal(g.publicState().turn, 'b');
});

test("fool's mate ends in checkmate", () => {
  const { g } = seated();
  for (const [c, from, to] of [['w', 'f2', 'f3'], ['b', 'e7', 'e5'], ['w', 'g2', 'g4'], ['b', 'd8', 'h4']]) g.move(c, { from, to });
  assert.equal(g.status, 'over');
  assert.equal(g.result, '0-1');
  assert.equal(g.reason, 'checkmate');
});

test('draw offer and acceptance; resignation', () => {
  const { g } = seated();
  g.offerDraw('w');
  assert.throws(() => g.respondDraw('w', true));
  g.respondDraw('b', true);
  assert.equal(g.result, '1/2-1/2');

  const s = seated();
  s.g.resign('w');
  assert.equal(s.g.result, '0-1');
});

test('rematch swaps colors and resets', () => {
  const { g, w, b } = seated();
  g.resign('b');
  assert.equal(g.requestRematch('w'), false);
  assert.equal(g.requestRematch('b'), true);
  assert.equal(g.colorOf(w), 'b');
  assert.equal(g.colorOf(b), 'w');
  assert.equal(g.status, 'active');
  assert.equal(g.publicState().history.length, 0);
});

test('clock starts after both first moves, applies increment, and flags', () => {
  let t = 0;
  const { g } = seated({ timeControl: '3+2', now: () => t });
  g.move('w', { from: 'e2', to: 'e4' });
  t += 5000;
  g.move('b', { from: 'e7', to: 'e5' });
  assert.equal(g.remaining('w'), 180_000);
  assert.equal(g.remaining('b'), 180_000);
  t += 10_000;
  g.move('w', { from: 'g1', to: 'f3' });
  assert.equal(g.remaining('w'), 180_000 - 10_000 + 2_000);
  t += 180_001;
  assert.equal(g.checkFlag(), true);
  assert.equal(g.result, '1-0');
  assert.equal(g.reason, 'timeout');
});

test('serializes and restores exactly, including a running clock', () => {
  let t = 0;
  const { g, w } = seated({ timeControl: '5+0', now: () => t });
  g.move('w', { from: 'd2', to: 'd4' });
  g.move('b', { from: 'd7', to: 'd5' });
  t += 7000;
  const restored = Game.fromJSON(JSON.parse(JSON.stringify(g.toJSON())), { now: () => t });
  assert.equal(restored.chess.fen(), g.chess.fen());
  assert.equal(restored.colorOf(w), 'w');
  assert.equal(restored.remaining('w'), 293_000);
  assert.equal(restored.flagTime(), 300_000);
  t += 300_000;
  assert.equal(restored.checkFlag(), true);
  assert.equal(restored.result, '0-1');
});
