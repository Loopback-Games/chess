import { Chess } from 'chess.js';
import { connectToGame, setToken, storage } from './net.js';

const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
const FILES = 'abcdefgh';
const gameId = new URLSearchParams(location.search).get('g') ?? '';

const $ = (id) => document.getElementById(id);
const boardEl = $('board');

let state = null;
let you = null; // 'w' | 'b' | null (spectator)
let flipped = false;
let selected = null;
let chess = new Chess();
let clockBase = null; // { w, b, at } snapshot for local countdown
let connNotice = null; // connection problem text, shown instead of the game status

const shareUrl = new URL(`game.html?g=${encodeURIComponent(gameId)}`, location.href).href;
$('link').value = shareUrl;
$('copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText(shareUrl);
    $('copy').textContent = 'Copied!';
  } catch {
    $('link').select();
  }
  setTimeout(() => ($('copy').textContent = 'Copy link'), 1500);
};

// ---------- networking ----------

let net = { send() {} };
if (!/^[a-z0-9]{10}$/.test(gameId)) {
  $('status').textContent = 'No such game. Head back to the lobby to start one.';
} else {
  net = connectToGame(
    gameId,
    {
      onMessage(msg) {
        if (msg.type === 'joined' && msg.token) setToken(gameId, msg.token);
        else if (msg.type === 'state') onState(msg.state, msg.you);
        else if (msg.type === 'chat') addChat(msg);
        else if (msg.type === 'error') flash(msg.message);
      },
      onStatus(text) {
        connNotice = text;
        if (state) renderSide();
        else $('status').textContent = text ?? 'Connecting…';
      },
    },
    { name: storage.get('chess:name') ?? '' },
  );
}

const send = (msg) => net.send(msg);

function onState(s, yourColor) {
  const firstState = !state;
  const colorChanged = you !== yourColor;
  state = s;
  you = yourColor;
  if (firstState || colorChanged) flipped = you === 'b';
  chess = new Chess(s.fen);
  selected = null;
  clockBase = s.clock ? { w: s.clock.w, b: s.clock.b, at: performance.now() } : null;
  render();
}

// ---------- rendering ----------

function squareAt(row, col) {
  const file = flipped ? 7 - col : col;
  const rank = flipped ? row + 1 : 8 - row;
  return FILES[file] + rank;
}

function render() {
  renderBoard();
  renderPlayers();
  renderSide();
}

function renderBoard() {
  const targets = selected ? new Set(chess.moves({ square: selected, verbose: true }).map((m) => m.to)) : new Set();
  const kingInCheck = state?.inCheck ? findKing(chess.turn()) : null;
  boardEl.replaceChildren();
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const sq = squareAt(row, col);
      const piece = chess.get(sq);
      const el = document.createElement('div');
      el.className = 'sq ' + ((row + col) % 2 ? 'dark' : 'light');
      el.dataset.sq = sq;
      el.setAttribute('role', 'gridcell');
      el.setAttribute('aria-label', sq + (piece ? ` ${piece.color === 'w' ? 'white' : 'black'} ${pieceName(piece.type)}` : ''));
      if (state?.lastMove && (state.lastMove.from === sq || state.lastMove.to === sq)) el.classList.add('last');
      if (sq === selected) el.classList.add('selected');
      if (sq === kingInCheck) el.classList.add('check');
      if (targets.has(sq)) el.classList.add(piece ? 'capture' : 'target');
      if (col === 0) el.insertAdjacentHTML('beforeend', `<span class="coord rank">${sq[1]}</span>`);
      if (row === 7) el.insertAdjacentHTML('beforeend', `<span class="coord file">${sq[0]}</span>`);
      if (piece) {
        const p = document.createElement('span');
        p.className = `piece ${piece.color}`;
        p.textContent = GLYPH[piece.type];
        if (canMove() && piece.color === you) p.classList.add('mine');
        el.appendChild(p);
      }
      boardEl.appendChild(el);
    }
  }
}

