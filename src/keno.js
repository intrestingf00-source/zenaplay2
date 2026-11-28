'use strict';

/**
 * Keno engine — 80-number ticket, 20 numbers drawn.
 *
 * Play runs in timed rounds, like a keno lounge:
 *   betting  — 30 s to buy one ticket for the round
 *   drawing  — 30 s while the ball blower releases the 20 numbers (1.5 s each)
 * The clock is derived from the wall clock, so every client sees the same
 * round without any timers on the server.
 *
 * Bet modes (mirroring a classic keno terminal):
 *   straight  — pick 1..maxPicks numbers and pay by how many are hit
 *   hitall    — pick 2..7 numbers, pay only when every pick is drawn
 *   against   — pick 8+ numbers, pay only when none of them is drawn
 *   halves    — no picks: top / even / bottom decides which half gets more hits
 *
 * Every round gets a secret seed from HMAC-SHA256 (rejection sampling so each
 * number is equally likely). Its SHA-256 commit is shown while betting, and the
 * seed is stored with each settled ticket, so any result can be replayed.
 */

const crypto = require('crypto');
const { GameError } = require('./engine');

const POOL = 80;
const DRAWN = 20;
const RECENT_SIZE = 20;
const ROUND_MS = 60 * 1000;
const BET_MS = 30 * 1000;
const REVEAL_MS = 1500;
const DRAW_GAP_MS = 400;

const MODES = ['straight', 'hitall', 'against', 'halves'];
const HIT_ALL_MIN = 2;
const HIT_ALL_MAX = 7;
const AGAINST_MIN = 8;

/** Straight-bet multipliers by picks and hits. ~95% RTP (see README). */
const STRAIGHT_PAYTABLE = {
  1: { 1: 3.8 },
  2: { 1: 1.5, 2: 6.31 },
  3: { 2: 4.82, 3: 20 },
  4: { 2: 2.12, 3: 8.9, 4: 37 },
  5: { 3: 6.5, 4: 27, 5: 115 },
  6: { 3: 3.03, 4: 13, 5: 53, 6: 224 },
  7: { 4: 9.21, 5: 39, 6: 162, 7: 682 },
  8: { 4: 4.45, 5: 19, 6: 79, 7: 330, 8: 1385 },
  9: { 5: 14, 6: 57, 7: 240, 8: 1010, 9: 4241 },
  10: { 5: 6.78, 6: 28, 7: 120, 8: 502, 9: 2109, 10: 8859 },
};

/** All picks must be drawn. ~95% RTP. */
const HIT_ALL_PAYTABLE = { 2: 15.8, 3: 68, 4: 310, 5: 1473, 6: 7300, 7: 38600 };

/** None of the picks may be drawn. ~95% RTP. */
const AGAINST_PAYTABLE = { 8: 10.76, 9: 14.9, 10: 20.75 };

/** Which half of the ticket gets more drawn numbers. ~95% RTP. */
const HALVES_PAYTABLE = { top: 2.38, even: 4.67, bottom: 2.38 };

/** Secret behind every round seed; a new one on each boot. */
const ROUND_SECRET = crypto.randomBytes(32).toString('hex');

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const round2 = (n) => Math.floor(n * 100) / 100;
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/**
 * Twenty distinct numbers from 1–80, derived from `seed` and the draw number.
 * Uses rejection sampling so modulo bias cannot favour any number.
 */
function drawFromSeed(seed, no) {
  const out = [];
  const limit = Math.floor(0x100000000 / POOL) * POOL;
  let block = 0;
  while (out.length < DRAWN) {
    const digest = crypto.createHmac('sha256', seed).update(`${no}:${block}`).digest();
    for (let i = 0; i + 4 <= digest.length && out.length < DRAWN; i += 4) {
      const n = digest.readUInt32BE(i);
      if (n >= limit) continue;
      const value = (n % POOL) + 1;
      if (!out.includes(value)) out.push(value);
    }
    block += 1;
  }
  return out.sort((a, b) => a - b);
}

/** Validates a pick list and returns it sorted, or throws a GameError. */
function cleanPicks(raw, maxPicks) {
  if (!Array.isArray(raw)) throw new GameError('Pick your numbers first', 400, 'invalid_picks');
  const picks = [];
  for (const value of raw) {
    const n = Math.round(Number(value) || 0);
    if (n < 1 || n > POOL) throw new GameError('Numbers go from 1 to 80', 400, 'invalid_picks');
    if (!picks.includes(n)) picks.push(n);
  }
  if (!picks.length) throw new GameError('Pick at least one number', 400, 'invalid_picks');
  if (picks.length > maxPicks) {
    throw new GameError(`You can pick at most ${maxPicks} numbers`, 400, 'too_many_picks');
  }
  return picks.sort((a, b) => a - b);
}

