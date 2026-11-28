'use strict';

const t = (key, vars) => window.I18n.t(key, vars);

/* ------------------------------------------------------------------ */
/* Tiny DOM helpers                                                    */
/* ------------------------------------------------------------------ */
const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.max(0, Math.round(Number(n) || 0)).toLocaleString('en-US');

const el = {
  balance: $('balance'),
  walletBtn: $('walletBtn'),
  statusChip: $('statusChip'),
  statusText: $('statusText'),
  playersChip: $('playersChip'),
  roundChip: $('roundChip'),
  bombCard: $('bombCard'),
  ring: $('ring'),
  clock: $('clock'),
  clockUnit: $('clockUnit'),
  pot: $('pot'),
  lastLine: $('lastLine'),
  depositBtn: $('depositBtn'),
  depMain: $('depMain'),
  depSub: $('depSub'),
  hint: $('hint'),
  feed: $('feed'),
  feedCount: $('feedCount'),
  winner: $('winner'),
  winName: $('winName'),
  winAmount: $('winAmount'),
  winCut: $('winCut'),
  winNext: $('winNext'),
  toast: $('toast'),
  explosion: $('explosion'),
  muteBtn: $('muteBtn'),
  muteIcon: $('muteIcon'),
  avatar: $('avatar'),
  meName: $('meName'),
  meSub: $('meSub'),
  meBalance: $('meBalance'),
  meWins: $('meWins'),
  meWinnings: $('meWinnings'),
  mePushes: $('mePushes'),
};

const S = {
  token: '',
  me: null,
  game: null,
  sync: { msLeft: 0, at: 0, paused: false },
  view: 'play',
  winnerTimer: null,
  audio: null,
  muted: false,
};

/* ------------------------------------------------------------------ */
/* Session                                                             */
/* ------------------------------------------------------------------ */
async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (S.token) headers.Authorization = `Bearer ${S.token}`;
  const res = await fetch(path, { ...options, headers });
  let body = {};
  try {
    body = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    let message = body.error || `Request failed (${res.status})`;
    if (body.code) {
      const translated = t(`err.${body.code}`);
      if (translated && translated !== `err.${body.code}`) message = translated;
    }
    const err = new Error(message);
    err.status = res.status;
    err.code = body.code;
    throw err;
  }
  return body;
}

let toastTimer = null;
function toast(message, kind = '') {
  el.toast.textContent = message;
  el.toast.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.className = `toast ${kind}`;
  }, 2600);
}

async function refreshMe() {
  if (!S.token) {
    S.me = null;
    renderAccount();
    return;
  }
  try {
    const data = await api('/api/me');
    S.me = data.user;
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      S.token = '';
      S.me = null;
    }
  }
  renderAccount();
}

/* ------------------------------------------------------------------ */
/* Telegram Mini App sign-in                                           */
/* ------------------------------------------------------------------ */
const telegram = () => (window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null);

function devIdentity() {
  // Local play without Telegram: keep a stable fake id per browser.
  try {
    let id = localStorage.getItem('tb_dev_id');
    if (!id) {
      id = Math.random().toString(36).slice(2, 10);
      localStorage.setItem('tb_dev_id', id);
    }
    let name = new URLSearchParams(location.search).get('name') || '';
    if (!name) {
      const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
      const u = tg && tg.initDataUnsafe && tg.initDataUnsafe.user ? tg.initDataUnsafe.user : null;
      if (u) {
        const full = [u.first_name, u.last_name].filter(Boolean).join(' ').trim();
        name = full || (u.username ? String(u.username) : '');
      }
    }
    return { devId: id, devName: String(name || '').trim().slice(0, 32) };
  } catch {
    return { devId: 'local', devName: '' };
  }
}