function renderPlayers() {
  const top = flipped ? 'w' : 'b';
  const bottom = flipped ? 'b' : 'w';
  for (const [elId, color] of [['top', top], ['bottom', bottom]]) {
    const el = $(elId);
    const p = state?.players[color];
    el.querySelector('.pname').textContent =
      (p ? p.name : 'Waiting for opponent…') + (color === you ? ' (you)' : '');
    el.classList.toggle('offline', !!p && !p.connected);
    el.classList.toggle('to-move', state?.status === 'active' && state.turn === color);
    el.querySelector('.dot').className = `dot ${color}`;
    el.querySelector('.dot').title = p ? (p.connected ? 'Online' : 'Offline') : '';
  }
  renderClocks();
}

function renderClocks() {
  const top = flipped ? 'w' : 'b';
  for (const [elId, color] of [['top', top], ['bottom', flipped ? 'b' : 'w']]) {
    const c = $(elId).querySelector('.clock');
    if (!clockBase) {
      c.hidden = true;
      continue;
    }
    c.hidden = false;
    let ms = clockBase[color];
    if (state.clock.running && state.status === 'active' && state.turn === color) ms -= performance.now() - clockBase.at;
    ms = Math.max(0, ms);
    c.textContent = fmt(ms);
    c.classList.toggle('low', ms < 20_000);
  }
}

