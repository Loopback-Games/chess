import { createHostedGame, storage } from './net.js';

const nameInput = document.getElementById('name');
nameInput.value = storage.get('chess:name') ?? '';
nameInput.addEventListener('change', () => storage.set('chess:name', nameInput.value.trim()));

document.getElementById('create').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  storage.set('chess:name', name);
  const id = createHostedGame({
    timeControl: document.getElementById('tc').value,
    color: new FormData(e.target).get('color'),
    name,
  });
  location.href = `game.html?g=${id}`;
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
