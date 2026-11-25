// Where the game server (Cloudflare Worker) lives.
// Local development talks to `npm run dev:worker`; everything else uses production.
const local = ['localhost', '127.0.0.1'].includes(location.hostname);
export const API_BASE = local ? `http://${location.hostname}:8787` : 'https://chess.naponline.workers.dev';
