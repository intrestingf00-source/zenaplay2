'use strict';

const { EventEmitter } = require('events');

const FEED_SIZE = 25;
const SETTLE_COOLDOWN_MS = 7000;

class GameError extends Error {
  constructor(message, status = 400, code = 'game_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

/**
 * Authoritative game engine.
 *
 * Single source of truth for the countdown. Every deposit resets the fuse,
 * grows the pot and makes that player the provisional winner. When the fuse
 * reaches zero the last depositor takes the pot minus the house cut.
 *
 * State is mirrored into MongoDB so restarts/round history survive, but the
 * live timer lives here in memory (one server instance — see README).
 */
class GameEngine extends EventEmitter {
  constructor(db) {
    super();
    this.db = db;
    this.cfg = null;
    this.round = null;
    this.endsAt = 0;
    this.pausedRemaining = 0;
    this.lastDepositAt = new Map();
    this.chain = Promise.resolve();
    this.settling = false;
    this.nextTimer = null;
    this.tickTimer = null;
    this.tickCount = 0;
  }

  /* ----------------------------- lifecycle ----------------------------- */

  async init() {
    this.cfg = await this.db.getConfig();
    const live = await this.db.findLiveRound();
    if (live) {
      this.round = live;
      this.endsAt = new Date(live.endsAt).getTime() || Date.now();
      this.pausedRemaining = Math.max(0, this.endsAt - Date.now());
      console.log(`[engine] resumed round #${live.no} (pot ${live.pot} ETB)`);
    } else {
      await this.startRound();
    }
    this.tickTimer = setInterval(() => this.tick(), 200);
    if (this.tickTimer.unref) this.tickTimer.unref();
    this.emitState();
  }

  stop() {
    clearInterval(this.tickTimer);
    clearTimeout(this.nextTimer);
  }

  /** Serializes deposits / settlements so the pot and timer cannot interleave. */
  withLock(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  /* ------------------------------- state ------------------------------- */

  msLeft() {
    if (!this.round || this.round.status !== 'live') return 0;
    if (this.cfg.paused) return Math.max(0, this.pausedRemaining);
    return Math.max(0, this.endsAt - Date.now());
  }

  state() {
    const r = this.round;
    const cfg = this.cfg;
    return {
      serverTime: Date.now(),
      dbMode: this.db.mode,
      paused: !!cfg.paused,
      online: this.emitOnline ? this.emitOnline() : 0,
      msLeft: this.msLeft(),
      config: {
        entryFee: cfg.entryFee,
        startSeconds: cfg.startSeconds,
        resetSeconds: cfg.resetSeconds,
        houseCut: cfg.houseCut,
        autoStart: cfg.autoStart,
      },
      round: r
        ? {
            id: r.id,
            no: r.no,
            status: r.status,
            pot: r.pot,
            entryFee: r.entryFee,
            resetSeconds: r.resetSeconds,
            depositors: new Set((r.deposits || []).map((d) => String(d.userId))).size,
            depositCount: (r.deposits || []).length,
            lastDepositor: r.lastDepositor,
            deposits: (r.deposits || [])
              .slice(-FEED_SIZE)
              .reverse()
              .map((d) => ({ username: d.username, amount: d.amount, at: d.at })),
            winnerName: r.winnerName || null,
            winnerId: r.winnerId || null,
            payout: r.payout || 0,
            houseCut: r.houseCut || 0,
            endedReason: r.endedReason || null,
            endedAt: r.endedAt || null,
          }
        : null,
    };
  }

  emitState() {
    this.emit('state', this.state());
  }

  tick() {
    if (!this.round) return;
    if (this.cfg.paused) {
      this.emit('tick', { msLeft: this.msLeft(), paused: true, serverTime: Date.now() });
      return;
    }
    const left = this.msLeft();
    if (this.round.status === 'live' && left <= 0) {
      this.settle('timeout').catch((err) => console.error('[engine] settle failed', err));
      return;
    }
    this.emit('tick', { msLeft: left, paused: false, serverTime: Date.now() });
  }

  /* ------------------------------- rounds ------------------------------ */

  async startRound() {
    const cfg = this.cfg;
    const startMs = Math.max(5, Math.round(cfg.startSeconds)) * 1000;
    const now = Date.now();
    const no = await this.db.nextRoundNo();
    const round = await this.db.createRound({
      no,
      status: 'live',
      entryFee: cfg.entryFee,
      resetSeconds: cfg.resetSeconds,
      startSeconds: cfg.startSeconds,
      pot: 0,
      deposits: [],
      depositorCount: 0,
      lastDepositor: null,
      startedAt: new Date(now),
      endsAt: new Date(now + startMs),
    });
    this.round = round;
    this.endsAt = now + startMs;
    this.pausedRemaining = startMs;
    console.log(`[engine] round #${no} live — ${cfg.startSeconds}s on the clock`);
    this.emitState();
    return round;
  }

  scheduleNext(delay, { skipIfEmpty = false } = {}) {
    clearTimeout(this.nextTimer);
    this.nextTimer = setTimeout(async () => {
      try {
        if (skipIfEmpty) return;
        if (!this.cfg.autoStart) {
          this.emitState();
          return;
        }
        await this.withLock(async () => {
          if (this.round && this.round.status === 'live') return;
          await this.startRound();
        });
      } catch (err) {
        console.error('[engine] failed to start next round', err);
      }
    }, delay);
  }

  /* ------------------------------- deposit ----------------------------- */

  async deposit(user) {
    return this.withLock(async () => {
      const r = this.round;
      if (!r || r.status !== 'live') throw new GameError('There is no live round right now', 400, 'round_not_live');
      if (this.cfg.paused) throw new GameError('Game is paused by the admin', 400, 'paused');

      const now = Date.now();
      const gap = Math.max(0, this.cfg.minDepositGapMs || 0);
      const last = this.lastDepositAt.get(user.id) || 0;
      if (gap && now - last < gap) throw new GameError('Slow down — give the button a second', 429, 'spam');

      const fee = r.entryFee;
      const updated = await this.db.spendBalance(user.id, fee);
      if (!updated) {
        const fresh = await this.db.getUserById(user.id);
        throw new GameError(
          fresh && fresh.banned
            ? 'This account is suspended'
            : `Not enough ETB — you need ${fee} to push in`,
          402,
          fresh && fresh.banned ? 'banned' : 'insufficient_funds'
        );
      }

      this.lastDepositAt.set(user.id, now);

      const deposit = { userId: updated.id, username: updated.username, amount: fee, at: new Date(now) };
      const deposits = [...(r.deposits || []), deposit];
      const endsAt = now + Math.max(3, Math.round(r.resetSeconds || 15)) * 1000;

      const saved = await this.db.updateRound(r.id, {
        pot: r.pot + fee,
        deposits,
        depositorCount: new Set(deposits.map((d) => String(d.userId))).size,
        lastDepositor: deposit,
        endsAt: new Date(endsAt),
      });

      this.round = saved || { ...r, pot: r.pot + fee, deposits, lastDepositor: deposit, endsAt: new Date(endsAt) };
      this.endsAt = endsAt;

      this.emit('deposit', {
        username: updated.username,
        amount: fee,
        pot: this.round.pot,
        resetSeconds: r.resetSeconds,
      });
      this.emitState();

      return {
        balance: updated.balance,
        pot: this.round.pot,
        msLeft: this.msLeft(),
        entryFee: fee,
      };
    });
  }

  /* ------------------------------ settlement ---------------------------- */

  async settle(reason = 'timeout') {
    if (this.settling) return null;
    this.settling = true;
    try {
      return await this.withLock(async () => {
        const r = this.round;
        if (!r || r.status !== 'live') return null;

        const now = new Date();

        // Nobody deposited: recycle quietly, nobody wins.
        if (r.pot <= 0) {
          const expired = await this.db.updateRound(r.id, { status: 'expired', endedAt: now });
          this.round = expired;
          this.emitState();
          this.scheduleNext(1500);
          return { expired: true };
        }

        const payer = r.lastDepositor;
        if (!payer) {
          const expired = await this.db.updateRound(r.id, { status: 'expired', endedAt: now });
          this.round = expired;
          this.emitState();
          this.scheduleNext(1500);
          return { expired: true };
        }

        const cutPct = clamp(Number(this.cfg.houseCut) || 0, 0, 100);
        const payout = Math.floor((r.pot * (100 - cutPct)) / 100);
        const houseCut = r.pot - payout;

        const winner = await this.db.creditBalance(payer.userId, payout, { wins: 1, winnings: payout });

        const saved = await this.db.updateRound(r.id, {
          status: 'ended',
          endedAt: now,
          winnerId: payer.userId,
          winnerName: winner ? winner.username : payer.username,
          payout,
          houseCut,
          endedReason: reason,
        });

        this.round = saved;
        const info = {
          roundNo: r.no,
          winnerName: saved.winnerName,
          winnerId: payer.userId,
          payout,
          houseCut,
          pot: r.pot,
          reason,
          deposits: (r.deposits || []).length,
        };
        console.log(`[engine] round #${r.no} ended — ${info.winnerName} wins ${payout} ETB (house ${houseCut})`);
        this.emit('ended', info);
        this.emitState();
        this.scheduleNext(SETTLE_COOLDOWN_MS);
        return info;
      });
    } finally {
      this.settling = false;
    }
  }

  /** Admin: stop the round now and pay the current last depositor. */
  async forceEnd() {
    if (!this.round || this.round.status !== 'live') throw new GameError('No live round to end', 400, 'no_round');
    return this.settle('admin');
  }

  /** Admin: cancel the round and refund every deposit in it. */
  async cancelRound() {
    return this.withLock(async () => {
      const r = this.round;
      if (!r || r.status !== 'live') throw new GameError('No live round to cancel', 400, 'no_round');

      const refunds = new Map();
      for (const d of r.deposits || []) {
        if (!d.userId) continue;
        refunds.set(d.userId, (refunds.get(d.userId) || 0) + d.amount);
      }
      for (const [userId, amount] of refunds) {
        await this.db.creditBalance(userId, amount);
      }

      const saved = await this.db.updateRound(r.id, {
        status: 'cancelled',
        endedAt: new Date(),
        payout: 0,
        houseCut: 0,
        endedReason: 'admin-cancel',
      });
      this.round = saved;
      this.emit('ended', {
        roundNo: r.no,
        winnerName: null,
        payout: 0,
        houseCut: 0,
        pot: r.pot,
        reason: 'cancelled',
        refunded: true,
      });
      this.emitState();
      this.scheduleNext(4000);
      return { refunded: r.pot, players: refunds.size };
    });
  }

  /** Admin: start a new round immediately (also works when autoStart is off). */
  async adminStart() {
    return this.withLock(async () => {
      if (this.round && this.round.status === 'live') {
        throw new GameError('A round is already live', 400, 'round_live');
      }
      clearTimeout(this.nextTimer);
      return this.startRound();
    });
  }

  /* ------------------------------- config ------------------------------ */

  async updateConfig(patch) {
    const wasPaused = !!this.cfg.paused;
    const next = { ...this.cfg };

    if (patch.entryFee !== undefined) next.entryFee = clamp(Math.round(Number(patch.entryFee) || 1), 1, 100000);
    if (patch.startSeconds !== undefined) next.startSeconds = clamp(Math.round(Number(patch.startSeconds) || 5), 5, 600);
    if (patch.resetSeconds !== undefined) next.resetSeconds = clamp(Math.round(Number(patch.resetSeconds) || 3), 3, 600);
    if (patch.houseCut !== undefined) next.houseCut = clamp(Math.round(Number(patch.houseCut) || 0), 0, 50);
    if (patch.startingBalance !== undefined)
      next.startingBalance = clamp(Math.round(Number(patch.startingBalance) || 0), 0, 1000000);
    if (patch.minDepositGapMs !== undefined)
      next.minDepositGapMs = clamp(Math.round(Number(patch.minDepositGapMs) || 0), 0, 10000);
    if (patch.autoStart !== undefined) next.autoStart = !!patch.autoStart;
    if (patch.paused !== undefined) next.paused = !!patch.paused;

    this.cfg = await this.db.saveConfig(next);

    // Freeze / resume the live fuse.
    if (this.round && this.round.status === 'live') {
      if (!wasPaused && this.cfg.paused) {
        this.pausedRemaining = Math.max(0, this.endsAt - Date.now());
      } else if (wasPaused && !this.cfg.paused) {
        this.endsAt = Date.now() + Math.max(1000, this.pausedRemaining);
        await this.db.updateRound(this.round.id, {
          endsAt: new Date(this.endsAt),
          entryFee: this.cfg.entryFee,
          resetSeconds: this.cfg.resetSeconds,
        });
      }
      this.round.entryFee = this.cfg.entryFee;
      this.round.resetSeconds = this.cfg.resetSeconds;
    }

    if (this.round && !wasPaused && this.cfg.paused) {
      await this.db.updateRound(this.round.id, { endsAt: new Date(Date.now() + this.pausedRemaining) });
    }

    this.emitState();
    return this.cfg;
  }
}

module.exports = { GameEngine, GameError };
