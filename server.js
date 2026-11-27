'use strict';

require('dotenv').config();

const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');

const db = require('./src/db');
const auth = require('./src/auth');
const { createThrottle } = require('./src/http');
const { GameEngine, GameError } = require('./src/engine');
const { CrashEngine } = require('./src/crash');
const gameRoutes = require('./src/routes/game');
const crashRoutes = require('./src/routes/crash');
const adminRoutes = require('./src/routes/admin');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || (process.env.RENDER ? '0.0.0.0' : '127.0.0.1');
const PUBLIC_DIR = path.join(__dirname, 'public');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });
const adminNs = io.of('/admin');
const crashNs = io.of('/crash');

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

const engine = new GameEngine(db);
const crash = new CrashEngine(db);
const { throttled } = createThrottle();

/* ------------------------------------------------------------------ */
/* Static apps: / = games menu, /game = Time Bomb, /admin, /shared     */
/* ------------------------------------------------------------------ */

app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    db: db.mode,
    rounds: engine.round?.no || null,
    telegram: !!process.env.TELEGRAM_BOT_TOKEN,
    crash: crash.phase,
    uptime: Math.round(process.uptime()),
  });
});

// Serve the admin panel and the games without trailing-slash redirects.
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin', 'index.html')));
app.get('/game', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'game', 'index.html')));
app.get('/crash', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'crash', 'index.html')));

const ASSET_CACHE = process.env.NODE_ENV === 'production' ? '10m' : 0;
app.use('/shared', express.static(path.join(PUBLIC_DIR, 'shared'), { maxAge: ASSET_CACHE }));
app.use('/admin', express.static(path.join(PUBLIC_DIR, 'admin'), { extensions: ['html'], maxAge: ASSET_CACHE }));
app.use('/game', express.static(path.join(PUBLIC_DIR, 'game'), { extensions: ['html'], maxAge: ASSET_CACHE }));
app.use('/crash', express.static(path.join(PUBLIC_DIR, 'crash'), { extensions: ['html'], maxAge: ASSET_CACHE }));
// Root is the Telegram entry menu; the games themselves live on their own paths.
app.use(express.static(path.join(PUBLIC_DIR, 'menu'), { extensions: ['html'], maxAge: ASSET_CACHE }));

/* ------------------------------------------------------------------ */
/* APIs                                                                */
/* ------------------------------------------------------------------ */

app.use('/api/admin', adminRoutes({ db, engine, crash, auth, throttled }));
app.use('/api/crash', crashRoutes({ db, crash, auth, throttled }));
app.use('/api', gameRoutes({ db, engine, auth, throttled }));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found', code: 'not_found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof GameError) {
    return res.status(err.status || 400).json({ error: err.message, code: err.code || 'game_error' });
  }
  console.error('[http]', err);
  res.status(500).json({ error: 'Server error, try again', code: 'server' });
});

/* ------------------------------------------------------------------ */
/* Realtime                                                            */
/* ------------------------------------------------------------------ */

io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  const payload = token ? auth.verify(token) : null;
  if (payload?.role === 'player') {
    const user = await db.getUserById(payload.id);
    if (user && !user.banned) socket.user = user;
  }
  next();
});

adminNs.use((socket, next) => {
  const payload = auth.verify(socket.handshake.auth?.token);
  if (!payload || payload.role !== 'admin') return next(new Error('unauthorized'));
  next();
});

engine.emitOnline = () => io.engine.clientsCount;

engine.on('state', (state) => {
  state.online = engine.emitOnline();
  io.emit('state', state);
  adminNs.emit('state', state);
});

engine.on('tick', (tick) => io.emit('tick', tick));

engine.on('deposit', (info) => {
  io.emit('round:deposit', info);
  adminNs.emit('round:deposit', info);
});

engine.on('ended', (info) => {
  io.emit('round:ended', info);
  adminNs.emit('round:ended', info);
});

/* ------------------------------- crash ------------------------------- */

crash.emitOnline = () => crashNs.sockets.size;

crash.on('state', (state) => {
  state.online = crash.emitOnline();
  crashNs.emit('crash:state', state);
  adminNs.emit('crash:state', state);
});

crash.on('tick', (tick) => crashNs.emit('crash:tick', tick));

crash.on('betting', (info) => {
  crashNs.emit('crash:betting', info);
  adminNs.emit('crash:betting', info);
});

crash.on('bets', (info) => {
  crashNs.emit('crash:bets', info);
  adminNs.emit('crash:bets', info);
});

crash.on('cashout', (info) => {
  crashNs.emit('crash:cashout', info);
  adminNs.emit('crash:cashout', info);
});

crash.on('crashed', (info) => {
  crashNs.emit('crash:crashed', info);
  adminNs.emit('crash:crashed', info);
});

crashNs.on('connection', (socket) => {
  socket.emit('crash:state', crash.state());
});

io.on('connection', (socket) => {
  socket.emit('state', { ...engine.state(), online: engine.emitOnline() });
  io.emit('online', engine.emitOnline());
  socket.on('disconnect', () => io.emit('online', engine.emitOnline()));
});

adminNs.on('connection', (socket) => {
  socket.emit('state', { ...engine.state(), online: engine.emitOnline() });
});

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

(async () => {
  await db.init();
  await engine.init();
  await crash.init();
  server.listen(PORT, HOST, () => {
    console.log(`[server] Time Bomb listening on http://${HOST}:${PORT} (db: ${db.mode})`);
    console.log(`[server] Menu:  http://${HOST}:${PORT}/`);
    console.log(`[server] Game:  http://${HOST}:${PORT}/game`);
    console.log(`[server] Crash: http://${HOST}:${PORT}/crash`);
    console.log(`[server] Admin: http://${HOST}:${PORT}/admin`);
    console.log(
      process.env.TELEGRAM_BOT_TOKEN
        ? '[server] Telegram Mini App sign-in is ON.'
        : '[server] TELEGRAM_BOT_TOKEN missing — telegram users cannot sign in (browser dev login allowed).'
    );
  });
})();

async function shutdown(signal) {
  console.log(`\n[server] ${signal} received, shutting down…`);
  engine.stop();
  crash.stop();
  io.close();
  await db.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