async function signIn() {
  const tg = telegram();
  if (tg) {
    try {
      tg.ready();
      tg.expand();
      if (tg.setHeaderColor) tg.setHeaderColor('#07050c');
      if (tg.setBackgroundColor) tg.setBackgroundColor('#07050c');
    } catch {
      /* older Telegram clients */
    }
  }

  const bypass = new URL(location.href).searchParams.get('dev') === '1';
  const payload = {
    initData: (tg && tg.initData) || '',
    ...devIdentity(),
    ...(bypass ? { devBypass: true } : {}),
  };
  try {
    const data = await api('/api/auth/telegram', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    S.token = data.token;
    S.me = data.user;
  } catch (err) {
    S.token = '';
    S.me = null;
    if (err.code === 'telegram_invalid' || err.code === 'telegram_only') {
      toast(err.message, 'bad');
    }
  }
  renderAccount();
}

/* ------------------------------------------------------------------ */
/* Mute toggle                                                         */
/* ------------------------------------------------------------------ */
function setMuted(muted) {
  S.muted = !!muted;
  if (S.muted) {
    if (S.audio) {
      try {
        S.audio.stop();
      } catch {}
      S.audio = null;
    }
  } else if (!S.audio && S.view === 'play') {
    try {
      S.audio = makeAudio();
    } catch {}
  }
  el.muteIcon.textContent = S.muted ? '🔇' : '🔊';
  el.muteIcon.classList.toggle('mute-on', !S.muted);
  el.muteIcon.classList.toggle('mute-off', S.muted);
  el.muteBtn.setAttribute('aria-pressed', S.muted ? 'true' : 'false');
  try {
    localStorage.setItem('tb_mute', S.muted ? '1' : '0');
  } catch {
    /* storage blocked */
  }
}
el.muteBtn.addEventListener('click', () => {
  // A tap is the gesture browsers require before any sound may play.
  unlockAudio();
  const next = !S.muted;
  setMuted(next);
  toast(next ? t('toast.muted') : t('toast.unmuted'), 'ok');
});
try {
  S.muted = localStorage.getItem('tb_mute') === '1';
} catch {
  S.muted = false;
}
if (S.muted) {
  el.muteIcon.textContent = '🔇';
  el.muteIcon.classList.remove('mute-on');
  el.muteIcon.classList.add('mute-off');
}

/* ------------------------------------------------------------------ */
/* Navigation                                                          */
/* ------------------------------------------------------------------ */
function switchView(view) {
  S.view = view;
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === view));
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === view));
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (view === 'board') loadBoard();
  if (view === 'me') renderAccount();
  // Only the play view carries the fuse countdown.
  if (view !== 'play') {
    if (S.audio) {
      try { S.audio.stop(); } catch {}
      S.audio = null;
    }
  } else if (S.muted !== true && !S.audio) {
    try { S.audio = makeAudio(); } catch {}
  }
}

document.querySelectorAll('.tabbar button').forEach((btn) => {
  btn.addEventListener('click', () => switchView(btn.dataset.tab));
});

el.walletBtn.addEventListener('click', () => switchView('me'));

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */
const CIRC = 2 * Math.PI * 88;
el.ring.style.strokeDasharray = `${CIRC}`;

function getMsLeft() {
  const g = S.game;
  if (!g || !g.round || g.round.status !== 'live') return 0;
  if (g.paused) return g.msLeft;
  const elapsed = performance.now() - S.sync.at;
  return Math.max(0, S.sync.msLeft - elapsed);
}

function renderClock() {
  const g = S.game;
  if (!g) return;
  const left = getMsLeft();
  const secs = left / 1000;
  const text = left >= 10000 ? String(Math.ceil(secs)) : left > 0 ? secs.toFixed(1) : '00';
  if (el.clock.textContent !== text) el.clock.textContent = text;
  el.clockUnit.textContent = t('timer.sec');

  const windowMs = Math.max((g.round?.resetSeconds || 15) * 1000, left);
  const frac = Math.min(1, Math.max(0, left / windowMs));
  el.ring.style.strokeDashoffset = `${CIRC * (1 - frac)}`;

  const danger = g.round?.status === 'live' && !g.paused && left <= 5000 && left > 0;
  el.bombCard.classList.toggle('danger', !!danger);
}

function statusLabel(g) {
  if (!g.round) return { text: t('status.idle'), cls: 'chip' };
  if (g.paused) return { text: t('status.paused'), cls: 'chip paused' };
  if (g.round.status === 'live') return { text: t('status.live'), cls: 'chip live' };
  if (g.round.status === 'ended') return { text: t('status.settled'), cls: 'chip paused' };
  if (g.round.status === 'cancelled') return { text: t('status.cancelled'), cls: 'chip paused' };
  return { text: t('status.arming'), cls: 'chip' };
}

