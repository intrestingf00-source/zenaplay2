'use strict';

/**
 * Admin API: login, live round control, game settings, players, round history.
 * Kept separate from the player API and mounted under /api/admin.
 */

const express = require('express');
const { wrap, fail } = require('../http');

module.exports = function adminRoutes({ db, engine, auth, throttled }) {
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
      const [users, rounds, stats] = await Promise.all([
        db.listUsers({ limit: 150 }),
        db.listRounds({ limit: 40, includeEmpty: true }),
        db.getStats(),
      ]);
      res.json({
        state: engine.state(),
        config: engine.cfg,
        stats,
        users,
        rounds,
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
