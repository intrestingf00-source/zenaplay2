'use strict';

/**
 * Crash engine.
 *
 * One shared round for everybody: a short betting window, then a multiplier
 * that grows until the round "crashes". Players cash out before the crash and
 * keep bet × multiplier; the rest of the bets stay in the house.
 *
 * The crash point is fixed before the round starts and derived from a secret
 * seed (HMAC-SHA256). The SHA-256 of that seed is published while betting, and
 * the seed itself is revealed after the crash, so every round can be verified.
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { GameError } = require('./engine');

const HISTORY_SIZE = 24;
const BET_GAP_MS = 350;
const COOLDOWN_MS = 3500;

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const round2 = (n) => Math.floor(n * 100) / 100;

/**
 * P(crash >= m) = (1 - edge) / m, so cashing out at any target returns
 * (1 - edge) of the stake in expectation — the house edge is exact.
 */
function crashPoint(seed, roundNo, houseEdge, maxMultiplier) {
  const digest = crypto.createHmac('sha256', seed).update(String(roundNo)).digest('hex');
  const n = parseInt(digest.slice(0, 13), 16);
  const u = n / 2 ** 52;
  const edge = clamp(Number(houseEdge) || 0, 0, 20) / 100;
  const raw = (1 - edge) / Math.max(1e-9, 1 - u);
  const capped = Math.min(Number(maxMultiplier) || 300, raw);
  return Math.max(1, round2(capped));
}

class CrashEngine extends EventEmitter {
  constructor(db) {
    super();
    this.db = db;
    this.cfg = null;
    /** betting | running | crashed | idle */
    this.phase = 'idle';
    this.roundNo = 0;
    this.seed = '';
    this.seedHash = '';
    this.crashAt = 1;
    this.bets = [];
    this.history = [];
    this.bettingEndsAt = 0;
    this.startedAt = 0;
    this.lastBetAt = new Map();
    this.chain = Promise.resolve();
    this.starting = false;
    this.tickTimer = null;
    this.nextTimer = null;
  }

  /* ----------------------------- lifecycle ----------------------------- */

  async init() {
    this.cfg = await this.db.getCrashConfig();
    this.history = (await this.db.listCrashRounds({ limit: HISTORY_SIZE })).map((r) => ({
      no: r.no,
      crashAt: r.crashAt,
    }));

    if (this.cfg.paused) {
      this.phase = 'idle';
      this.emitState();
    } else {
      await this.startBetting();
    }

    this.tickTimer = setInterval(() => this.tick(), 100);
    if (this.tickTimer.unref) this.tickTimer.unref();
    this.emitState();
  }

  stop() {
    clearInterval(this.tickTimer);
    clearTimeout(this.nextTimer);
  }