function renderGame() {
  const g = S.game;
  if (!g) return;
  const round = g.round;
  const cfg = g.config || {};
  const status = statusLabel(g);
  el.statusChip.className = status.cls;
  el.statusText.textContent = status.text;

  el.playersChip.textContent = round ? String(round.depositors || 0) : '0';
  el.roundChip.textContent = round ? `#${round.no}` : '#—';
  el.pot.textContent = fmt(round?.pot || 0);
  const fee = round?.entryFee || cfg.entryFee || 0;
  const resetSec = round?.resetSeconds ?? cfg.resetSeconds ?? 15;
  const winPct = 100 - (cfg.houseCut ?? 10);
  el.depMain.innerHTML = t('btn.push', { fee: fmt(fee) });
  el.depSub.textContent = t('btn.sub', { sec: resetSec, pct: winPct });

  if (round?.lastDepositor && round.status === 'live') {
    const prize = Math.floor((round.pot * winPct) / 100);
    el.lastLine.innerHTML = `<span>${t('last.lastIn')} <b>${escapeHtml(round.lastDepositor.username)}</b></span><span class="win">${t('last.wouldWin', { amount: fmt(prize) })}</span>`;
  } else if (round?.status === 'ended' && round.winnerName) {
    el.lastLine.innerHTML = `<span>💥 ${t('last.won', { name: `<b>${escapeHtml(round.winnerName)}</b>`, amount: fmt(round.payout) })}</span>`;
  } else if (round?.status === 'cancelled') {
    el.lastLine.textContent = t('last.cancelled');
  } else if (g.paused) {
    el.lastLine.textContent = t('last.paused');
  } else {
    el.lastLine.textContent = t('last.none');
  }

  renderFeed();
  renderDepositState();
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function feedItem(dep, fresh) {
  const li = document.createElement('li');
  if (fresh) li.className = 'fresh';
  li.innerHTML = `
    <span class="dot">💰</span>
    <span class="who">${escapeHtml(dep.username)}<small>${timeAgo(dep.at)}</small></span>
    <span class="amt">+${fmt(dep.amount)}</span>`;
  return li;
}

function timeAgo(at) {
  const diff = Math.max(0, Date.now() - new Date(at).getTime());
  if (diff < 5000) return t('time.justNow');
  if (diff < 60000) return t('time.secAgo', { n: Math.floor(diff / 1000) });
  if (diff < 3600000) return t('time.minAgo', { n: Math.floor(diff / 60000) });
  return t('time.hourAgo', { n: Math.floor(diff / 3600000) });
}

function renderFeed() {
  const round = S.game?.round;
  if (!round) {
    el.feed.innerHTML = `<li class="empty">${t('feed.waiting')}</li>`;
    el.feedCount.textContent = '—';
    return;
  }
  const deposits = round.deposits || [];
  const total = round.depositCount || deposits.length;
  el.feedCount.textContent = t(total === 1 ? 'feed.countOne' : 'feed.countMany', { n: total });
  if (!deposits.length) {
    el.feed.innerHTML = `<li class="empty">${t('feed.empty')}</li>`;
    return;
  }
  el.feed.innerHTML = '';
  deposits.forEach((d) => el.feed.appendChild(feedItem(d, false)));
}

function renderDepositState() {
  const g = S.game;
  const round = g && g.round ? g.round : null;
  const fee = round ? round.entryFee : (g && g.config ? g.config.entryFee : 0);
  if (!S.me) {
    el.depositBtn.disabled = true;
    el.depositBtn.classList.remove('armed');
    el.depMain.textContent = t('btn.openTelegram');
    el.hint.textContent = t('hint.telegramOnly');
    return;
  }
  if (!round) {
    el.depMain.innerHTML = t('btn.push', { fee: fmt(fee) });
    el.depositBtn.disabled = true;
    el.depositBtn.classList.remove('armed');
    el.hint.textContent = t('hint.waiting');
    return;
  }
  el.depMain.innerHTML = t('btn.push', { fee: fmt(fee) });
  const paused = !!(g && g.paused);
  const live = round.status === 'live' && !paused;
  const canAfford = (S.me.balance || 0) >= fee;
  el.depositBtn.disabled = !live || !canAfford;
  el.depositBtn.classList.toggle('armed', !!live && canAfford);
  if (!live) el.hint.textContent = paused ? t('hint.paused') : t('hint.waiting');
  else if (!canAfford) el.hint.textContent = t('hint.needFunds', { fee: fmt(fee) });
  else el.hint.textContent = t('hint.default');
}

function renderAvatar(me) {
  // Telegram profile picture when it is available, initials otherwise.
  const initial = me ? (me.username || '?').trim().slice(0, 1).toUpperCase() : '?';
  const photo = String((me && me.photoUrl) || '').trim();
  el.avatar.textContent = initial;
  if (!me || !/^https:\/\//i.test(photo)) return;
  const img = new Image();
  img.alt = '';
  img.referrerPolicy = 'no-referrer';
  img.onload = () => {
    el.avatar.textContent = '';
    el.avatar.appendChild(img);
  };
  img.src = photo;
}

function renderAccount() {
  const me = S.me;
  el.balance.textContent = fmt(me?.balance || 0);
  renderAvatar(me);
  el.meName.textContent = me ? me.username : t('me.guest');
  el.meSub.textContent = me ? t('me.telegramId', { id: me.telegramId || '—' }) : t('me.notInTelegram');
  el.meBalance.textContent = fmt(me?.balance || 0);
  el.meWins.textContent = fmt(me?.wins || 0);
  el.meWinnings.textContent = fmt(me?.winnings || 0);
  el.mePushes.textContent = fmt(me?.depositCount || 0);
  renderDepositState();
}

/* ------------------------------------------------------------------ */
/* Deposit                                                             */
/* ------------------------------------------------------------------ */
el.depositBtn.addEventListener('click', async () => {
  if (!S.me) {
    toast(t('hint.telegramOnly'), 'bad');
    return;
  }
  if (el.depositBtn.disabled) {
    const fee = S.game?.round?.entryFee || 0;
    if ((S.me.balance || 0) < fee) toast(t('toast.noFunds'), 'bad');
    return;
  }
  el.depositBtn.disabled = true;
  unlockAudio();
  if (navigator.vibrate) navigator.vibrate(18);
  try {
    const data = await api('/api/deposit', { method: 'POST' });
    S.me.balance = data.balance;
    el.balance.textContent = fmt(data.balance);
    el.pot.textContent = fmt(data.pot);
    toast(t('toast.push', { sec: data.msLeft ? Math.ceil(data.msLeft / 1000) : 0 }), 'ok');
    if (navigator.vibrate) navigator.vibrate([12, 40, 12]);
  } catch (err) {
    if (err.status === 401) {
      toast(t('hint.telegramOnly'), 'bad');
    } else {
      toast(err.message, 'bad');
    }
  } finally {
    renderDepositState();
  }
});

/* ------------------------------------------------------------------ */
/* Board                                                               */
/* ------------------------------------------------------------------ */
let boardLoadedAt = 0;
async function loadBoard() {
  try {
    const [history, leaders] = await Promise.all([api('/api/history'), api('/api/leaderboard')]);
    boardLoadedAt = Date.now();

    const stats = leaders.stats || {};
    $('statPaid').textContent = fmt(stats.paidOut);
    $('statRounds').textContent = fmt(stats.rounds);
    $('statMax').textContent = fmt(stats.maxPot);

    const players = leaders.players || [];
    $('leaders').innerHTML = players.length
      ? players
          .map(
            (p, i) => `<div class="row ${i === 0 ? 'hero-row' : ''}">
              <span class="rank">${i === 0 ? '🏆' : String(i + 1).padStart(2, '0')}</span>
              <span class="name">${escapeHtml(p.username)}<br><span class="muted">${t(p.wins === 1 ? 'board.winOne' : 'board.winMany', { n: fmt(p.wins) })}</span></span>
              <span class="val">${fmt(p.winnings)} ${t('common.etb')}</span>
            </div>`
          )
          .join('')
      : `<p class="empty-note">${t('board.noWinners')}</p>`;

    // The board only lists bombs from the last 10 minutes.
    const cutoff = Date.now() - 10 * 60 * 1000;
    const rounds = (history.rounds || []).filter((r) => {
      const at = new Date(r.endedAt || r.startedAt || 0).getTime();
      return Number.isFinite(at) && at >= cutoff;
    });
    $('history').innerHTML = rounds.length
      ? rounds
          .map((r) => {
            const won = r.status === 'ended' && r.winnerName;
            const label = won ? escapeHtml(r.winnerName) : r.status === 'cancelled' ? t('board.cancelled') : t('board.noWinner');
            return `<div class="row">
              <span class="rank">#${r.no}</span>
              <span class="name">${label}<br>
                <span class="muted">${t('rounds.pot')} ${fmt(r.pot)} · ${t('rounds.house')} ${fmt(r.houseCut)}</span></span>
              <span class="val">${won ? `+${fmt(r.payout)}` : '—'}</span>
            </div>`;
          })
          .join('')
      : `<p class="empty-note">${t('board.noRounds')}</p>`;
  } catch {
    /* offline / server restarting — ignore */
  }
}

/* ------------------------------------------------------------------ */
/* Winner overlay                                                      */
/* ------------------------------------------------------------------ */
function showWinner(info) {
  el.winName.textContent = info.winnerName;
  el.winAmount.textContent = `${fmt(info.payout)} ${t('common.etb')}`;
  el.winCut.textContent = t('winner.cut', { pot: fmt(info.pot), cut: fmt(info.houseCut) });
  el.winner.classList.add('show');

  let left = 7;
  const paint = () => {
    el.winNext.innerHTML = left > 0 ? t('winner.next', { n: left }) : t('winner.arming');
  };
  paint();
  clearInterval(S.winnerTimer);
  S.winnerTimer = setInterval(() => {
    left -= 1;
    paint();
    if (left < 0) {
      clearInterval(S.winnerTimer);
      el.winner.classList.remove('show');
    }
  }, 1000);

  if (navigator.vibrate) navigator.vibrate([20, 60, 20, 60, 40]);
}
el.winner.addEventListener('click', () => {
  clearInterval(S.winnerTimer);
  el.winner.classList.remove('show');
});

/* ------------------------------------------------------------------ */
/* Realtime                                                            */
/* ------------------------------------------------------------------ */
const socket = io({ transports: ['websocket', 'polling'] });

function applyState(game) {
  S.game = game;
  S.sync = { msLeft: game.msLeft, at: performance.now(), paused: game.paused };
  renderGame();
  renderClock();
  if (S.me) renderDepositState();
}

socket.on('connect', () => {
  if (S.view === 'board') loadBoard();
  renderGame();
});

socket.on('state', (game) => applyState(game));

socket.on('tick', (tick) => {
  if (!S.game) return;
  S.sync = { msLeft: tick.msLeft, at: performance.now(), paused: tick.paused };
  S.game.paused = tick.paused;
  S.game.msLeft = tick.msLeft;
});

socket.on('round:deposit', (info) => {
  if (S.game?.round) {
    S.game.round.pot = info.pot;
    el.pot.textContent = fmt(info.pot);
  }
  const first = el.feed.querySelector('li.empty');
  if (first) first.remove();
  if (info.username) el.feed.prepend(feedItem({ username: info.username, amount: info.amount, at: new Date().toISOString() }, true));
  while (el.feed.children.length > 25) el.feed.lastElementChild.remove();
  const count = Number((el.feedCount.textContent.match(/\d+/) || [0])[0]) + 1;
  el.feedCount.textContent = t(count === 1 ? 'feed.countOne' : 'feed.countMany', { n: count });
});

socket.on('round:ended', (info) => {
  if (info.reason === 'cancelled') {
    toast(t('toast.cancelled'), 'ok');
  } else {
    explode();
    if (info.payout > 0) showWinner(info);
  }
  refreshMe();
  if (S.view === 'board') loadBoard();
});

socket.on('disconnect', () => {
  el.statusText.textContent = t('status.reconnecting');
  el.statusChip.className = 'chip paused';
});

/* ------------------------------------------------------------------ */
/* Language                                                            */
/* ------------------------------------------------------------------ */
window.I18n.onChange(() => {
  renderGame();
  renderAccount();
  if (S.view === 'board') loadBoard();
});

/* ------------------------------------------------------------------ */
/* Countdown audio: one tick per second from 10 → 0                     */
/* ------------------------------------------------------------------ */

// One AudioContext for the whole page. Building a new one for every mute toggle
// or tab switch leaks contexts (iOS silences audio after a handful), so all
// sound shares this instance.
let AC = null;
function audioContext() {
  if (AC) return AC;
  try {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    AC = new Ctor();
  } catch {
    AC = null;
  }
  return AC;
}

// Flat white noise, used by the detonation.
let BOOM_NOISE = null;
function boomNoiseBuffer(ac) {
  if (BOOM_NOISE) return BOOM_NOISE;
  const len = Math.max(1, Math.floor(ac.sampleRate * 0.8));
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < len; i += 1) ch[i] = Math.random() * 2 - 1;
  BOOM_NOISE = buf;
  return BOOM_NOISE;
}

// One short decaying noise buffer, reused by every tick.
let NOISE = null;
function noiseBuffer(ac) {
  if (NOISE) return NOISE;
  const len = Math.max(1, Math.floor(ac.sampleRate * 0.05));
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < len; i += 1) ch[i] = (Math.random() * 2 - 1) * (1 - i / len);
  NOISE = buf;
  return NOISE;
}

