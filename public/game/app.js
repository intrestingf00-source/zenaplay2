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
    const name = new URLSearchParams(location.search).get('name') || '';
    return { devId: id, devName: name };
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
  if (!S.audio) return;
  try {
    S.audio.stop();
  } catch {}
  S.audio = null;
  el.muteIcon.textContent = muted ? '🔇' : '🔊';
  el.muteIcon.classList.toggle('mute-on', !muted);
  el.muteIcon.classList.toggle('mute-off', muted);
  S.muted = muted;
  if (!muted) {
    try {
      S.audio = makeAudio();
    } catch {}
  }
}
el.muteBtn.addEventListener('click', () => {
  const next = S.muted !== false;
  setMuted(next);
  toast(next ? t('toast.muted') : t('toast.unmuted'), 'ok');
});
if (S.muted === undefined) {
  try {
    S.muted = localStorage.getItem('tb_mute') === '1';
    if (S.muted) el.muteIcon.textContent = '🔇';
  } catch {
    S.muted = false;
  }
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
  // Mute audio on the board tab (only the play view has the fuse sound).
  if (view !== 'play' && S.audio) {
    try { S.audio.stop(); } catch {}
    S.audio = null;
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

function renderAccount() {
  const me = S.me;
  el.balance.textContent = fmt(me?.balance || 0);
  el.avatar.textContent = me ? (me.username || '?').trim().slice(0, 1).toUpperCase() : '?';
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
    $('statHouse').textContent = fmt(stats.houseEarned);
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

    const rounds = history.rounds || [];
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
  } else if (info.payout > 0) {
    showWinner(info);
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
/* Suspense audio (fuse tension)                                       */
/* ------------------------------------------------------------------ */
// Countdown fuse sound: a tick sound at 10s and once per second down to 0,
// plus a synthesized "robot voice" counting 10, 9, 8 ... 0 in English.
// Both are generated in-browser with the Web Audio API (no external files).
function makeAudio() {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    ac.resume().catch(() => {});
    const master = ac.createGain();
    master.gain.value = 0;
    master.connect(ac.destination);

    // ---- Tick (a short, crisp click transient) ----
    const tickOsc = ac.createOscillator();
    const tickEnv = ac.createGain();
    tickOsc.type = 'sine';
    tickOsc.frequency.value = 1800;
    tickOsc.connect(tickEnv);
    tickEnv.connect(master);
    tickOsc.start();
    tickEnv.gain.value = 0;

    function playTick(vol) {
      try {
        const t = ac.currentTime;
        tickEnv.gain.setTargetAtTime(Math.min(1, Math.max(0, vol || 0.5)), t, 0.001);
        tickOsc.frequency.setTargetAtTime(1800, t, 0.001);
        tickEnv.gain.setTargetAtTime(0, t + 0.035, 0.010);
      } catch {}
    }

    // ---- Robot countdown voice (synthesized speech for each digit 10..0) ----
    // Two oscillators + formant filtering approximate a spoken number.
    let voiceBusyUntil = 0;

    function playNumber(num, at, vol) {
      // num: 10..0 ; at: ac.currentTime ; vol: 0..1
      const t = at;
      const v = Math.min(1, Math.max(0.02, vol || 0.5));
      // integer 0-9 -> a short two-formant "digit" voice (different for 0 vs 1-9)
      const digit = num <= 9 ? num : 10; // 10 is special (two syllables: "ten")
      const syllables = num === 10 ? 2 : 1;
      const dur = 0.16 * syllables + 0.06; // ~0.22s for "ten", ~0.22s for a digit
      const basePitch = num === 10 ? 210 : (num === 0 ? 150 : 180 + (9 - num) * 12);
      const formant1 = num === 10 ? 500 : (num === 0 ? 520 : 560);
      const formant2 = num === 10 ? 1500 : (num === 0 ? 1200 : 1600);

      // Carrier (voiced pitch)
      const carrier = ac.createOscillator();
      const carrierG = ac.createGain();
      carrier.type = 'sawtooth';
      carrier.frequency.value = basePitch;
      carrier.connect(carrierG);

      // Formant filter (two bandpass formants)
      const f1 = ac.createBiquadFilter();
      f1.type = 'bandpass';
      f1.frequency.value = formant1;
      f1.Q.value = 8;
      const f2 = ac.createBiquadFilter();
      f2.type = 'bandpass';
      f2.frequency.value = formant2;
      f2.Q.value = 10;

      carrierG.connect(f1);
      carrierG.connect(f2);
      const fg = ac.createGain();
      f1.connect(fg);
      f2.connect(fg);
      fg.connect(master);

      // Envelope: quick attack, body, quick release
      fg.gain.setValueAtTime(0, t);
      fg.gain.linearRampToValueAtTime(v * 0.28, t + 0.012);
      fg.gain.setValueAtTime(v * 0.28, t + dur * 0.6);
      fg.gain.linearRampToValueAtTime(0, t + dur);

      carrier.start(t);
      carrier.stop(t + dur + 0.02);
      // Schedule cleanup so nodes don't pile up.
      setTimeout(() => {
        try { carrier.disconnect(); carrierG.disconnect(); f1.disconnect(); f2.disconnect(); fg.disconnect(); } catch {}
      }, (dur + 0.1) * 1000);
    }

    // ---- Main loop: tick + voice cued by the fuse ----
    let raf = 0;
    let lastSpokenAt = -1;     // seconds already spoken
    let tickAt = -1;          // last tick second

    const seg = () => {
      const g = S.game;
      if (!g || !g.round || g.round.status !== 'live') {
        master.gain.setTargetAtTime(0, ac.currentTime, 0.05);
        tickEnv.gain.setTargetAtTime(0, ac.currentTime, 0.01);
        raf = requestAnimationFrame(seg);
        return;
      }
      if (g.paused) {
        master.gain.setTargetAtTime(0, ac.currentTime, 0.05);
        tickEnv.gain.setTargetAtTime(0, ac.currentTime, 0.01);
        raf = requestAnimationFrame(seg);
        return;
      }

      const left = getMsLeft();
      const resetMs = Math.max((g.round?.resetSeconds || 15) * 1000, left);
      const frac = Math.max(0, Math.min(1, left / resetMs));
      const danger = 1 - frac;

      // Master gain: subtle swell as the fuse shortens.
      const now = ac.currentTime;
      const mg = Math.min(0.55, 0.10 + danger * 0.45);
      master.gain.setTargetAtTime(mg, now, 0.05);

      // Whole seconds left (clamped to the reset window).
      const leftSec = Math.max(0, Math.min(30, Math.floor(left / 1000)));

      // Tick: once per second. Explode the first tick exactly at 10 (the moment
      // the countdown voice begins) and then one tick on each second down to 0.
      if (leftSec !== tickAt) {
        tickAt = leftSec;
        if (leftSec <= 10) {
          const vol = leftSec === 10 ? 0.9 : (leftSec <= 3 ? 0.8 : 0.55);
          playTick(vol);
        }
      }

      // Voice: start speaking when the fuse hits 10 and speak each number at its
      // second boundary, 10 -> 0. Only speak a number once.
      if (leftSec <= 10 && leftSec !== lastSpokenAt && ac.state !== 'suspended') {
        lastSpokenAt = leftSec;
        const vol = leftSec <= 3 ? 0.85 : (leftSec === 10 ? 0.6 : 0.5);
        try { ac.resume().catch(() => {}); } catch {}
        playNumber(leftSec, ac.currentTime + 0.02, vol);
      }

      raf = requestAnimationFrame(seg);
    };

    raf = requestAnimationFrame(seg);
    return {
      _ac: ac,
      stop: () => {
        cancelAnimationFrame(raf);
        master.gain.setTargetAtTime(0, ac.currentTime, 0.02);
        tickEnv.gain.setTargetAtTime(0, ac.currentTime, 0.01);
        try { tickOsc.stop(ac.currentTime + 0.05); } catch {}
      },
    };
  } catch {
    return null;
  }
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
  // Start the suspense audio when a live round is active.
  if (S.muted !== true) {
    try {
      S.audio = makeAudio();
    } catch {
      /* audio unsupported */
    }
  }
  // Resume audio each time the player returns to the play tab after being hidden.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S.view === 'play' && S.audio && S.muted !== true) {
      try {
        const ac = S.audio._ac || (S.audio._ac = (window.AudioContext || window.webkitAudioContext)());
        if (ac.state === 'suspended') ac.resume().catch(() => {});
        S.audio = makeAudio();
      } catch {}
    }
  });
  setInterval(() => {
    if (S.view === 'board' && Date.now() - boardLoadedAt > 20000) loadBoard();
  }, 15000);
})();
