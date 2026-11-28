'use strict';

/**
 * Mines engine — a 5×5 field hiding a chosen number of bombs.
 *
 * The player stakes once, then opens tiles one at a time. Every safe tile
 * raises the multiplier; a bomb ends the round with nothing. The player can
 * cash out after any safe tile. Clearing every safe tile pays out
 * automatically.
 *
 * Payouts are the exact odds of clearing n tiles with k bombs,
 *   C(25, k) / C(25−k, n),
 * multiplied by (1 − house edge). They are computed once when the round
 * starts, so an admin changing the edge mid-round cannot alter a live round.
 *
 * Fairness: every round gets a fresh random seed. Its SHA-256 commit is shown
 * while the round is live and the seed is published when it ends, so the mine
 * layout can be replayed. Bomb positions never leave the server before then.
 */

const crypto = require('crypto');
const { GameError } = require('./engine');

const TILES = 25;
const COLS = 5;
const MIN_MINES = 1;
const MAX_MINES = 24;
const ACTION_GAP_MS = 150;

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
/** Round down to 2 decimals so the house never pays a fraction it did not price. */
const down2 = (n) => Math.floor(n * 100) / 100;

const isTile = (value) => Number.isInteger(value) && value >= 0 && value < TILES;

/**
 * Cash-out multipliers indexed by how many safe tiles are open.
 * table[0] is the stake itself; the last entry is clearing the whole field.
 * Returns an empty table for an out-of-range bomb count.
 */
function multiplierTable(mines, houseEdge, maxMultiplier) {
  const k = Math.round(Number(mines) || 0);
  if (k < MIN_MINES || k > MAX_MINES) return [];
  const edge = clamp(Number(houseEdge) || 0, 0, 20) / 100;
  const cap = clamp(Number(maxMultiplier) || 1000, 2, 100000);
  const maxReveal = TILES - k;

  const table = [1];
  let fair = 1;
  for (let n = 1; n <= maxReveal; n++) {
    // Each step is (remaining tiles) / (remaining safe tiles).
    fair *= (TILES - (n - 1)) / (maxReveal - (n - 1));
    table.push(Math.max(1.01, Math.min(cap, down2(fair * (1 - edge)))));
  }
  return table;
}

/** `mines` distinct tiles from the round seed, by rejection sampling. */
function mineLayout(seed, no, mines) {
  const out = [];
  const limit = Math.floor(0x100000000 / TILES) * TILES;
  let block = 0;
  while (out.length < mines) {
    const digest = crypto.createHmac('sha256', seed).update(`mines:${no}:${block}`).digest();
    for (let i = 0; i + 4 <= digest.length && out.length < mines; i += 4) {
      const n = digest.readUInt32BE(i);
      if (n >= limit) continue;
      const tile = n % TILES;
      if (!out.includes(tile)) out.push(tile);
    }
    block += 1;
  }
  return out.sort((a, b) => a - b);
}

/** What a player may see. Bomb positions are only sent once the round is over. */
function publicRound(round) {
  const ended = round.status !== 'live';
  return {
    id: round.dbId,
    no: round.no,
    amount: round.amount,
    mines: round.mines,
    tiles: TILES,
    cols: COLS,
    revealed: round.revealed.slice(),
    multiplier: round.multiplier,
    nextMultiplier: ended ? null : round.table[round.revealed.length + 1] || null,
    maxReveal: round.maxReveal,
    status: round.status,
    payout: round.payout,
    seedHash: round.seedHash,
    seed: ended ? round.seed : '',
    layout: ended ? round.layout.slice() : [],
  };
}

class MinesEngine {
  constructor(db) {
    this.db = db;
    this.cfg = null;
    this.rounds = new Map(); // userId -> live round (in memory only)
    this.lastActionAt = new Map();
    this.chain = Promise.resolve();
  }

  /* ----------------------------- lifecycle ----------------------------- */

  async init() {
    this.cfg = await this.db.getMinesConfig();
    await this.recoverOpenRounds();
  }

  /** A restart loses the in-memory field, so open rounds are refunded. */
  async recoverOpenRounds() {
    let open = [];
    try {
      open = await this.db.listLiveMinesRounds();
    } catch (err) {
      console.error('[mines] could not read open rounds', err);
      return;
    }
    for (const round of open) {
      try {
        if (round.amount > 0) await this.db.creditBalance(round.userId, round.amount);
        await this.db.updateMinesRound(round.id, {
          status: 'void',
          payout: 0,
          endedAt: new Date(),
        });
      } catch (err) {
        console.error('[mines] could not refund round', round.id, err);
      }
    }
    if (open.length) console.log(`[mines] refunded ${open.length} round(s) left open by a restart`);
  }