// Browsers only start audio after a real user gesture, so the first tap unlocks
// the context. Called from the mute button and the push button too.
let audioUnlocked = false;
function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  const ac = audioContext();
  if (ac && ac.state === 'suspended') ac.resume().catch(() => {});
}
['pointerdown', 'touchstart', 'keydown'].forEach((evt) =>
  window.addEventListener(evt, unlockAudio, { passive: true })
);

/** The detonation sound: a sub-bass thump under a noise burst sweeping down. */
function playBoom() {
  const ac = audioContext();
  if (!ac || ac.state !== 'running') return;
  try {
    const now = ac.currentTime;

    const out = ac.createGain();
    out.gain.setValueAtTime(0.85, now);
    out.gain.exponentialRampToValueAtTime(0.0001, now + 1.1);
    out.connect(ac.destination);

    // Crack + rumble: broadband noise closing down into a low roar.
    const noise = ac.createBufferSource();
    noise.buffer = boomNoiseBuffer(ac);
    const lowpass = ac.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.setValueAtTime(2600, now);
    lowpass.frequency.exponentialRampToValueAtTime(130, now + 0.85);
    const noiseGain = ac.createGain();
    noiseGain.gain.setValueAtTime(0.75, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);
    noise.connect(lowpass);
    lowpass.connect(noiseGain);
    noiseGain.connect(out);
    noise.start(now);
    noise.stop(now + 0.95);

    // The thump you feel.
    const sub = ac.createOscillator();
    const subGain = ac.createGain();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(98, now);
    sub.frequency.exponentialRampToValueAtTime(26, now + 0.5);
    subGain.gain.setValueAtTime(0.9, now);
    subGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.8);
    sub.connect(subGain);
    subGain.connect(out);
    sub.start(now);
    sub.stop(now + 0.85);

    setTimeout(() => {
      try {
        out.disconnect();
        lowpass.disconnect();
        noiseGain.disconnect();
        subGain.disconnect();
      } catch {}
    }, 1500);
  } catch {
    /* stay silent */
  }
}

