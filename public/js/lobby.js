import { createGame, storage, listGames, forgetGame, fetchGame, formatClock } from './net.js';

const nameInput = document.getElementById('name');
nameInput.value = storage.get('chess:name') ?? '';
nameInput.addEventListener('change', () => storage.set('chess:name', nameInput.value.trim()));

document.getElementById('create').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  storage.set('chess:name', name);
  const button = e.target.querySelector('button[type=submit]');
  const err = document.getElementById('err');
  err.hidden = true;
  button.disabled = true;
  try {
    const id = await createGame({
      timeControl: document.getElementById('tc').value,
      color: new FormData(e.target).get('color'),
      name,
    });
    location.href = `game.html?g=${id}`;
  } catch (ex) {
    err.textContent = `Couldn't create a game: ${ex.message}`;
    err.hidden = false;
    button.disabled = false;
  }
});

document.getElementById('joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const raw = document.getElementById('code').value.trim();
  const id = raw.match(/[?&]g=([a-z0-9]+)/)?.[1] ?? raw.match(/^[a-z0-9]+$/)?.[0];
  if (id) location.href = `game.html?g=${id}`;
  else {
    document.getElementById('code').setCustomValidity('That doesn’t look like a game link or code');
    document.getElementById('code').reportValidity();
  }
});
document.getElementById('code').addEventListener('input', (e) => e.target.setCustomValidity(''));

// ---------- "Your games" ----------

const TC_LABEL = { '1d': '1 day/move', '3d': '3 days/move', '7d': '7 days/move', none: 'Untimed' };

async function renderMyGames() {
  const saved = listGames();
  const section = document.getElementById('mygames');
  const list = document.getElementById('gamelist');
  if (!saved.length) return;
  section.hidden = false;
  list.replaceChildren(...saved.map((g) => row(g, null)));

  const results = await Promise.all(saved.map((g) => fetchGame(g.id).then((s) => [g, s], () => [g, undefined])));
  const rows = [];
  for (const [g, s] of results) {
    if (s === null) {
      forgetGame(g.id); // expired or deleted on the server
      continue;
    }
    rows.push({ g, s, rank: rank(g, s) });
  }
  rows.sort((a, b) => a.rank - b.rank);
  list.replaceChildren(...rows.map(({ g, s }) => row(g, s)));
  section.hidden = rows.length === 0;
}

// Your move first, then their move, then waiting, then finished.
function rank(g, s) {
  if (!s) return 2;
  if (s.status === 'active') return s.turn === g.color ? 0 : 1;
  if (s.status === 'waiting') return 2;
  return 3;
}

function row(g, s) {
  const li = document.createElement('li');
  const a = document.createElement('a');
  a.href = `game.html?g=${g.id}`;
  const opp = s?.players?.[g.color === 'w' ? 'b' : 'w']?.name ?? g.opponent;
  const title = document.createElement('span');
  title.className = 'gl-title';
  title.textContent = opp ? `vs ${opp}` : 'Waiting for opponent';
  const meta = document.createElement('span');
  meta.className = 'gl-meta';
  const tc = s?.timeControl ?? g.timeControl;
  meta.textContent = TC_LABEL[tc] ?? tc ?? '';
  const badge = document.createElement('span');
  badge.className = 'gl-badge';
  if (!s) badge.textContent = '…';
  else if (s.status === 'waiting') badge.textContent = 'Waiting';
  else if (s.status === 'over') {
    const won = s.result !== '1/2-1/2' && (s.result === '1-0') === (g.color === 'w');
    badge.textContent = s.result === '1/2-1/2' ? 'Draw' : won ? 'Won' : 'Lost';
    badge.classList.add('done');
  } else {
    const mine = s.turn === g.color;
    badge.textContent = mine ? 'Your move' : 'Their move';
    badge.classList.toggle('mine', mine);
    if (s.clock?.running) {
      const left = document.createElement('span');
      left.className = 'gl-left';
      left.textContent = `${formatClock(s.clock[s.turn])} left`;
      meta.append(' · ', left);
    }
  }
  a.append(title, meta, badge);
  const x = document.createElement('button');
  x.className = 'ghost gl-x';
  x.textContent = '✕';
  x.title = 'Remove from this list';
  x.setAttribute('aria-label', 'Remove from list');
  x.onclick = () => {
    forgetGame(g.id);
    li.remove();
    if (!document.getElementById('gamelist').children.length) document.getElementById('mygames').hidden = true;
  };
  li.append(a, x);
  return li;
}

renderMyGames();
