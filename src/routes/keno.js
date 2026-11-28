'use strict';

/**
 * Keno player API: the shared round clock, the caller's ticket, and the bet
 * endpoint. Rounds are timed, so there is no socket namespace.
 */

const express = require('express');
const { wrap, fail } = require('../http');

module.exports = function kenoRoutes({ db, keno, auth, throttled }) {
  const router = express.Router();
  const playerOnly = auth.requirePlayer(db);

  router.get(
    '/state',
    wrap(async (req, res) => {
      // The player page has no draw feed: leave the list to the admin API.
      const { recent, ...state } = await keno.state();
      res.json(state);
    })
  );

  router.get(
    '/my',
    playerOnly,
    wrap(async (req, res) => {
      const recent = await db.listKenoDraws({ limit: 20, userId: req.user.id });
      res.json({ recent });
    })
  );

  router.get(
    '/ticket',
    playerOnly,
    wrap(async (req, res) => {
      res.json(await keno.myTicket(req.user.id));
    })
  );

  router.post(
    '/draw',
    playerOnly,
    wrap(async (req, res) => {
      if (throttled(`keno:${req.user.id}`, 90, 60 * 1000)) {
        return fail(res, 429, 'too_many', 'Slow down, try again in a minute');
      }
      const result = await keno.placeBet(req.user, {
        amount: req.body.amount,
        mode: req.body.mode,
        picks: req.body.picks,
        side: req.body.side,
      });
      res.json({ ok: true, ...result });
    })
  );

  return router;
};
