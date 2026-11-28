'use strict';

/**
 * Mines player API.
 *
 * Rounds are per-player (unlike Keno's shared clock), so the page restores an
 * open round from /round and there is no socket namespace: the outcome of every
 * action is returned by the action itself.
 */

const express = require('express');
const { wrap, fail } = require('../http');

module.exports = function minesRoutes({ db, mines, auth, throttled }) {
  const router = express.Router();
  const playerOnly = auth.requirePlayer(db);

  router.get(
    '/state',
    wrap(async (req, res) => {
      res.json(await mines.state());
    })
  );

  router.get(
    '/quote',
    wrap(async (req, res) => {
      const quote = mines.quote(req.query.mines);
      if (!quote.table.length) return fail(res, 400, 'mines_range', 'Choose between 1 and 24 bombs');
      res.json(quote);
    })
  );

  router.get(
    '/round',
    playerOnly,
    wrap(async (req, res) => {
      res.json({ round: mines.myRound(req.user.id) });
    })
  );

  router.post(
    '/start',
    playerOnly,
    wrap(async (req, res) => {
      if (throttled(`mines:${req.user.id}`, 60, 60 * 1000)) {
        return fail(res, 429, 'too_many', 'Slow down, try again in a minute');
      }
      const result = await mines.start(req.user, {
        amount: req.body.amount,
        mines: req.body.mines,
      });
      res.json({ ok: true, ...result });
    })
  );

  router.post(
    '/reveal',
    playerOnly,
    wrap(async (req, res) => {
      const result = await mines.reveal(req.user, req.body.index);
      res.json({ ok: true, ...result });
    })
  );

  router.post(
    '/cashout',
    playerOnly,
    wrap(async (req, res) => {
      const result = await mines.cashout(req.user);
      res.json({ ok: true, ...result });
    })
  );

  return router;
};