  /** Serializes starts, reveals and cash-outs so a wallet is never debited twice. */
  withLock(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  table(mines) {
    return multiplierTable(mines, this.cfg.houseEdge, this.cfg.maxMultiplier);
  }

  /* ------------------------------- state ------------------------------- */

  async state() {
    const stats = await this.db.getMinesStats();
    return {
      paused: !!this.cfg.paused,
      config: {
        minBet: this.cfg.minBet,
        maxBet: this.cfg.maxBet,
        defaultMines: this.cfg.defaultMines,
        houseEdge: this.cfg.houseEdge,
        maxMultiplier: this.cfg.maxMultiplier,
      },
      limits: { tiles: TILES, cols: COLS, minMines: MIN_MINES, maxMines: MAX_MINES },
      live: this.rounds.size,
      stats,
    };
  }

  /** The player's open round, or null. */
  myRound(userId) {
    const round = this.rounds.get(String(userId));
    return round ? publicRound(round) : null;
  }

  quote(mines) {
    const table = this.table(mines);
    return {
      mines: Math.round(Number(mines) || 0),
      table,
      maxReveal: table.length ? table.length - 1 : 0,
      edge: this.cfg.houseEdge,
    };
  }

  /* ------------------------------- rounds ------------------------------ */

  async start(user, { amount, mines: rawMines } = {}) {
    return this.withLock(async () => {
      if (this.cfg.paused) throw new GameError('Mines is paused by the admin', 400, 'paused');

      const key = String(user.id);
      if (this.rounds.has(key)) {
        throw new GameError('Finish your open round first', 409, 'round_active');
      }

      const now = Date.now();
      const stake = Math.round(Number(amount) || 0);
      if (!stake || stake < this.cfg.minBet) {
        throw new GameError(`Minimum bet is ${this.cfg.minBet} ETB`, 400, 'min_bet');
      }
      if (stake > this.cfg.maxBet) {
        throw new GameError(`Maximum bet is ${this.cfg.maxBet} ETB`, 400, 'max_bet');
      }

      const mines = Math.round(Number(rawMines) || 0);
      if (!(mines >= MIN_MINES && mines <= MAX_MINES)) {
        throw new GameError(`Choose between ${MIN_MINES} and ${MAX_MINES} bombs`, 400, 'mines_range');
      }

      const updated = await this.db.debitBalance(user.id, stake);
      if (!updated) throw new GameError('Not enough ETB in your wallet', 402, 'insufficient_funds');

      const no = await this.db.nextMinesRoundNo();
      const seed = crypto.randomBytes(32).toString('hex');
      const seedHash = sha256(seed);
      const layout = mineLayout(seed, no, mines);
      const table = this.table(mines);

      const round = {
        no,
        userId: key,
        username: updated.username,
        amount: stake,
        mines,
        maxReveal: TILES - mines,
        layout,
        revealed: [],
        table,
        multiplier: 1,
        status: 'live',
        payout: 0,
        seed,
        seedHash,
        startedAt: new Date(),
        endedAt: null,
      };

      try {
        const saved = await this.db.saveMinesRound({
          no,
          userId: round.userId,
          username: round.username,
          amount: stake,
          mines,
          layout,
          revealed: [],
          status: 'live',
          multiplier: 1,
          payout: 0,
          seed,
          seedHash,
          startedAt: round.startedAt,
        });
        round.dbId = saved.id;
      } catch (err) {
        await this.db.creditBalance(key, stake).catch(() => {});
        console.error('[mines] could not save round', err);
        throw new GameError('Could not start the round, try again', 500, 'round_failed');
      }

      this.rounds.set(key, round);
      this.lastActionAt.set(key, now);
      return { balance: updated.balance, round: publicRound(round) };
    });
  }

  async reveal(user, rawIndex) {
    return this.withLock(async () => {
      const key = String(user.id);
      const round = this.rounds.get(key);
      if (!round) throw new GameError('Start a round first', 400, 'no_round');

      const index = Number(rawIndex);
      if (!isTile(index)) throw new GameError('That tile is not on the board', 400, 'bad_tile');
      if (round.revealed.includes(index)) throw new GameError('That tile is already open', 400, 'tile_open');

      const now = Date.now();
      if (now - (this.lastActionAt.get(key) || 0) < ACTION_GAP_MS) {
        throw new GameError('Slow down a little', 429, 'spam');
      }
      this.lastActionAt.set(key, now);

      // A bomb ends the round immediately: nothing is returned.
      if (round.layout.includes(index)) {
        round.status = 'lost';
        round.payout = 0;
        round.endedAt = new Date();
        this.rounds.delete(key);
        await this.db
          .updateMinesRound(round.dbId, {
            revealed: round.revealed,
            status: 'lost',
            multiplier: round.multiplier,
            payout: 0,
            endedAt: round.endedAt,
          })
          .catch((err) => console.error('[mines] could not save loss', round.dbId, err));
        return { balance: null, round: publicRound(round) };
      }

      round.revealed.push(index);
      round.multiplier = round.table[round.revealed.length] || round.multiplier;

      // Every safe tile cleared: pay the top of the table automatically.
      if (round.revealed.length >= round.maxReveal) {
        round.status = 'won';
        round.payout = Math.floor(round.amount * round.multiplier);
        round.endedAt = new Date();
        this.rounds.delete(key);
        const paid = round.payout
          ? await this.db.creditBalance(key, round.payout, { wins: 1, winnings: round.payout })
          : null;
        await this.db
          .updateMinesRound(round.dbId, {
            revealed: round.revealed,
            status: 'won',
            multiplier: round.multiplier,
            payout: round.payout,
            endedAt: round.endedAt,
          })
          .catch((err) => console.error('[mines] could not save win', round.dbId, err));
        return { balance: paid ? paid.balance : null, round: publicRound(round) };
      }

      await this.db
        .updateMinesRound(round.dbId, { revealed: round.revealed, multiplier: round.multiplier })
        .catch((err) => console.error('[mines] could not save reveal', round.dbId, err));
      return { balance: null, round: publicRound(round) };
    });
  }

  async cashout(user) {
    return this.withLock(async () => {
      const key = String(user.id);
      const round = this.rounds.get(key);
      if (!round) throw new GameError('You have no open round', 400, 'no_round');
      if (!round.revealed.length) {
        throw new GameError('Open a tile before cashing out', 400, 'no_reveal');
      }

      const payout = Math.floor(round.amount * round.multiplier);
      round.status = 'cashed';
      round.payout = payout;
      round.endedAt = new Date();
      this.rounds.delete(key);

      const paid = payout
        ? await this.db.creditBalance(key, payout, { wins: 1, winnings: payout })
        : null;
      await this.db
        .updateMinesRound(round.dbId, {
          revealed: round.revealed,
          status: 'cashed',
          multiplier: round.multiplier,
          payout,
          endedAt: round.endedAt,
        })
        .catch((err) => console.error('[mines] could not save cash-out', round.dbId, err));

      return { balance: paid ? paid.balance : null, round: publicRound(round) };
    });
  }

  /* ------------------------------- admin ------------------------------- */

  async updateConfig(patch = {}) {
    const next = { ...this.cfg };
    if (patch.minBet !== undefined) next.minBet = clamp(Math.round(Number(patch.minBet) || 1), 1, 100000);
    if (patch.maxBet !== undefined) {
      next.maxBet = clamp(Math.round(Number(patch.maxBet) || 1), next.minBet, 1000000);
    }
    if (patch.defaultMines !== undefined) {
      next.defaultMines = clamp(Math.round(Number(patch.defaultMines) || 1), MIN_MINES, MAX_MINES);
    }
    if (patch.houseEdge !== undefined) {
      next.houseEdge = clamp(Math.round(Number(patch.houseEdge) * 10) / 10, 0, 20);
    }
    if (patch.maxMultiplier !== undefined) {
      next.maxMultiplier = clamp(Math.round(Number(patch.maxMultiplier) || 1000), 2, 100000);
    }
    if (patch.paused !== undefined) next.paused = !!patch.paused;

    this.cfg = await this.db.saveMinesConfig(next);
    return this.cfg;
  }
}

module.exports = {
  MinesEngine,
  GameError,
  multiplierTable,
  mineLayout,
  publicRound,
  TILES,
  COLS,
  MIN_MINES,
  MAX_MINES,
};