/** Normalizes the mode and checks the pick count it allows. */
function cleanMode(raw, maxPicks) {
  const mode = MODES.includes(raw) ? raw : 'straight';
  if (mode === 'against' && maxPicks < AGAINST_MIN) {
    throw new GameError('Bet Against needs at least 8 picks enabled', 400, 'mode_unavailable');
  }
  return mode;
}

function cleanSide(raw) {
  return raw === 'even' || raw === 'bottom' ? raw : 'top';
}

/** Secret seed for a round, revealed only once its betting window closes. */
function roundSeed(no) {
  return crypto.createHmac('sha256', ROUND_SECRET).update(`keno:round:${no}`).digest('hex');
}

function roundNumbers(no) {
  return drawFromSeed(roundSeed(no), no);
}

/** The 20 numbers in the order the blower releases them (same for everyone). */
function roundOrder(no) {
  const seed = roundSeed(no);
  return roundNumbers(no)
    .map((n) => ({ n, key: crypto.createHmac('sha256', seed).update(`order:${n}`).digest('hex') }))
    .sort((a, b) => (a.key === b.key ? a.n - b.n : a.key < b.key ? -1 : 1))
    .map((x) => x.n);
}

/** Where the shared round clock stands right now. */
function roundClock(now = Date.now()) {
  const no = Math.floor(now / ROUND_MS);
  const start = no * ROUND_MS;
  const drawing = now - start >= BET_MS;
  return {
    no,
    phase: drawing ? 'drawing' : 'betting',
    serverNow: now,
    betEndsAt: start + BET_MS,
    drawStartsAt: start + BET_MS,
    drawEndsAt: start + ROUND_MS,
    nextAt: start + ROUND_MS,
    seedHash: sha256(roundSeed(no)),
  };
}

/** Hits and payout for one ticket against the round's numbers. */
function settleTicket(ticket, drawn) {
  const picks = ticket.picks || [];
  const hits = picks.filter((n) => drawn.includes(n)).length;
  const topHits = drawn.filter((n) => n <= 40).length;
  const bottomHits = DRAWN - topHits;

  let multiplier = 0;
  if (ticket.mode === 'straight') {
    const table = STRAIGHT_PAYTABLE[picks.length] || {};
    multiplier = table[hits] || 0;
  } else if (ticket.mode === 'hitall') {
    multiplier = hits === picks.length ? HIT_ALL_PAYTABLE[picks.length] || 0 : 0;
  } else if (ticket.mode === 'against') {
    multiplier = hits === 0 ? AGAINST_PAYTABLE[picks.length] || 0 : 0;
  } else {
    const outcome = topHits === bottomHits ? 'even' : topHits > bottomHits ? 'top' : 'bottom';
    multiplier = outcome === ticket.side ? HALVES_PAYTABLE[ticket.side] || 0 : 0;
  }

  return {
    hits,
    topHits,
    bottomHits,
    multiplier: round2(multiplier),
    payout: multiplier ? Math.floor(ticket.amount * multiplier) : 0,
    win: multiplier > 0,
  };
}

class KenoEngine {
  constructor(db) {
    this.db = db;
    this.cfg = null;
    this.pending = new Map(); // roundNo -> tickets bought in that round
    this.active = new Set(); // `${roundNo}:${userId}` — one ticket per round
    this.lastBetAt = new Map();
    this.chain = Promise.resolve();
    this.settling = null;
  }

  /* ----------------------------- lifecycle ----------------------------- */

  async init() {
    this.cfg = await this.db.getKenoConfig();
    await this.recoverPending();
  }

  /** Refunds tickets left pending by a restart; they never got a draw. */
  async recoverPending() {
    let stale = [];
    try {
      stale = await this.db.listPendingKenoDraws();
    } catch (err) {
      console.error('[keno] could not read pending tickets', err);
      return;
    }
    for (const d of stale) {
      try {
        if (d.amount > 0) await this.db.creditBalance(d.userId, d.amount);
        await this.db.updateKenoDraw(d.id, { status: 'void', payout: 0 });
      } catch (err) {
        console.error('[keno] could not refund pending ticket', d.id, err);
      }
    }
  }

