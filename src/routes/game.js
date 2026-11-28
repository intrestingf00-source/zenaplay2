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

      // Per-request dev bypass: when the game page is opened with ?dev=1 (or the
      // client sends devBypass), allow the browser dev identity even when a bot
      // token is set. Production clients never send this, so Telegram-only stays
      // enforced for real users.
      const devBypass =
        (req.query && req.query.dev === '1') ||
        (req.body && req.body.devBypass === true) ||
        (process.env.ALLOW_DEV_LOGIN === '1') ||
        !botToken;

      const initData = String(req.body.initData || '');
      let identity = null;

      if (initData) {
        let tgUser = auth.verifyTelegramInitData(initData, botToken);
        // No bot token configured: trust the (unsigned) Telegram profile so the
        // Mini App still works while developing/testing without @BotFather.
        if (!tgUser && !botToken) {
          try {
            const params = new URLSearchParams(initData);
            tgUser = JSON.parse(params.get('user') || 'null');
            if (!tgUser || !tgUser.id) tgUser = null;
          } catch {
            tgUser = null;
          }
        }
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
      } else if (devBypass) {
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

  /* Telebirr top-ups: the player sends money to the admin's Telebirr number
     and pastes the confirmation message. The request waits for the admin. */
  router.post(
    '/wallet/deposit',
    playerOnly,
    wrap(async (req, res) => {
      if (throttled(`pay:${req.user.id}`, 6, 60 * 1000)) {
        return fail(res, 429, 'too_many', 'Slow down, try again in a minute');
      }
      const amount = Math.round(Number(req.body.amount) || 0);
      if (!amount || amount <= 0) return fail(res, 400, 'positive_amount', 'Enter a positive amount');
      if (amount > 200000) return fail(res, 400, 'too_large', 'Amount too large');
      const text = String(req.body.text || '').trim();
      if (text.length < 6) return fail(res, 400, 'invalid_text', 'Paste the Telebirr transaction message');

      const request = await db.createPayment({
        userId: req.user.id,
        username: req.user.username,
        telegramId: req.user.telegramId,
        type: 'deposit',
        amount,
        text,
      });
      res.json({ ok: true, request });
    })
  );

  router.post(
    '/wallet/withdraw',
    playerOnly,
    wrap(async (req, res) => {
      if (throttled(`pay:${req.user.id}`, 6, 60 * 1000)) {
        return fail(res, 429, 'too_many', 'Slow down, try again in a minute');
      }
      const amount = Math.round(Number(req.body.amount) || 0);
      if (!amount || amount <= 0) return fail(res, 400, 'positive_amount', 'Enter a positive amount');
      if (amount > 200000) return fail(res, 400, 'too_large', 'Amount too large');
      if (amount > (req.user.balance || 0)) {
        return fail(res, 400, 'insufficient_funds', 'Not enough ETB in your wallet');
      }
      const phone = String(req.body.phone || '').replace(/[\s-]/g, '');
      if (!/^(?:\+?251|0)?9\d{8}$/.test(phone)) {
        return fail(res, 400, 'invalid_phone', 'Enter a valid Telebirr number');
      }

      const request = await db.createPayment({
        userId: req.user.id,
        username: req.user.username,
        telegramId: req.user.telegramId,
        type: 'withdraw',
        amount,
        phone,
      });
      res.json({ ok: true, request });
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
