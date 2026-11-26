'use strict';

/**
 * Player-facing API: Telegram sign-in, wallet, deposits, public state, history,
 * leaderboard. Kept separate from the admin API on purpose.
 *
 * There are no usernames or passwords: the player is whoever Telegram says
 * they are. The Mini App sends `initData`, the server verifies it with the bot
 * token and returns a session token for that Telegram account.
 */

const express = require('express');
const { wrap, fail } = require('../http');

module.exports = function gameRoutes({ db, engine, auth, throttled }) {
  const router = express.Router();
  const playerOnly = auth.requirePlayer(db);

  const botToken = process.env.TELEGRAM_BOT_TOKEN || '';
  // Local play without Telegram: only while no bot token is configured, or
  // when explicitly enabled. Production with a bot token always requires initData.
  const devLogin = process.env.ALLOW_DEV_LOGIN === '1' || !botToken;
  if (devLogin) {
    console.warn(
      botToken
        ? '[auth] ALLOW_DEV_LOGIN=1 — browser sign-in is enabled outside Telegram.'
        : '[auth] TELEGRAM_BOT_TOKEN is not set — browser sign-in is enabled for local play.'
    );
  }

  router.get('/state', (req, res) => res.json(engine.state()));

  router.get('/config', (req, res) => {
    const { entryFee, startSeconds, resetSeconds, houseCut, startingBalance } = engine.cfg;
    res.json({ entryFee, startSeconds, resetSeconds, houseCut, startingBalance, dbMode: db.mode });
  });

  router.post(
    '/auth/telegram',
    wrap(async (req, res) => {
      const ip = req.ip || 'unknown';
      if (throttled(`tg:${ip}`, 180, 60 * 1000)) {
        return fail(res, 429, 'too_many', 'Too many attempts, wait a minute');
      }

      const initData = String(req.body.initData || '');
      let identity = null;

      if (initData) {
        const tgUser = auth.verifyTelegramInitData(initData, botToken);
        if (!tgUser) {
          return fail(
            res,
            401,
            'telegram_invalid',
            'Telegram sign-in failed — reopen the game from the bot'
          );
        }
        identity = {
          telegramId: String(tgUser.id),
          username: auth.telegramName(tgUser),
          photoUrl: String(tgUser.photo_url || ''),
        };
      } else if (devLogin) {
        const devId =
          String(req.body.devId || '')
            .replace(/[^a-zA-Z0-9_-]/g, '')
            .slice(0, 40) || 'local';
        const name = String(req.body.devName || '').trim().slice(0, 32) || 'Local Player';
        identity = { telegramId: `dev-${devId}`, username: name, photoUrl: '' };
      } else {
        return fail(res, 401, 'telegram_only', 'Open this game inside Telegram to play');
      }

      const user = await db.upsertTelegramUser({
        ...identity,
        startingBalance: engine.cfg.startingBalance,
      });
      if (!user) return fail(res, 500, 'server', 'Could not open your player account');
      if (user.banned) return fail(res, 403, 'banned', 'This account is suspended');

      res.json({ token: auth.signUser(user), user });
    })
  );

  router.get(
    '/me',
    playerOnly,
    wrap(async (req, res) => {
      res.json({ user: req.user, state: engine.state() });
    })
  );

  router.post(
    '/deposit',
    playerOnly,
    wrap(async (req, res) => {
      const result = await engine.deposit(req.user);
      res.json({ ok: true, ...result });
    })
  );

  router.get(
    '/history',
    wrap(async (req, res) => {
      const rounds = await db.listRounds({ limit: 25 });
      res.json({ rounds });
    })
  );

  router.get(
    '/leaderboard',
    wrap(async (req, res) => {
      const players = await db.topUsers(15);
      const stats = await db.getStats();
      res.json({
        players: players.map((p) => ({ username: p.username, wins: p.wins, winnings: p.winnings })),
        stats,
      });
    })
  );

  return router;
};
