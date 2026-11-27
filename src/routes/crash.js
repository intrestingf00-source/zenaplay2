'use strict';

/**
 * Crash player API: public round state, bets, cancels and cash-outs.
 * Realtime ticks go over the /crash socket.io namespace.
 */

const express = require('express');
const { wrap, fail } = require('../http');

module.exports = function crashRoutes({ db, crash, auth, throttled }) {
  const router = express.Router();
  const playerOnly = auth.requirePlayer(db);

  router.get('/state', (req, res) => res.json(crash.state()));

  router.post(
    '/bet',
    playerOnly,
    wrap(async (req, res) => {
      if (throttled(`crash:${req.user.id}`, 30, 60 * 1000)) {
        return fail(res, 429, 'too_many', 'Slow down, try again in a minute');
      }
      const result = await crash.placeBet(req.user, {
        amount: req.body.amount,
        autoCashout: req.body.autoCashout,
      });
      res.json({ ok: true, ...result });
    })
  );

  router.post(
    '/cancel',
    playerOnly,
    wrap(async (req, res) => {
      const result = await crash.cancelBet(req.user);
      res.json({ ok: true, ...result });
    })
  );

  router.post(
    '/cashout',
    playerOnly,
    wrap(async (req, res) => {
      const result = await crash.cashoutAt(req.user.id);
      res.json({ ok: true, ...result });
    })
  );

  return router;
};