  /** Serializes bets, cash-outs and payouts so money can never interleave. */
  withLock(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  /* ------------------------------- state ------------------------------- */

  multiplier() {
    if (this.phase === 'crashed') return this.crashAt;
    if (this.phase !== 'running') return 1;
    const t = Math.max(0, Date.now() - this.startedAt) / 1000;
    return Math.min(this.crashAt, Math.exp(this.cfg.growth * t));
  }

  state() {
    const betting = this.phase === 'betting';
    const totals = this.bets.reduce(
      (acc, b) => {
        acc.bet += b.amount;
        acc.payout += b.payout || 0;
        if (b.cashedAt) acc.cashed += 1;
        return acc;
      },
      { bet: 0, payout: 0, cashed: 0 }
    );

    return {
      serverTime: Date.now(),
      phase: this.phase,
      paused: !!this.cfg.paused,
      roundNo: this.roundNo,
      seedHash: this.seedHash,
      seed: this.phase === 'crashed' ? this.seed : '',
      crashAt: this.phase === 'crashed' ? this.crashAt : null,
      multiplier: this.phase === 'crashed' ? this.crashAt : this.phase === 'running' ? this.multiplier() : 1,
      startedAt: this.phase === 'running' || this.phase === 'crashed' ? this.startedAt : 0,
      msLeft: betting ? Math.max(0, this.bettingEndsAt - Date.now()) : 0,
      online: this.emitOnline ? this.emitOnline() : 0,
      config: {
        minBet: this.cfg.minBet,
        maxBet: this.cfg.maxBet,
        betSeconds: this.cfg.betSeconds,
        houseEdge: this.cfg.houseEdge,
        growth: this.cfg.growth,
        maxMultiplier: this.cfg.maxMultiplier,
      },
      totals,
      bets: this.bets.map((b) => ({
        userId: b.userId,
        username: b.username,
        photoUrl: b.photoUrl || '',
        amount: b.amount,
        autoCashout: b.autoCashout || 0,
        cashedAt: b.cashedAt || 0,
        payout: b.payout || 0,
      })),
      history: this.history,
    };
  }

  emitState() {
    this.emit('state', this.state());
  }

  /* -------------------------------- loop ------------------------------- */

  tick() {
    if (this.phase === 'betting') {
      const left = Math.max(0, this.bettingEndsAt - Date.now());
      if (left <= 0) {
        this.beginRound().catch((err) => console.error('[crash] begin failed', err));
        return;
      }
      this.emit('tick', { phase: 'betting', msLeft: left, serverTime: Date.now() });
      return;
    }

    if (this.phase !== 'running') return;

    const m = this.multiplier();
    this.autoCashouts(m);

    if (m >= this.crashAt) {
      this.crash().catch((err) => console.error('[crash] crash failed', err));
      return;
    }
    this.emit('tick', { phase: 'running', multiplier: m, serverTime: Date.now() });
  }

  async beginRound() {
    if (this.starting || this.phase !== 'betting') return;
    this.starting = true;
    try {
      this.phase = 'running';
      this.startedAt = Date.now();
      console.log(`[crash] round #${this.roundNo} in the air (${this.bets.length} bets)`);
      this.emitState();
    } finally {
      this.starting = false;
    }
  }

  autoCashouts(m) {
    for (const bet of this.bets) {
      if (bet.cashedAt || !bet.autoCashout) continue;
      if (m >= bet.autoCashout && bet.autoCashout < this.crashAt) {
        this.cashoutAt(bet.userId, bet.autoCashout, true).catch(() => {});
      }
    }
  }

  /* ------------------------------- rounds ------------------------------ */

  async startBetting() {
    clearTimeout(this.nextTimer);
    if (this.cfg.paused) {
      this.phase = 'idle';
      this.emitState();
      return;
    }

    this.roundNo = await this.db.nextCrashRoundNo();
    this.seed = crypto.randomBytes(32).toString('hex');
    this.seedHash = sha256(this.seed);
    this.crashAt = crashPoint(this.seed, this.roundNo, this.cfg.houseEdge, this.cfg.maxMultiplier);
    this.bets = [];
    this.phase = 'betting';
    this.bettingEndsAt = Date.now() + clamp(this.cfg.betSeconds, 3, 60) * 1000;
    this.emit('betting', {
      roundNo: this.roundNo,
      seedHash: this.seedHash,
      msLeft: this.bettingEndsAt - Date.now(),
    });
    this.emitState();
  }

  async crash() {
    if (this.phase !== 'running') return null;
    this.phase = 'crashed';

    const crashAt = this.crashAt;
    const totalBet = this.bets.reduce((sum, b) => sum + b.amount, 0);
    const totalPayout = this.bets.reduce((sum, b) => sum + (b.payout || 0), 0);
    const record = {
      no: this.roundNo,
      seed: this.seed,
      seedHash: this.seedHash,
      crashAt,
      bets: this.bets.map((b) => ({
        userId: b.userId,
        username: b.username,
        photoUrl: b.photoUrl || '',
        amount: b.amount,
        autoCashout: b.autoCashout || 0,
        cashedAt: b.cashedAt || 0,
        payout: b.payout || 0,
      })),
      totalBet,
      totalPayout,
      houseProfit: totalBet - totalPayout,
      startedAt: new Date(this.startedAt),
      crashedAt: new Date(),
    };

    try {
      await this.db.saveCrashRound(record);
    } catch (err) {
      console.error('[crash] could not save round', err);
    }

    this.history.unshift({ no: this.roundNo, crashAt });
    this.history = this.history.slice(0, HISTORY_SIZE);

    console.log(
      `[crash] round #${this.roundNo} crashed at ${crashAt.toFixed(2)}x — bets ${totalBet} ETB, paid ${totalPayout} ETB`
    );
    this.emit('crashed', {
      roundNo: this.roundNo,
      crashAt,
      seed: this.seed,
      totalBet,
      totalPayout,
      players: this.bets.length,
    });
    this.emitState();

    this.nextTimer = setTimeout(() => {
      this.startBetting().catch((err) => console.error('[crash] next round failed', err));
    }, COOLDOWN_MS);
    if (this.nextTimer.unref) this.nextTimer.unref();

    return { crashAt, totalBet, totalPayout };
  }

  /* -------------------------------- bets ------------------------------- */

  async placeBet(user, { amount, autoCashout }) {
    return this.withLock(async () => {
      if (this.cfg.paused) throw new GameError('Crash is paused by the admin', 400, 'paused');
      if (this.phase !== 'betting' || Date.now() >= this.bettingEndsAt) {
        throw new GameError('Betting is closed — wait for the next round', 400, 'betting_closed');
      }

      const now = Date.now();
      const last = this.lastBetAt.get(user.id) || 0;
      if (now - last < BET_GAP_MS) throw new GameError('Slow down a little', 429, 'spam');
      if (this.bets.some((b) => b.userId === String(user.id))) {
        throw new GameError('You already have a bet in this round', 400, 'already_bet');
      }

      const stake = Math.round(Number(amount) || 0);
      if (!stake || stake < this.cfg.minBet) {
        throw new GameError(`Minimum bet is ${this.cfg.minBet} ETB`, 400, 'min_bet');
      }
      if (stake > this.cfg.maxBet) {
        throw new GameError(`Maximum bet is ${this.cfg.maxBet} ETB`, 400, 'max_bet');
      }

      let auto = Number(autoCashout) || 0;
      auto = auto ? clamp(round2(auto), 1.01, this.cfg.maxMultiplier) : 0;

      const updated = await this.db.debitBalance(user.id, stake);
      if (!updated) throw new GameError('Not enough ETB in your wallet', 402, 'insufficient_funds');

      this.lastBetAt.set(user.id, now);
      const bet = {
        userId: String(updated.id),
        username: updated.username,
        photoUrl: updated.photoUrl || '',
        amount: stake,
        autoCashout: auto,
        cashedAt: 0,
        payout: 0,
      };
      this.bets.push(bet);

      this.emit('bets', { roundNo: this.roundNo, count: this.bets.length });
      this.emitState();

      return { balance: updated.balance, roundNo: this.roundNo, bet };
    });
  }

  async cancelBet(user) {
    return this.withLock(async () => {
      if (this.phase !== 'betting') throw new GameError('The round already started', 400, 'betting_closed');
      const index = this.bets.findIndex((b) => b.userId === String(user.id));
      if (index === -1) throw new GameError('You do not have a bet in this round', 400, 'no_bet');

      const [bet] = this.bets.splice(index, 1);
      this.lastBetAt.delete(bet.userId);
      const updated = await this.db.creditBalance(bet.userId, bet.amount);
      this.emitState();
      return { balance: updated ? updated.balance : null };
    });
  }

  async cashoutAt(userId, target, auto = false) {
    return this.withLock(async () => {
      if (this.phase !== 'running') throw new GameError('The round is over — wait for the next one', 400, 'too_late');

      const bet = this.bets.find((b) => b.userId === String(userId));
      if (!bet) throw new GameError('You do not have a bet in this round', 400, 'no_bet');
      if (bet.cashedAt) throw new GameError('You already cashed out', 400, 'already_cashed');

      const current = this.multiplier();
      // An auto cash-out armed below the crash point is honoured even if the
      // tick that notices it lands a moment after the crash moment.
      if (!auto && current >= this.crashAt) throw new GameError('Too late — it crashed', 400, 'too_late');

      const multiplier = round2(Math.max(1, Math.min(Number(target) || current, current)));
      const payout = Math.floor(bet.amount * multiplier);
      const user = await this.db.creditBalance(bet.userId, payout);

      bet.cashedAt = multiplier;
      bet.payout = payout;

      this.emit('cashout', {
        roundNo: this.roundNo,
        username: bet.username,
        amount: bet.amount,
        multiplier,
        payout,
      });
      this.emitState();

      return { balance: user ? user.balance : null, multiplier, payout, roundNo: this.roundNo };
    });
  }

  /* ------------------------------- admin ------------------------------- */

  async forceCrash() {
    if (this.phase !== 'running') throw new GameError('No round is flying right now', 400, 'no_round');
    this.crashAt = Math.max(1, round2(this.multiplier()));
    return this.crash();
  }

  async updateConfig(patch = {}) {
    const next = { ...this.cfg };
    if (patch.minBet !== undefined) next.minBet = clamp(Math.round(Number(patch.minBet) || 1), 1, 100000);
    if (patch.maxBet !== undefined) next.maxBet = clamp(Math.round(Number(patch.maxBet) || 1), next.minBet, 1000000);
    if (patch.betSeconds !== undefined) next.betSeconds = clamp(Math.round(Number(patch.betSeconds) || 3), 3, 60);
    if (patch.houseEdge !== undefined) next.houseEdge = clamp(Math.round(Number(patch.houseEdge) * 10) / 10, 0, 20);
    if (patch.paused !== undefined) next.paused = !!patch.paused;

    this.cfg = await this.db.saveCrashConfig(next);

    if (this.cfg.paused && this.phase === 'betting') {
      // Close the lobby and give every stake back.
      for (const bet of this.bets) await this.db.creditBalance(bet.userId, bet.amount);
      this.bets = [];
      this.phase = 'idle';
    } else if (!this.cfg.paused && this.phase === 'idle') {
      await this.startBetting();
    }

    this.emitState();
    return this.cfg;
  }
}

module.exports = { CrashEngine, GameError, crashPoint };