/* ------------------------------------------------------------------ */
/* Detonation effect (the fuse hit zero)                               */
/* ------------------------------------------------------------------ */

const reduceMotion =
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let explosionTimer = null;

/** Builds the flash, shockwave rings and ember particles once, then reuses them. */
function buildExplosion() {
  const box = el.explosion;
  if (!box || box.childElementCount) return box;
  box.innerHTML = '<span class="flash"></span><span class="shock"></span><span class="shock s2"></span>';
  for (let i = 0; i < 18; i += 1) {
    const ember = document.createElement('span');
    ember.className = 'ember';
    const angle = (Math.PI * 2 * i) / 18 + Math.random() * 0.5;
    const distance = 90 + Math.random() * 160;
    ember.style.setProperty('--dx', `${Math.round(Math.cos(angle) * distance)}px`);
    ember.style.setProperty('--dy', `${Math.round(Math.sin(angle) * distance)}px`);
    const size = 4 + Math.random() * 5;
    ember.style.width = `${size}px`;
    ember.style.height = `${size}px`;
    ember.style.animationDelay = `${Math.round(Math.random() * 70)}ms`;
    box.appendChild(ember);
  }
  return box;
}

/** Flash + shockwave + embers + shake + boom. Fired when the fuse dies. */
function explode() {
  const box = buildExplosion();
  if (!box) return;

  // Restart every animation from the beginning on each detonation.
  box.classList.remove('play');
  void box.offsetWidth;
  box.classList.add('play');

  const app = document.querySelector('.app');
  if (app && !reduceMotion) {
    app.classList.remove('shake');
    void app.offsetWidth;
    app.classList.add('shake');
  }

  clearTimeout(explosionTimer);
  explosionTimer = setTimeout(() => {
    box.classList.remove('play');
    if (app) app.classList.remove('shake');
  }, 1500);

  if (S.muted !== true) playBoom();
  if (navigator.vibrate) navigator.vibrate([45, 60, 130]);
}

