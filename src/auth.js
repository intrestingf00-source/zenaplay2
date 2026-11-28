'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) {
  console.warn('[auth] JWT_SECRET not set — using a temporary secret; sessions end on restart.');
}

let adminPassword = process.env.ADMIN_PASSWORD || '';
if (!adminPassword) {
  adminPassword = crypto.randomBytes(6).toString('hex');
  console.warn('==================================================');
  console.warn('[auth] ADMIN_PASSWORD not set. Temporary admin password:');
  console.warn(`[auth]   ${adminPassword}`);
  console.warn('[auth] Set ADMIN_PASSWORD in the environment for a fixed password.');
  console.warn('==================================================');
}

const TOKEN_TTL = '30d';
const INIT_DATA_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function signUser(user) {
  return jwt.sign({ id: String(user.id), username: user.username, role: 'player' }, SECRET, {
    expiresIn: TOKEN_TTL,
  });
}

function signAdmin() {
  return jwt.sign({ role: 'admin' }, SECRET, { expiresIn: '12h' });
}

function verify(token) {
  try {
    return jwt.verify(token, SECRET);
  } catch {
    return null;
  }
}

function checkAdminPassword(input) {
  const a = Buffer.from(String(input || ''));
  const b = Buffer.from(adminPassword);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Verify the signed initData a Telegram Mini App receives in
 * window.Telegram.WebApp.initData.
 *
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *   secret_key = HMAC_SHA256("WebAppData", bot_token)
 *   hash       = HMAC_SHA256(secret_key, data_check_string)
 * where data_check_string is every field except `hash` as `key=value`,
 * sorted by key and joined with "\n".
 *
 * Returns the Telegram user object, or null when the data is forged/stale.
 */
function verifyTelegramInitData(initData, botToken) {
  if (!initData || !botToken) return null;

  let params;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return null;
  }

  const hash = params.get('hash') || '';
  if (!/^[0-9a-f]{64}$/i.test(hash)) return null;
  params.delete('hash');

  const pairs = [];
  for (const [key, value] of params) pairs.push([key, value]);
  // Telegram requires sorting by key, not by the whole `key=value` line.
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computed = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const expected = Buffer.from(computed, 'hex');
  const received = Buffer.from(hash, 'hex');
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) return null;

  const authDate = Number(params.get('auth_date') || 0) * 1000;
  if (!authDate || Date.now() - authDate > INIT_DATA_MAX_AGE_MS) return null;

  let user;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch {
    return null;
  }
  if (!user || !user.id) return null;
  return user;
}

/** Display name straight from the Telegram profile. */
function telegramName(tgUser) {
  const full = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ').trim();
  const fallback = tgUser.username
    ? String(tgUser.username)
    : `Player ${String(tgUser.id).slice(-4)}`;
  return (full || fallback).slice(0, 32);
}

function bearer(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}

/** Express middleware: requires a valid player token with an existing, unbanned account. */
function requirePlayer(db) {
  return async (req, res, next) => {
    const payload = verify(bearer(req));
    if (!payload || payload.role !== 'player') {
      return res.status(401).json({ error: 'Please sign in to continue', code: 'signed_out' });
    }
    const user = await db.getUserById(payload.id);
    if (!user) return res.status(401).json({ error: 'Account not found', code: 'account_missing' });
    if (user.banned) return res.status(403).json({ error: 'This account is suspended', code: 'banned' });
    req.user = user;
    next();
  };
}

/** Express middleware: requires an admin token. */
function requireAdmin(req, res, next) {
  const payload = verify(bearer(req));
  if (!payload || payload.role !== 'admin') {
    return res.status(401).json({ error: 'Admin login required', code: 'admin_login' });
  }
  req.admin = payload;
  next();
}

module.exports = {
  signUser,
  signAdmin,
  verify,
  checkAdminPassword,
  verifyTelegramInitData,
  telegramName,
  requirePlayer,
  requireAdmin,
  bearer,
};