function renderSide() {
  const s = state;
  const turnName = s.turn === 'w' ? 'White' : 'Black';
  let status;
  if (connNotice) status = connNotice;
  else if (s.status === 'waiting') status = 'Waiting for an opponent — share the link above.';
  else if (s.status === 'active') {
    status = you === s.turn ? 'Your move' : `${turnName} to move`;
    if (s.inCheck) status += ' — check!';
    if (!you) status = `Spectating · ${status}`;
  } else {
    const winner = s.result === '1-0' ? 'White wins' : s.result === '0-1' ? 'Black wins' : 'Draw';
    status = `${winner} by ${s.reason} (${s.result})`;
  }
  $('status').textContent = status;

  const banner = $('banner');
  banner.hidden = true;
  banner.replaceChildren();
  if (s.status === 'active' && s.drawOffer && you && s.drawOffer !== you) {
    banner.hidden = false;
    banner.append('Your opponent offers a draw. ');
    banner.append(button('Accept', () => send({ type: 'respondDraw', accept: true }), 'primary'));
    banner.append(button('Decline', () => send({ type: 'respondDraw', accept: false })));
  } else if (s.status === 'active' && s.drawOffer === you) {
    banner.hidden = false;
    banner.textContent = 'Draw offered — waiting for a reply.';
  } else if (s.status === 'over' && s.rematchOffer && you) {
    banner.hidden = false;
    banner.textContent = s.rematchOffer === you ? 'Rematch requested…' : 'Your opponent wants a rematch!';
  }

  const playing = !!you && s.status === 'active';
  $('draw').hidden = $('resign').hidden = !playing;
  $('draw').disabled = s.drawOffer === you;
  $('rematch').hidden = !(you && s.status === 'over');
  $('rematch').disabled = s.rematchOffer === you;

  const moves = $('moves');
  moves.replaceChildren();
  for (let i = 0; i < s.history.length; i += 2) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${s.history[i]}</span><span>${s.history[i + 1] ?? ''}</span>`;
    moves.appendChild(li);
  }
  moves.scrollTop = moves.scrollHeight;
}

function button(label, onclick, cls = '') {
  const b = document.createElement('button');
  b.textContent = label;
  b.className = cls;
  b.onclick = onclick;
  return b;
}

// ---------- interaction ----------

const canMove = () => state?.status === 'active' && you && chess.turn() === you;

function tryMove(from, to) {
  const legal = chess.moves({ square: from, verbose: true }).filter((m) => m.to === to);
  if (!legal.length) return false;
  if (legal.some((m) => m.promotion)) {
    askPromotion(to).then((promotion) => promotion && commitMove(from, to, promotion));
  } else commitMove(from, to);
  return true;
}

function commitMove(from, to, promotion) {
  // Optimistic update; the server's next state message is authoritative.
  const move = chess.move({ from, to, promotion });
  state = { ...state, lastMove: { from, to }, turn: chess.turn(), inCheck: chess.inCheck(), history: [...state.history, move.san] };
  selected = null;
  render();
  send({ type: 'move', from, to, promotion });
}

function askPromotion(to) {
  return new Promise((resolve) => {
    const promo = $('promo');
    promo.replaceChildren();
    for (const t of ['q', 'r', 'b', 'n']) {
      const b = document.createElement('button');
      b.className = `piece ${you}`;
      b.textContent = GLYPH[t];
      b.title = pieceName(t);
      b.onclick = () => done(t);
      promo.appendChild(b);
    }
    const cancel = button('✕', () => done(null), 'cancel');
    promo.appendChild(cancel);
    promo.hidden = false;
    function done(v) {
      promo.hidden = true;
      resolve(v);
    }
  });
}

function onSquareClick(sq) {
  if (!canMove()) return;
  const piece = chess.get(sq);
  if (selected && selected !== sq && tryMove(selected, sq)) return;
  selected = piece && piece.color === you && selected !== sq ? sq : null;
  renderBoard();
}

// Pointer-based drag and drop (works for mouse and touch).
let drag = null;
boardEl.addEventListener('pointerdown', (e) => {
  const sqEl = e.target.closest('.sq');
  if (!sqEl || !canMove()) return;
  const sq = sqEl.dataset.sq;
  const piece = chess.get(sq);
  if (!piece || piece.color !== you) return onSquareClick(sq);
  e.preventDefault();
  selected = sq;
  renderBoard();
  const pieceEl = boardEl.querySelector(`[data-sq="${sq}"] .piece`);
  const ghost = pieceEl.cloneNode(true);
  ghost.classList.add('ghost');
  ghost.style.fontSize = getComputedStyle(pieceEl).fontSize;
  document.body.appendChild(ghost);
  pieceEl.classList.add('dragging');
  drag = { from: sq, ghost, moved: false, x: e.clientX, y: e.clientY };
  moveGhost(e);
});
window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) drag.moved = true;
  moveGhost(e);
});
window.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const { from, ghost, moved } = drag;
  drag = null;
  ghost.remove();
  const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.sq')?.dataset.sq;
  if (moved && target && target !== from && tryMove(from, target)) return;
  if (moved) selected = null;
  renderBoard();
});
function moveGhost(e) {
  drag.ghost.style.left = `${e.clientX}px`;
  drag.ghost.style.top = `${e.clientY}px`;
}

$('flip').onclick = () => {
  flipped = !flipped;
  render();
};
$('resign').onclick = () => confirm('Resign this game?') && send({ type: 'resign' });
$('draw').onclick = () => send({ type: 'offerDraw' });
$('rematch').onclick = () => send({ type: 'rematch' });

$('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('chatInput');
  if (input.value.trim()) send({ type: 'chat', text: input.value, name: storage.get('chess:name') ?? '' });
  input.value = '';
});

function addChat({ from, color, text }) {
  const line = document.createElement('div');
  const who = document.createElement('b');
  who.textContent = from + ': ';
  if (color) who.className = `chat-${color}`;
  line.append(who, text);
  $('chat').appendChild(line);
  $('chat').scrollTop = $('chat').scrollHeight;
}

// ---------- utils ----------

function findKing(color) {
  for (const row of chess.board()) for (const p of row) if (p && p.type === 'k' && p.color === color) return p.square;
  return null;
}
function pieceName(t) {
  return { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' }[t];
}
function fmt(ms) {
  const total = ms < 10_000 ? Math.ceil(ms / 100) / 10 : Math.ceil(ms / 1000);
  if (ms < 10_000) return `0:${total.toFixed(1).padStart(4, '0')}`;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
let flashTimer;
function flash(text) {
  const s = $('status');
  const prev = s.textContent;
  s.textContent = text;
  s.classList.add('flash');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    s.classList.remove('flash');
    if (s.textContent === text) state ? renderSide() : (s.textContent = prev);
  }, 1800);
}

setInterval(() => state && clockBase && renderClocks(), 100);