function makeAudio() {
  const ac = audioContext();
  if (!ac) return null;
  ac.resume().catch(() => {});

  const master = ac.createGain();
  master.gain.value = 0;
  master.connect(ac.destination);

  /** A crisp clock tick: filtered noise transient plus a short high ping. */
  function playTick(vol) {
    if (ac.state !== 'running') return;
    try {
      const now = ac.currentTime;
      const level = Math.min(1, Math.max(0.01, vol));

      const gate = ac.createGain();
      gate.gain.setValueAtTime(0, now);
      gate.gain.linearRampToValueAtTime(level, now + 0.002);
      gate.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);
      gate.connect(master);

      const noise = ac.createBufferSource();
      noise.buffer = noiseBuffer(ac);
      const highpass = ac.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = 1400;
      noise.connect(highpass);
      highpass.connect(gate);
      noise.start(now);
      noise.stop(now + 0.08);

      const ping = ac.createOscillator();
      const pingGain = ac.createGain();
      ping.type = 'triangle';
      ping.frequency.value = 2200;
      pingGain.gain.setValueAtTime(level * 0.45, now);
      pingGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
      ping.connect(pingGain);
      pingGain.connect(master);
      ping.start(now);
      ping.stop(now + 0.06);

      setTimeout(() => {
        try {
          gate.disconnect();
          highpass.disconnect();
          pingGain.disconnect();
        } catch {}
      }, 400);
    } catch {
      /* audio node failure — stay silent */
    }
  }

  let raf = 0;
  let tickedSec = null; // last second that got a tick
  let lastResumeAt = 0;

  const loop = () => {
    const g = S.game;
    const live = !!(g && g.round && g.round.status === 'live' && !g.paused);

    if (!live) {
      master.gain.setTargetAtTime(0, ac.currentTime, 0.05);
      tickedSec = null;
      raf = requestAnimationFrame(loop);
      return;
    }

    // Keep the context alive after the page was backgrounded.
    const nowMs = performance.now();
    if (ac.state !== 'running' && nowMs - lastResumeAt > 500) {
      lastResumeAt = nowMs;
      ac.resume().catch(() => {});
    }

    const left = getMsLeft();
    // Matches the clock: it reads 10 the moment there are 10 seconds left.
    const sec = Math.max(0, Math.ceil(left / 1000));

    // A push extended the fuse — re-arm so the countdown can tick again.
    if (sec > 10) tickedSec = null;

    // Quiet swell that grows as the fuse burns down.
    const resetMs = Math.max((g.round?.resetSeconds || 15) * 1000, left || 0);
    const danger = 1 - Math.max(0, Math.min(1, (left || 0) / resetMs));
    master.gain.setTargetAtTime(Math.min(0.5, 0.22 + danger * 0.28), ac.currentTime, 0.05);

    // From 10 down to 0: exactly one tick per second.
    if (ac.state === 'running' && sec <= 10 && sec !== tickedSec) {
      tickedSec = sec;
      playTick(sec === 10 ? 0.9 : sec <= 3 ? 0.85 : 0.6);
    }

    raf = requestAnimationFrame(loop);
  };

  raf = requestAnimationFrame(loop);

  return {
    _ac: ac,
    stop() {
      cancelAnimationFrame(raf);
      try {
        master.gain.setTargetAtTime(0, ac.currentTime, 0.02);
      } catch {}
      setTimeout(() => {
        try {
          master.disconnect();
        } catch {}
      }, 250);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */
(async function boot() {
  renderClock();
  setInterval(() => requestAnimationFrame(renderClock), 100);
  await signIn();
  try {
    const state = await api('/api/state');
    applyState(state);
  } catch {
    /* socket will deliver state */
  }
  // Start the countdown audio. It stays silent until the fuse reaches 10s, and
  // the first tap anywhere on the page unlocks it on mobile.
  if (S.muted !== true) {
    try {
      S.audio = makeAudio();
    } catch {
      /* audio unsupported */
    }
  }
  // Silence the countdown while the app is in the background and restart it on
  // return — browsers suspend audio for hidden pages.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (S.audio) {
        try { S.audio.stop(); } catch {}
        S.audio = null;
      }
      return;
    }
    if (S.view === 'play' && S.muted !== true && !S.audio) {
      try { S.audio = makeAudio(); } catch {}
    }
  });
  setInterval(() => {
    if (S.view === 'board' && Date.now() - boardLoadedAt > 20000) loadBoard();
  }, 15000);
})();