  /** Serializes bets and settlements so a wallet is never debited twice at once. */
  withLock(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  /* ------------------------------ rounds ------------------------------- */

  /**
   * Settles every round whose betting window is over. Runs on each request, so
   * results appear as soon as the round's draw starts without a server timer.
   */
  settleDue(now = Date.now()) {
    if (this.settling) return this.settling;
    const due = [];
    for (const [no, tickets] of this.pending) {
      if (no * ROUND_MS + BET_MS <= now) {
        this.pending.delete(no);
        for (const ticket of tickets) this.active.delete(`${no}:${ticket.userId}`);
        due.push([no, tickets]);
      }
    }
    if (!due.length) return Promise.resolve();

    this.settling = this.settleRounds(due).finally(() => {
      this.settling = null;
    });
    return this.settling;
  }

  async settleRounds(due) {
    for (const [no, tickets] of due) {
      const drawn = roundNumbers(no);
      const seed = roundSeed(no);
      const seedHash = sha256(seed);
      for (const ticket of tickets) {
        try {
          const result = settleTicket(ticket, drawn);
          let paid = null;
          if (result.payout > 0) {
            paid = await this.db.creditBalance(ticket.userId, result.payout, {
              wins: 1,
              winnings: result.payout,
            });
          }
          await this.db.updateKenoDraw(ticket.dbId, {
            drawn,
            hits: result.hits,
            topHits: result.topHits,
            bottomHits: result.bottomHits,
            multiplier: result.multiplier,
            payout: result.payout,
            seed,
            seedHash,
            status: 'settled',
          });
          if (paid) ticket.balance = paid.balance;
        } catch (err) {
          console.error('[keno] could not settle ticket', ticket.dbId, err);
        }
      }
    }
  }

  /* ------------------------------- state ------------------------------- */

  async state() {
    await this.settleDue();
    const [recent, stats] = await Promise.all([
      this.db.listKenoDraws({ limit: RECENT_SIZE }),
      this.db.getKenoStats(),
    ]);
    const round = roundClock();
    return {
      paused: !!this.cfg.paused,
      config: {
        minBet: this.cfg.minBet,
        maxBet: this.cfg.maxBet,
        maxPicks: this.cfg.maxPicks,
      },
      modes: {
        straight: STRAIGHT_PAYTABLE,
        hitall: HIT_ALL_PAYTABLE,
        against: AGAINST_PAYTABLE,
        halves: HALVES_PAYTABLE,
      },
      limits: {
        hitallMin: HIT_ALL_MIN,
        hitallMax: HIT_ALL_MAX,
        againstMin: AGAINST_MIN,
        drawn: DRAWN,
        revealMs: REVEAL_MS,
        betMs: BET_MS,
        drawMs: ROUND_MS - BET_MS,
      },
      stats,
      round,
      // The numbers are only published once betting is closed.
      drawn: round.phase === 'drawing' ? roundOrder(round.no) : null,
      recent: recent.map(publicDraw),
    };
  }

  /** The caller's ticket for the current round plus their latest settled draw. */
  async myTicket(userId) {
    await this.settleDue();
    const round = roundClock();
    let current = null;
    for (const ticket of this.pending.get(round.no) || []) {
      if (String(ticket.userId) === String(userId)) current = ticket;
    }
    const last = (await this.db.listKenoDraws({ limit: 1, userId }))[0] || null;
    return {
      round,
      current: current
        ? {
            roundNo: round.no,
            amount: current.amount,
            mode: current.mode,
            side: current.side,
            picks: current.picks,
            status: 'pending',
          }
        : null,
      last: last ? publicDraw(last) : null,
    };
  }

  /* -------------------------------- bets ------------------------------- */

  async placeBet(user, { amount, mode: rawMode, picks: rawPicks, side: rawSide } = {}) {
    return this.withLock(async () => {
      if (this.cfg.paused) throw new GameError('Keno is paused by the admin', 400, 'paused');

      const now = Date.now();
      const round = roundClock(now);
      if (round.phase !== 'betting') {
        throw new GameError('Betting is closed — wait for the next round', 409, 'betting_closed');
      }

      const key = `${round.no}:${user.id}`;
      if (this.active.has(key)) {
        throw new GameError('You already have a ticket for this round', 409, 'ticket_exists');
      }

      const last = this.lastBetAt.get(user.id) || 0;
      if (now - last < DRAW_GAP_MS) throw new GameError('Slow down a little', 429, 'spam');

      const stake = Math.round(Number(amount) || 0);
      if (!stake || stake < this.cfg.minBet) {
        throw new GameError(`Minimum bet is ${this.cfg.minBet} ETB`, 400, 'min_bet');
      }
      if (stake > this.cfg.maxBet) {
        throw new GameError(`Maximum bet is ${this.cfg.maxBet} ETB`, 400, 'max_bet');
      }

      const mode = cleanMode(rawMode, this.cfg.maxPicks);
      const side = cleanSide(rawSide);
      let picks = [];

      if (mode === 'straight') {
        picks = cleanPicks(rawPicks, this.cfg.maxPicks);
      } else if (mode === 'hitall') {
        picks = cleanPicks(rawPicks, Math.min(HIT_ALL_MAX, this.cfg.maxPicks));
        if (picks.length < HIT_ALL_MIN) {
          throw new GameError(`Hit All needs at least ${HIT_ALL_MIN} numbers`, 400, 'too_few_picks');
        }
      } else if (mode === 'against') {
        picks = cleanPicks(rawPicks, this.cfg.maxPicks);
        if (picks.length < AGAINST_MIN) {
          throw new GameError(`Bet Against needs at least ${AGAINST_MIN} numbers`, 400, 'too_few_picks');
        }
      }

      await this.settleDue(now);

      const updated = await this.db.debitBalance(user.id, stake);
      if (!updated) throw new GameError('Not enough ETB in your wallet', 402, 'insufficient_funds');

      this.active.add(key);
      this.lastBetAt.set(user.id, now);

      const no = await this.db.nextKenoDrawNo();
      const record = {
        no,
        roundNo: round.no,
        userId: String(updated.id),
        username: updated.username,
        amount: stake,
        mode,
        side: mode === 'halves' ? side : '',
        picks,
        drawn: [],
        hits: 0,
        topHits: 0,
        bottomHits: 0,
        multiplier: 0,
        payout: 0,
        seed: '',
        seedHash: round.seedHash,
        status: 'pending',
      };

      let saved;
      try {
        saved = await this.db.saveKenoDraw(record);
      } catch (err) {
        this.active.delete(key);
        await this.db.creditBalance(updated.id, stake).catch(() => {});
        console.error('[keno] could not save ticket', err);
        throw new GameError('Could not place the ticket, try again', 500, 'ticket_failed');
      }

      const list = this.pending.get(round.no) || [];
      list.push(record);
      record.dbId = saved.id;
      this.pending.set(round.no, list);

      return {
        balance: updated.balance,
        round,
        ticket: {
          roundNo: round.no,
          no,
          amount: stake,
          mode,
          side: record.side,
          picks,
          status: 'pending',
        },
      };
    });
  }

  /* -------------------------------- admin ------------------------------- */

  async updateConfig(patch = {}) {
    const next = { ...this.cfg };
    if (patch.minBet !== undefined) next.minBet = clamp(Math.round(Number(patch.minBet) || 1), 1, 100000);
    if (patch.maxBet !== undefined) next.maxBet = clamp(Math.round(Number(patch.maxBet) || 1), next.minBet, 1000000);
    if (patch.maxPicks !== undefined) next.maxPicks = clamp(Math.round(Number(patch.maxPicks) || 1), 1, 10);
    if (patch.paused !== undefined) next.paused = !!patch.paused;

    this.cfg = await this.db.saveKenoConfig(next);
    return this.cfg;
  }
}

function publicDraw(d) {
  return {
    no: d.no,
    roundNo: d.roundNo,
    username: d.username,
    amount: d.amount,
    mode: d.mode,
    side: d.side,
    picks: d.picks,
    drawn: d.drawn,
    hits: d.hits,
    topHits: d.topHits,
    bottomHits: d.bottomHits,
    multiplier: d.multiplier,
    payout: d.payout,
    seedHash: d.seedHash,
  };
}

module.exports = {
  KenoEngine,
  GameError,
  STRAIGHT_PAYTABLE,
  HIT_ALL_PAYTABLE,
  AGAINST_PAYTABLE,
  HALVES_PAYTABLE,
  MODES,
  drawFromSeed,
  cleanPicks,
  roundClock,
  roundNumbers,
  roundOrder,
  settleTicket,
  ROUND_MS,
  BET_MS,
  REVEAL_MS,
};
