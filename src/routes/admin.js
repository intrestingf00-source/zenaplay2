'use strict';

/**
 * Admin API: login, live round control, game settings, players, round history.
 * Kept separate from the player API and mounted under /api/admin.
 */

const express = require('express');
const { wrap, fail } = require('../http');

module.exports = function adminRoutes({ db, engine, crash, keno, mines, auth, throttled }) {
  const router = express.Router();
  const adminOnly = auth.requireAdmin;

  router.post(
    '/login',
    wrap(async (req, res) => {
      const ip = req.ip || 'unknown';
      if (throttled(`admin:${ip}`, 10, 10 * 60 * 1000)) {
        return fail(res, 429, 'too_many', 'Too many attempts, wait 10 minutes');
      }
      if (!auth.checkAdminPassword(req.body.password)) {
        return fail(res, 401, 'wrong_admin', 'Wrong admin password');
      }
      res.json({ token: auth.signAdmin() });
    })
  );

  router.get(
    '/overview',
    adminOnly,
    wrap(async (req, res) => {
      const [users, rounds, stats, payments, crashStats, kenoState, minesState, minesRecent] = await Promise.all([
        db.listUsers({ limit: 150 }),
        db.listRounds({ limit: 40, includeEmpty: true }),
        db.getStats(),
        db.listPayments({ status: 'pending', limit: 40 }),
        db.getCrashStats(),
        keno.state(),
        mines.state(),
        db.listMinesRounds({ limit: 25 }),
      ]);
      res.json({
        state: engine.state(),
        config: engine.cfg,
        stats,
        users,
        rounds,
        payments,
        crash: { state: crash.state(), stats: crashStats, config: crash.cfg },
        keno: { state: kenoState, stats: kenoState.stats, config: keno.cfg },
        mines: { state: minesState, stats: minesState.stats, config: mines.cfg, recent: minesRecent },
        dbMode: db.mode,
      });
    })
  );

  router.post(
    '/config',
    adminOnly,
    wrap(async (req, res) => {
      const config = await engine.updateConfig(req.body || {});
      res.json({ ok: true, config });
    })
  );

  router.post(
    '/round/end',
    adminOnly,
    wrap(async (req, res) => {
      const result = await engine.forceEnd();
      res.json({ ok: true, result });
    })
  );

  router.post(
    '/round/cancel',
    adminOnly,
    wrap(async (req, res) => {
      const result = await engine.cancelRound();
      res.json({ ok: true, result });
    })
  );

  router.post(
    '/round/start',
    adminOnly,
    wrap(async (req, res) => {
      const round = await engine.adminStart();
      res.json({ ok: true, round });
    })
  );

  /* ------------------------------- crash ------------------------------ */

  router.post(
    '/crash/config',
    adminOnly,
    wrap(async (req, res) => {
      const config = await crash.updateConfig(req.body || {});
      res.json({ ok: true, config });
    })
  );

  router.post(
    '/crash/stop',
    adminOnly,
    wrap(async (req, res) => {
      const result = await crash.forceCrash();
      res.json({ ok: true, result });
    })
  );

  /* -------------------------------- keno ------------------------------- */

  router.post(
    '/keno/config',
    adminOnly,
    wrap(async (req, res) => {
      const config = await keno.updateConfig(req.body || {});
      res.json({ ok: true, config });
    })
  );

  /* ------------------------------- mines ------------------------------- */

  router.post(
    '/mines/config',
    adminOnly,
    wrap(async (req, res) => {
      const config = await mines.updateConfig(req.body || {});
      res.json({ ok: true, config });
    })
  );

  router.post(
    '/pause',
    adminOnly,
    wrap(async (req, res) => {
      const config = await engine.updateConfig({ paused: !!req.body.paused });
      res.json({ ok: true, config });
    })
  );

  router.get(
    '/users',
    adminOnly,
    wrap(async (req, res) => {
      const users = await db.listUsers({ limit: 200, search: req.query.search || '' });
      res.json({ users });
    })
  );

  router.post(
    '/users/:id/balance',
    adminOnly,
    wrap(async (req, res) => {
      const delta = Math.round(Number(req.body.delta) || 0);
      if (!delta) return fail(res, 400, 'positive_amount', 'Amount cannot be zero');
      if (Math.abs(delta) > 1000000) return fail(res, 400, 'too_large', 'Amount too large');
      const user = await db.adjustBalance(req.params.id, delta);
      if (!user) return fail(res, 404, 'player_not_found', 'Player not found');
      res.json({ ok: true, user });
    })
  );

  /* Approve/reject a Telebirr deposit or withdrawal request. Approving moves
     the money; rejecting only closes the request. */
  router.post(
    '/payments/:id',
    adminOnly,
    wrap(async (req, res) => {
      const action = req.body.action;
      if (action !== 'approve' && action !== 'reject') {
        return fail(res, 400, 'positive_amount', 'Unknown action');
      }
      const payment = await db.getPaymentById(req.params.id);
      if (!payment) return fail(res, 404, 'request_not_found', 'Request not found');
      if (payment.status !== 'pending') {
        return fail(res, 409, 'already_decided', 'This request was already handled');
      }
      if (action === 'reject') {
        const updated = await db.setPaymentStatus(payment.id, 'rejected');
        return res.json({ ok: true, request: updated });
      }

      const user = await db.getUserById(payment.userId);
      if (!user) return fail(res, 404, 'player_not_found', 'Player not found');
      if (payment.type === 'withdraw' && (user.balance || 0) < payment.amount) {
        return fail(res, 400, 'insufficient_player_funds', 'The player does not have that much left');
      }
      const delta = payment.type === 'withdraw' ? -payment.amount : payment.amount;
      const updatedUser = await db.adjustBalance(payment.userId, delta);
      const updated = await db.setPaymentStatus(payment.id, 'approved');
      res.json({ ok: true, request: updated, user: updatedUser });
    })
  );

  router.post(
    '/users/:id/ban',
    adminOnly,
    wrap(async (req, res) => {
      const user = await db.setBanned(req.params.id, !!req.body.banned);
      if (!user) return fail(res, 404, 'player_not_found', 'Player not found');
      res.json({ ok: true, user });
    })
  );

  return router;
};
