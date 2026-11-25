import { Chess } from 'chess.js';

const DAY = 24 * 60 * 60 * 1000;

/**
 * Live controls: `initial` ms each plus `increment` per move.
 * Daily (correspondence) controls: `perMove` ms to make each move; the deadline resets after every move.
 */
export const TIME_CONTROLS = {
  none: null,
  '1d': { initial: DAY, increment: 0, perMove: DAY },
  '3d': { initial: 3 * DAY, increment: 0, perMove: 3 * DAY },
  '7d': { initial: 7 * DAY, increment: 0, perMove: 7 * DAY },
  '1+0': { initial: 60_000, increment: 0 },
  '3+2': { initial: 180_000, increment: 2_000 },
  '5+0': { initial: 300_000, increment: 0 },
  '10+0': { initial: 600_000, increment: 0 },
  '15+10': { initial: 900_000, increment: 10_000 },
};

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
/** Lowercase alphanumeric id (safe for PeerJS ids and URLs). */
export function randomId(length) {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

/**
 * One chess game: authoritative board state, seats, clocks and game-over logic.
 * Transport-agnostic — the host calls these methods and broadcasts `publicState()`.
 */
export class Game {
  constructor({ id = randomId(10), timeControl = 'none', now = Date.now } = {}) {
    if (!(timeControl in TIME_CONTROLS)) throw new Error('Unknown time control');
    this.id = id;
    this.timeControl = timeControl;
    this.now = now;
    this.seats = { w: null, b: null }; // { token, name, connected }
    this.reset();
  }

  reset() {
    const tc = TIME_CONTROLS[this.timeControl];
    this.chess = new Chess();
    this.status = 'waiting'; // waiting | active | over
    this.result = null; // '1-0' | '0-1' | '1/2-1/2'
    this.reason = null;
    this.lastMove = null;
    this.drawOffer = null; // color that offered
    this.rematchOffer = null;
    this.clock = tc ? { w: tc.initial, b: tc.initial, runningSince: null } : null;
    if (this.seats.w && this.seats.b) this.status = 'active';
  }

  /** Claim a seat (or reclaim one with a token). Returns { color, token } — color is null for spectators. */
  join({ token, name, preferColor } = {}) {
    for (const color of ['w', 'b']) {
      const seat = this.seats[color];
      if (seat && token && seat.token === token) {
        seat.connected = true;
        const clean = sanitizeName(name);
        if (clean) seat.name = clean;
        return { color, token };
      }
    }
    const free = ['w', 'b'].filter((c) => !this.seats[c]);
    if (free.length === 0) return { color: null, token: null };
    let color = free[0];
    if (free.length === 2) color = preferColor === 'w' || preferColor === 'b' ? preferColor : Math.random() < 0.5 ? 'w' : 'b';
    const newToken = randomId(24);
    this.seats[color] = { token: newToken, name: sanitizeName(name) || (color === 'w' ? 'White' : 'Black'), connected: true };
    if (this.seats.w && this.seats.b && this.status === 'waiting') {
      this.status = 'active';
      // Daily: if White already opened, Black's deadline starts now that Black has arrived.
      const tc = TIME_CONTROLS[this.timeControl];
      if (tc?.perMove && this.chess.history().length > 0) this.clock.runningSince = this.now();
    }
    return { color, token: newToken };
  }

  colorOf(token) {
    return token ? (['w', 'b'].find((c) => this.seats[c]?.token === token) ?? null) : null;
  }

  setConnected(color, connected) {
    if (color && this.seats[color]) this.seats[color].connected = connected;
  }

  /** Remaining ms for `color`, accounting for the currently running clock. */
  remaining(color) {
    if (!this.clock) return null;
    let ms = this.clock[color];
    if (this.clock.runningSince != null && this.status === 'active' && this.chess.turn() === color) {
      ms -= this.now() - this.clock.runningSince;
    }
    return Math.max(0, ms);
  }

  /** Epoch ms at which the side to move flags, or null if no clock is running. */
  flagTime() {
    if (!this.clock || this.status !== 'active' || this.clock.runningSince == null) return null;
    return this.clock.runningSince + this.clock[this.chess.turn()];
  }

  /** Ends the game on time if the side to move has flagged. Returns true if it did. */
  checkFlag() {
    if (!this.clock || this.status !== 'active') return false;
    const turn = this.chess.turn();
    if (this.remaining(turn) > 0) return false;
    const other = turn === 'w' ? 'b' : 'w';
    // Flagging against a lone king is a draw (the opponent cannot checkmate).
    const opponentCanMate = this.chess.board().flat().some((sq) => sq && sq.color === other && sq.type !== 'k');
    if (opponentCanMate) this.finish(other === 'w' ? '1-0' : '0-1', 'timeout');
    else this.finish('1/2-1/2', 'timeout vs insufficient material');
    return true;
  }

  /** White may play the first move before an opponent has joined. */
  canOpenEarly(color) {
    return this.status === 'waiting' && color === 'w' && !!this.seats.w && this.chess.history().length === 0;
  }

  move(color, { from, to, promotion }) {
    if (this.status !== 'active' && !this.canOpenEarly(color)) {
      throw new Error(this.status === 'waiting' ? 'Waiting for an opponent to join' : 'Game is not in progress');
    }
    if (this.checkFlag()) throw new Error('Out of time');
    if (this.chess.turn() !== color) throw new Error('Not your turn');

    let move;
    try {
      move = this.chess.move({ from, to, promotion });
    } catch {
      throw new Error('Illegal move');
    }

    if (this.clock) {
      const tc = TIME_CONTROLS[this.timeControl];
      const t = this.now();
      const plies = this.chess.history().length;
      if (tc.perMove) {
        // Daily: every move gives the opponent a fresh deadline, starting now.
        this.clock.w = this.clock.b = tc.perMove;
        // The opponent's deadline only runs once they're seated.
        this.clock.runningSince = this.status === 'active' ? t : null;
      } else {
        // Live: clocks start after each side has made its first move.
        if (this.clock.runningSince != null) this.clock[color] -= t - this.clock.runningSince;
        if (plies > 2) this.clock[color] += tc.increment;
        this.clock.runningSince = plies >= 2 ? t : null;
      }
    }

    this.lastMove = { from: move.from, to: move.to };
    this.drawOffer = null;
    this.checkGameOver();
    return move;
  }

  checkGameOver() {
    const c = this.chess;
    if (c.isCheckmate()) this.finish(c.turn() === 'w' ? '0-1' : '1-0', 'checkmate');
    else if (c.isStalemate()) this.finish('1/2-1/2', 'stalemate');
    else if (c.isInsufficientMaterial()) this.finish('1/2-1/2', 'insufficient material');
    else if (c.isThreefoldRepetition()) this.finish('1/2-1/2', 'threefold repetition');
    else if (c.isDrawByFiftyMoves()) this.finish('1/2-1/2', 'fifty-move rule');
  }

  finish(result, reason) {
    if (this.clock) {
      for (const c of ['w', 'b']) this.clock[c] = this.remaining(c);
      this.clock.runningSince = null;
    }
    this.status = 'over';
    this.result = result;
    this.reason = reason;
    this.drawOffer = null;
  }

  resign(color) {
    if (this.status !== 'active') throw new Error('Game is not in progress');
    this.finish(color === 'w' ? '0-1' : '1-0', 'resignation');
  }

  offerDraw(color) {
    if (this.status !== 'active') throw new Error('Game is not in progress');
    if (this.drawOffer && this.drawOffer !== color) return this.finish('1/2-1/2', 'agreement');
    this.drawOffer = color;
  }

  respondDraw(color, accept) {
    if (this.status !== 'active' || !this.drawOffer || this.drawOffer === color) throw new Error('No draw offer to answer');
    if (accept) this.finish('1/2-1/2', 'agreement');
    else this.drawOffer = null;
  }

  /** Both players must request; colors swap for the new game. */
  requestRematch(color) {
    if (this.status !== 'over') throw new Error('Game is still in progress');
    if (this.rematchOffer && this.rematchOffer !== color) {
      [this.seats.w, this.seats.b] = [this.seats.b, this.seats.w];
      this.reset();
      return true;
    }
    this.rematchOffer = color;
    return false;
  }

  toJSON() {
    return {
      id: this.id,
      timeControl: this.timeControl,
      seats: this.seats,
      pgn: this.chess.pgn(),
      status: this.status,
      result: this.result,
      reason: this.reason,
      lastMove: this.lastMove,
      drawOffer: this.drawOffer,
      rematchOffer: this.rematchOffer,
      clock: this.clock && { ...this.clock },
    };
  }

  /** Rebuild a saved game exactly (a running clock keeps running). */
  static fromJSON(data, { now = Date.now } = {}) {
    const g = new Game({ id: data.id, timeControl: data.timeControl, now });
    g.seats = data.seats;
    g.chess.loadPgn(data.pgn);
    Object.assign(g, {
      status: data.status,
      result: data.result,
      reason: data.reason,
      lastMove: data.lastMove,
      drawOffer: data.drawOffer,
      rematchOffer: data.rematchOffer,
    });
    g.clock = data.clock ? { w: data.clock.w, b: data.clock.b, runningSince: data.clock.runningSince ?? null } : null;
    return g;
  }

  publicState() {
    const seat = (c) => (this.seats[c] ? { name: this.seats[c].name, connected: this.seats[c].connected } : null);
    return {
      id: this.id,
      fen: this.chess.fen(),
      pgn: this.chess.pgn(),
      history: this.chess.history(),
      turn: this.chess.turn(),
      inCheck: this.chess.inCheck(),
      lastMove: this.lastMove,
      status: this.status,
      result: this.result,
      reason: this.reason,
      drawOffer: this.drawOffer,
      rematchOffer: this.rematchOffer,
      timeControl: this.timeControl,
      clock: this.clock
        ? { w: this.remaining('w'), b: this.remaining('b'), running: this.status === 'active' && this.clock.runningSince != null }
        : null,
      players: { w: seat('w'), b: seat('b') },
    };
  }
}

export function sanitizeName(name) {
  if (typeof name !== 'string') return '';
  return name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);
}
