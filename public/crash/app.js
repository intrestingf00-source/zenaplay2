'use strict';

const t = (key, vars) => window.I18n.t(key, vars);
const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.max(0, Math.round(Number(n) || 0)).toLocaleString('en-US');
const mult2 = (n) => (Math.max(1, Number(n) || 1)).toFixed(2);
const esc = (str) =>
  String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const el = {
  mult: $('mult'),
  stage: $('stage'),
  stageStatus: $('stageStatus'),
  history: $('history'),
  seedInfo: $('seedInfo'),
  copySeed: $('copySeed'),
  balance: $('balance'),
  amount: $('amount'),
  quick: $('quick'),
  autoOn: $('autoOn'),
  autoAt: $('autoAt'),
  action: $('actionBtn'),
  hint: $('betHint'),
  betList: $('betList'),
  playerCount: $('playerCount'),
  toast: $('toast'),
  crashFlash: $('crashFlash'),
  muteBtn: $('muteBtn'),
  muteIcon: $('muteIcon'),
};

const S = {
  token: '',
  me: null,
  socket: null,
  phase: 'betting',
  paused: false,
  roundNo: 0,
  seedHash: '',
  seed: '',
  crashAt: null,
  startedAt: 0,
  localStart: 0,
  growth: 0.09,
  maxMultiplier: 300,
  config: { minBet: 10, maxBet: 500, betSeconds: 7 },
  bets: [],
  history: [],
  betEndLocal: 0,
  busy: false,
  muted: false,
  shownCrash: 0,
  crashElapsed: 0,
  lastMultText: '',
  lastStatus: '',
  explodedRound: 0,
  drone: null,
};

/* ------------------------------------------------------------------ */
/* Session                                                             */
/* ------------------------------------------------------------------ */

async function api(path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (S.token) headers.Authorization = `Bearer ${S.token}`;
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    let message = data.error || `Request failed (${res.status})`;
    if (data.code) {
      const translated = t(`err.${data.code}`);
      if (translated && translated !== `err.${data.code}`) message = translated;
    }
    const err = new Error(message);
    err.status = res.status;
    err.code = data.code;
    throw err;
  }
  return data;
}

const telegram = () => (window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null);

function devIdentity() {
  try {
    let id = localStorage.getItem('tb_dev_id');
    if (!id) {
      id = Math.random().toString(36).slice(2, 10);
      localStorage.setItem('tb_dev_id', id);
    }
    return { devId: id, devName: '' };
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
      if (tg.disableVerticalSwipes) tg.disableVerticalSwipes();
    } catch {
      /* older Telegram clients */
    }
  }

  const bypass = new URLSearchParams(location.search).get('dev') === '1';
  const payload = { initData: (tg && tg.initData) || '', ...devIdentity() };
  if (bypass) payload.devBypass = true;

  try {
    const data = await api('/api/auth/telegram', payload);
    S.token = data.token;
    S.me = data.user;
  } catch {
    S.token = '';
    S.me = null;
  }
  paintBalance();
}

function paintBalance() {
  el.balance.textContent = fmt(S.me ? S.me.balance : 0);
}

async function refreshMe() {
  if (!S.token) return;
  try {
    const data = await api('/api/me');
    S.me = data.user;
    paintBalance();
    renderAction();
  } catch {
    /* keep the last known balance */
  }
}

/* ------------------------------------------------------------------ */
/* Round state                                                         */
/* ------------------------------------------------------------------ */

function applyState(state) {
  const prevPhase = S.phase;

  S.phase = state.phase || 'betting';
  S.paused = !!state.paused;
  S.roundNo = state.roundNo || 0;
  S.seedHash = state.seedHash || '';
  S.seed = state.seed || '';
  S.crashAt = state.crashAt || null;
  S.growth = (state.config && state.config.growth) || S.growth;
  S.maxMultiplier = (state.config && state.config.maxMultiplier) || S.maxMultiplier;
  S.config = state.config || S.config;
  S.bets = Array.isArray(state.bets) ? state.bets : [];
  S.history = Array.isArray(state.history) ? state.history : [];

  const startedAt = Number(state.startedAt) || 0;
  if (startedAt) {
    S.startedAt = startedAt;
    S.localStart = startedAt - ((Number(state.serverTime) || Date.now()) - Date.now());
  } else {
    S.startedAt = 0;
    S.localStart = 0;
  }

  if (S.phase === 'betting') {
    S.betEndLocal = Date.now() + (Number(state.msLeft) || 0);
    if (prevPhase !== 'betting') {
      S.explodedRound = 0;
      exhaust.length = 0;
      sparks.length = 0;
    }
  }
  if (S.phase === 'crashed' && state.crashAt) S.crashElapsed = Math.log(state.crashAt) / S.growth;

  if (S.phase === 'running' && prevPhase !== 'running') startDrone();
  if (S.phase !== 'running' && prevPhase === 'running') stopDrone();

  renderHistory();
  renderBetList();
  renderFairness();
  renderAction();
  renderAmounts();
  // Keep the readout right even when the browser pauses animation frames
  // (background tab, phone locked).
  paintStatus();
  paintMultiplier();

  if (S.phase === 'crashed' && state.crashAt && S.shownCrash !== S.roundNo) {
    showCrash(state.crashAt, S.roundNo);
  }
}

function currentMultiplier() {
  if (S.phase === 'crashed') return S.crashAt || 1;
  if (S.phase !== 'running' || !S.localStart) return 1;
  const seconds = Math.max(0, (Date.now() - S.localStart) / 1000);
  return Math.exp(S.growth * seconds);
}

function myBet() {
  if (!S.me) return null;
  return S.bets.find((b) => String(b.userId) === String(S.me.id)) || null;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function renderHistory() {
  el.history.innerHTML = S.history
    .slice(0, 22)
    .map((h) => {
      const value = Number(h.crashAt) || 1;
      const kind = value < 1.5 ? 'low' : value < 3 ? 'mid' : 'high';
      return `<span class="h ${kind}">${value.toFixed(2)}x</span>`;
    })
    .join('');
}

function renderFairness() {
  if (S.phase === 'crashed' && S.seed) {
    el.seedInfo.textContent = `seed ${S.seed.slice(0, 20)}…`;
    el.copySeed.hidden = false;
  } else {
    el.seedInfo.textContent = S.seedHash ? `commit ${S.seedHash.slice(0, 20)}…` : '…';
    el.copySeed.hidden = true;
  }
}

function renderAmounts() {
  const min = S.config.minBet || 10;
  const max = S.config.maxBet || 500;
  el.amount.min = String(min);
  el.amount.max = String(max);
  Array.from(el.quick.children).forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.amount) === Number(el.amount.value));
  });
  if (el.hint.dataset.custom !== '1') {
    el.hint.textContent = t('crash.hintBet', { min: fmt(min), max: fmt(max) });
  }
}

function renderAction() {
  const bet = myBet();
  const btn = el.action;
  btn.disabled = false;
  btn.dataset.mode = '';
  btn.classList.remove('cashout');

  if (S.phase === 'betting') {
    if (bet) {
      btn.textContent = t('crash.cancelBet');
      btn.dataset.mode = 'cancel';
    } else {
      btn.textContent = t('crash.placeBet', { amount: fmt(el.amount.value) });
      btn.dataset.mode = 'bet';
      const stake = Math.round(Number(el.amount.value) || 0);
      if (S.me && stake > (S.me.balance || 0)) {
        el.hint.dataset.custom = '1';
        el.hint.textContent = t('crash.noFunds');
      } else if (el.hint.dataset.custom === '1') {
        el.hint.dataset.custom = '0';
        renderAmounts();
      }
    }
    return;
  }

  if (S.phase === 'running') {
    if (bet && !bet.cashedAt) {
      btn.textContent = t('crash.cashOut', { mult: mult2(currentMultiplier()) });
      btn.dataset.mode = 'cashout';
      btn.classList.add('cashout');
    } else if (bet && bet.cashedAt) {
      btn.textContent = t('crash.cashedAt', { mult: mult2(bet.cashedAt) });
      btn.disabled = true;
    } else {
      btn.textContent = t('crash.waiting');
      btn.disabled = true;
    }
    return;
  }

  if (S.phase === 'crashed') {
    btn.textContent = t('crash.nextRound');
    btn.disabled = true;
    return;
  }

  btn.textContent = S.paused || S.phase === 'idle' ? t('crash.paused') : t('crash.nextRound');
  btn.disabled = true;
}

function renderBetList() {
  el.playerCount.textContent = String(S.bets.length);
  if (!S.bets.length) {
    el.betList.innerHTML = `<li class="empty">${t('crash.noPlayers')}</li>`;
    return;
  }
  const rows = S.bets
    .slice()
    .sort((a, b) => (b.cashedAt ? 1 : 0) - (a.cashedAt ? 1 : 0) || b.amount - a.amount)
    .slice(0, 40)
    .map((b) => {
      const mine = S.me && String(b.userId) === String(S.me.id);
      const name = esc(b.username || 'player');
      const initial = name.trim().slice(0, 1).toUpperCase() || '?';
      let result = `<span class="result pending">—</span>`;
      if (b.cashedAt) {
        result = `<span class="result win">${Number(b.cashedAt).toFixed(2)}x</span>`;
      } else if (S.phase === 'crashed') {
        result = `<span class="result lost">${t('crash.lost')}</span>`;
      }
      return `<li class="row ${mine ? 'mine' : ''}">
        <span class="avatar">${initial}</span>
        <span class="name">${name}<small>${fmt(b.amount)} ETB${b.autoCashout ? ` · auto ${Number(b.autoCashout).toFixed(2)}x` : ''}</small></span>
        ${result}
      </li>`;
    })
    .join('');
  el.betList.innerHTML = rows;
}

function paintStatus() {
  let text = '';
  if (S.phase === 'betting') {
    const left = Math.max(0, (S.betEndLocal - Date.now()) / 1000);
    text = t('crash.betting') + ' · ' + left.toFixed(1) + 's';
  } else if (S.phase === 'running') {
    text = t('crash.inTheAir');
  } else if (S.phase === 'crashed') {
    text = t('crash.crashedAt', { mult: mult2(S.crashAt) });
  } else if (S.paused) {
    text = t('crash.paused');
  } else {
    text = t('crash.nextRound');
  }
  el.stage.dataset.paused = S.paused ? '1' : '0';
  if (text !== S.lastStatus) {
    el.stageStatus.textContent = text;
    el.stage.dataset.phase = S.phase;
    S.lastStatus = text;
  }
}

function paintMultiplier() {
  const value = S.phase === 'running' ? currentMultiplier() : S.phase === 'crashed' ? S.crashAt || 1 : 1;
  const text = mult2(value);
  if (text === S.lastMultText) return;
  el.mult.innerHTML = `${text}<span>x</span>`;
  S.lastMultText = text;

  if (S.phase === 'running') {
    const bet = myBet();
    if (bet && !bet.cashedAt && el.action.dataset.mode === 'cashout') {
      el.action.textContent = t('crash.cashOut', { mult: text });
    }
    updateDrone(value);
  }
}

/* ------------------------------------------------------------------ */
/* Chart                                                               */
/* ------------------------------------------------------------------ */

const canvas = $('chart');
const ctx = canvas.getContext('2d');
let boxW = 320;
let boxH = 236;

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  boxW = rect.width;
  boxH = rect.height;
  canvas.width = Math.round(boxW * dpr);
  canvas.height = Math.round(boxH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

const GRID_MULTS = [2, 5, 10, 25, 50, 100, 250];

/* ------------------------------------------------------------------ */
/* Flight: jet, exhaust, explosion                                     */
/* ------------------------------------------------------------------ */

const TAU = Math.PI * 2;
const exhaust = [];
const sparks = [];
const STARFIELD = Array.from({ length: 30 }, () => ({
  x: Math.random(),
  y: Math.random(),
  r: 0.5 + Math.random() * 1.1,
  depth: 0.3 + Math.random() * 0.7,
  tw: Math.random() * 6,
}));

function planeSize() {
  return Math.max(1.12, Math.min(1.55, boxW / 250));
}

function emitExhaust(x, y, angle, count) {
  const tail = 11 * planeSize();
  const tx = x - Math.cos(angle) * tail;
  const ty = y - Math.sin(angle) * tail;
  for (let i = 0; i < count; i += 1) {
    const a = angle + Math.PI + (Math.random() - 0.5) * 0.55;
    const speed = 26 + Math.random() * 52;
    exhaust.push({
      x: tx + (Math.random() - 0.5) * 3,
      y: ty + (Math.random() - 0.5) * 3,
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed,
      life: 0,
      max: 0.42 + Math.random() * 0.35,
      r: 1 + Math.random() * 2.1,
      smoke: false,
    });
  }
  if (exhaust.length > 170) exhaust.splice(0, exhaust.length - 170);
}

function spawnExplosion(x, y) {
  for (let i = 0; i < 30; i += 1) {
    const a = Math.random() * TAU;
    const speed = 30 + Math.random() * 120;
    sparks.push({
      x,
      y,
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed,
      life: 0,
      max: 0.55 + Math.random() * 0.7,
      r: 1 + Math.random() * 2.3,
      warm: Math.random(),
      smoke: false,
    });
  }
  for (let i = 0; i < 7; i += 1) {
    const a = Math.random() * TAU;
    sparks.push({
      x,
      y,
      vx: Math.cos(a) * 16,
      vy: Math.sin(a) * 16 - 8,
      life: 0,
      max: 1.1 + Math.random() * 0.6,
      r: 4 + Math.random() * 6,
      smoke: true,
    });
  }
}

function stepFlight(dt) {
  const move = (list, drag, gravity) => {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const p = list[i];
      p.life += dt;
      if (p.life >= p.max) {
        list.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= drag;
      p.vy = p.vy * drag + gravity * dt;
    }
  };
  move(exhaust, 0.94, 0);
  move(sparks, 0.93, 24);
}

function drawStars(time) {
  ctx.save();
  for (const s of STARFIELD) {
    const y = ((s.y + time * 0.008 * s.depth) % 1) * boxH;
    const alpha = 0.05 + 0.1 * (0.5 + 0.5 * Math.sin(time * 0.6 + s.tw));
    ctx.fillStyle = `rgba(255, 236, 214, ${alpha.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(s.x * boxW, y, s.r, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

function drawFlightFx() {
  if (!exhaust.length && !sparks.length) return;
  ctx.save();
  for (const p of exhaust) {
    const t = p.life / p.max;
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = `rgba(255, ${Math.round(196 - t * 70)}, ${Math.round(110 - t * 80)}, ${((1 - t) * 0.5).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r * (1 + t * 1.4), 0, TAU);
    ctx.fill();
  }
  for (const p of sparks) {
    const t = p.life / p.max;
    if (p.smoke) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = `rgba(96, 86, 104, ${((1 - t) * 0.22).toFixed(3)})`;
    } else {
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle =
        p.warm > 0.5
          ? `rgba(255, ${Math.round(210 - t * 120)}, 90, ${((1 - t) * 0.9).toFixed(3)})`
          : `rgba(255, ${Math.round(120 - t * 60)}, ${Math.round(60 - t * 40)}, ${((1 - t) * 0.9).toFixed(3)})`;
    }
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r * (1 + t * 0.6), 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

function drawPlane(x, y, angle, scale, time) {
  const bob = Math.sin(time * 2.3) * 1.3;
  const bank = Math.sin(time * 1.6) * 0.03;
  ctx.save();
  ctx.translate(x, y + bob);
  ctx.rotate(angle + bank);
  ctx.scale(scale, scale);

  /* engine plume */
  const flick = 0.72 + Math.sin(time * 24) * 0.16 + Math.sin(time * 9.3) * 0.12;
  const plume = 15 * flick;
  const flame = ctx.createLinearGradient(-11, 0, -11 - plume, 0);
  flame.addColorStop(0, 'rgba(255, 252, 230, 0.95)');
  flame.addColorStop(0.4, 'rgba(255, 196, 84, 0.8)');
  flame.addColorStop(1, 'rgba(255, 92, 40, 0)');
  ctx.fillStyle = flame;
  ctx.beginPath();
  ctx.moveTo(-10.5, -3.1);
  ctx.quadraticCurveTo(-11 - plume * 0.6, 0, -10.5, 3.1);
  ctx.closePath();
  ctx.fill();

  /* tail fin */
  ctx.fillStyle = '#8fa0b8';
  ctx.beginPath();
  ctx.moveTo(-5.5, -1.6);
  ctx.lineTo(-12.6, -8.4);
  ctx.lineTo(-10.2, -0.4);
  ctx.closePath();
  ctx.fill();

  /* swept wings */
  const wing = ctx.createLinearGradient(2, -10, -6, 10);
  wing.addColorStop(0, '#eef4ff');
  wing.addColorStop(1, '#8d9db5');
  ctx.fillStyle = wing;
  ctx.beginPath();
  ctx.moveTo(3.4, -0.6);
  ctx.lineTo(-7.4, -10.6);
  ctx.quadraticCurveTo(-5.2, -4.4, -6.2, -1.4);
  ctx.lineTo(-6.2, 1.4);
  ctx.quadraticCurveTo(-5.2, 4.4, -7.4, 10.6);
  ctx.lineTo(3.4, 0.6);
  ctx.closePath();
  ctx.fill();

  /* fuselage */
  ctx.save();
  ctx.shadowColor = 'rgba(255, 182, 46, 0.6)';
  ctx.shadowBlur = 12;
  const body = ctx.createLinearGradient(0, -5, 0, 5);
  body.addColorStop(0, '#ffffff');
  body.addColorStop(0.55, '#e6edf9');
  body.addColorStop(1, '#aebbd0');
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(15, 0);
  ctx.quadraticCurveTo(8.5, -5.1, -1.5, -4.5);
  ctx.lineTo(-11.5, -2.7);
  ctx.quadraticCurveTo(-13.4, 0, -11.5, 2.7);
  ctx.lineTo(-1.5, 4.5);
  ctx.quadraticCurveTo(8.5, 5.1, 15, 0);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  /* amber nose + spine stripe */
  ctx.fillStyle = '#ffb62e';
  ctx.beginPath();
  ctx.moveTo(15, 0);
  ctx.quadraticCurveTo(12.6, -2.1, 11.4, -2.2);
  ctx.lineTo(11.4, 2.2);
  ctx.quadraticCurveTo(12.6, 2.1, 15, 0);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = 'rgba(255, 182, 46, 0.85)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(10.6, -1.9);
  ctx.lineTo(-9.5, -2.1);
  ctx.stroke();

  /* cockpit */
  const glass = ctx.createLinearGradient(4, -3, 8, 1);
  glass.addColorStop(0, '#9fe4ff');
  glass.addColorStop(0.5, '#2b5f86');
  glass.addColorStop(1, '#0c1c2e');
  ctx.fillStyle = glass;
  ctx.beginPath();
  ctx.ellipse(6.4, -0.6, 3.5, 2.1, -0.12, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.lineWidth = 0.7;
  ctx.stroke();

  /* blinking wingtip strobe */
  if (Math.sin(time * 7) > 0.6) {
    ctx.fillStyle = 'rgba(255, 90, 60, 0.95)';
    ctx.shadowColor = 'rgba(255, 90, 60, 0.9)';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.arc(-7.2, -10.4, 1.1, 0, TAU);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  ctx.restore();
}

function drawChart(time = performance.now() / 1000) {
  if (!boxW || !boxH) return;
  const w = boxW;
  const h = boxH;
  ctx.clearRect(0, 0, w, h);
  drawStars(time);

  const crashed = S.phase === 'crashed';
  const running = S.phase === 'running';
  const elapsed = running ? Math.max(0, (Date.now() - S.localStart) / 1000) : crashed ? S.crashElapsed : 0;
  const mult = running ? currentMultiplier() : crashed ? S.crashAt || 1 : 1;

  const padLeft = 10;
  const padRight = 14;
  const padTop = 18;
  const padBottom = 16;
  const x0 = padLeft;
  const x1 = w - padRight;
  const y0 = h - padBottom;
  const yTop = padTop;

  const windowT = Math.max(3.2, elapsed * 1.06);
  const yMax = Math.max(1.7, mult * 1.16);
  const logMax = Math.log(yMax);
  const px = (seconds) => x0 + (Math.min(seconds, windowT) / windowT) * (x1 - x0);
  const py = (value) => y0 - (Math.log(Math.max(1, value)) / logMax) * (y0 - yTop);

  /* grid */
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.fillStyle = 'rgba(244,238,252,0.28)';
  ctx.lineWidth = 1;
  ctx.font = '9px "Space Grotesk", system-ui, sans-serif';
  ctx.textAlign = 'left';
  for (const value of GRID_MULTS) {
    if (value > yMax) break;
    const y = py(value);
    ctx.beginPath();
    ctx.setLineDash([3, 5]);
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillText(`${value}x`, x0 + 1, y - 4);
  }

  // vertical time grid, roughly every 1/4 of the window
  ctx.strokeStyle = 'rgba(255,255,255,0.035)';
  for (let i = 1; i < 4; i += 1) {
    const x = x0 + ((x1 - x0) * i) / 4;
    ctx.beginPath();
    ctx.moveTo(x, yTop);
    ctx.lineTo(x, y0);
    ctx.stroke();
  }
  ctx.restore();

  /* curve */
  const color = crashed ? '#ff3b2f' : '#ffb62e';
  const fillTop = crashed ? 'rgba(255,59,47,0.26)' : 'rgba(255,182,46,0.24)';

  const path = new Path2D();
  path.moveTo(px(0), py(1));

  if (running || crashed) {
    const steps = Math.max(2, Math.min(160, Math.ceil(elapsed * 18) + 2));
    for (let i = 1; i <= steps; i += 1) {
      const sec = (elapsed * i) / steps;
      path.lineTo(px(sec), py(Math.exp(S.growth * sec)));
    }
  } else {
    // Betting lobby: a calm flat line waiting for take-off.
    path.lineTo(px(windowT), py(1));
  }

  const area = new Path2D(path);
  area.lineTo(px(running || crashed ? elapsed : windowT), y0);
  area.lineTo(px(0), y0);
  area.closePath();

  const grad = ctx.createLinearGradient(0, yTop, 0, y0);
  grad.addColorStop(0, fillTop);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fill(area);

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = color;
  ctx.lineWidth = crashed ? 2.4 : 2.6;
  ctx.shadowColor = crashed ? 'rgba(255,59,47,0.55)' : 'rgba(255,182,46,0.55)';
  ctx.shadowBlur = 16;
  ctx.stroke(path);
  ctx.restore();

  /* engine trail, a short fading ribbon behind the jet */
  if (running && elapsed > 0.12) {
    const back = 0.45;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255, 236, 200, 0.6)';
    for (let i = 0; i < 6; i += 1) {
      const t0 = Math.max(0, elapsed - back + (back * i) / 6);
      const t1 = Math.max(0, elapsed - back + (back * (i + 1)) / 6);
      if (t1 <= 0.001) continue;
      ctx.globalAlpha = 0.04 + (i / 6) * 0.2;
      ctx.lineWidth = 1.2 + (i / 6) * 2.6;
      ctx.beginPath();
      ctx.moveTo(px(t0), py(Math.exp(S.growth * t0)));
      ctx.lineTo(px(t1), py(Math.exp(S.growth * t1)));
      ctx.stroke();
    }
    ctx.restore();
  }

  /* the jet */
  const atRunway = !running && !crashed;
  const rawX = px(atRunway ? windowT : elapsed);
  const rawY = py(atRunway ? 1 : Math.exp(S.growth * elapsed));
  const headX = Math.max(x0 + 12, Math.min(x1 - 15, rawX));
  const headY = Math.max(yTop + 13, Math.min(y0 - 9, rawY));

  if (!crashed) {
    ctx.save();
    const halo = ctx.createRadialGradient(headX, headY, 0, headX, headY, 20);
    halo.addColorStop(0, running ? 'rgba(255,214,150,0.7)' : 'rgba(255,214,150,0.3)');
    halo.addColorStop(1, 'rgba(255,182,46,0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(headX, headY, 20, 0, TAU);
    ctx.fill();
    ctx.restore();

    let angle = -0.12;
    if (running) {
      const back = Math.max(0, elapsed - 0.08);
      const dx = px(elapsed) - px(back);
      const dy = py(Math.exp(S.growth * elapsed)) - py(Math.exp(S.growth * back));
      if (Math.hypot(dx, dy) > 0.4) angle = Math.atan2(dy, dx);
      angle = Math.max(-1.25, Math.min(0.16, angle));
      emitExhaust(headX, headY, angle, 1 + (Math.random() < 0.5 ? 1 : 0));
    }

    drawPlane(headX, headY, angle, planeSize(), time);
  } else if (S.explodedRound !== S.roundNo) {
    S.explodedRound = S.roundNo;
    spawnExplosion(headX, headY);
  }

  drawFlightFx();
}

let lastFrameAt = 0;
function frame(now = performance.now()) {
  const dt = Math.min(0.05, Math.max(0, (now - lastFrameAt) / 1000));
  lastFrameAt = now;
  // Keep the canvas backing store in step with the layout (rotation, resize).
  if (canvas.clientWidth && Math.abs(canvas.clientWidth - boxW) > 0.5) resizeCanvas();
  paintMultiplier();
  paintStatus();
  stepFlight(dt);
  drawChart(now / 1000);
  requestAnimationFrame(frame);
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

let toastTimer = null;
function toast(message, kind = '') {
  el.toast.textContent = message;
  el.toast.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.className = `toast ${kind}`;
  }, 2600);
}

function setBalance(value) {
  if (typeof value === 'number') {
    S.me = S.me || {};
    S.me.balance = value;
    paintBalance();
  }
}

function haptic(kind = 'light') {
  const tg = telegram();
  if (!tg || !tg.HapticFeedback) return;
  try {
    if (kind === 'success') tg.HapticFeedback.notificationOccurred('success');
    else if (kind === 'error') tg.HapticFeedback.notificationOccurred('error');
    else tg.HapticFeedback.impactOccurred('light');
  } catch {
    /* older clients */
  }
}

async function placeBet() {
  const stake = Math.round(Number(el.amount.value) || 0);
  const auto = el.autoOn.checked ? Number(el.autoAt.value) || 0 : 0;
  try {
    const res = await api('/api/crash/bet', { amount: stake, autoCashout: auto });
    setBalance(res.balance);
    toast(t('crash.betPlaced'), 'ok');
    haptic('light');
    chime(520, 0.07);
    await refresh();
  } catch (err) {
    toast(err.message, 'bad');
    haptic('error');
  }
}

async function cancelBet() {
  try {
    const res = await api('/api/crash/cancel', {});
    setBalance(res.balance);
    await refresh();
  } catch (err) {
    toast(err.message, 'bad');
  }
}

async function cashout() {
  if (S.busy) return;
  S.busy = true;
  el.action.disabled = true;
  try {
    const res = await api('/api/crash/cashout', {});
    setBalance(res.balance);
    toast(t('crash.cashed', { amount: fmt(res.payout), mult: mult2(res.multiplier) }), 'ok');
    haptic('success');
    cashoutSound();
    await refresh();
  } catch (err) {
    toast(err.message, 'bad');
    haptic('error');
  } finally {
    S.busy = false;
    renderAction();
  }
}

async function refresh() {
  try {
    const state = await api('/api/crash/state');
    applyState(state);
  } catch {
    /* socket will catch up */
  }
}

el.action.addEventListener('click', () => {
  const mode = el.action.dataset.mode;
  if (mode === 'bet') placeBet();
  else if (mode === 'cancel') cancelBet();
  else if (mode === 'cashout') cashout();
});

el.amount.addEventListener('input', () => {
  el.hint.dataset.custom = '0';
  renderAmounts();
  renderAction();
});

el.quick.addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-amount]');
  if (!btn) return;
  el.amount.value = btn.dataset.amount;
  renderAmounts();
  renderAction();
});

document.querySelectorAll('.step').forEach((btn) => {
  btn.addEventListener('click', () => {
    const max = Number(S.config.maxBet) || 500;
    const step = Number(el.amount.step) || 10;
    const next = Math.round((Number(el.amount.value) || 0) + step * Number(btn.dataset.step));
    el.amount.value = String(Math.max(step, Math.min(max, next)));
    renderAmounts();
    renderAction();
  });
});

el.autoOn.addEventListener('change', () => {
  el.autoAt.disabled = !el.autoOn.checked;
  try {
    localStorage.setItem('tb_crash_auto', el.autoOn.checked ? el.autoAt.value : '0');
  } catch {
    /* storage blocked */
  }
});

el.autoAt.addEventListener('change', () => {
  const value = Math.max(1.01, Number(el.autoAt.value) || 2);
  el.autoAt.value = value.toFixed(2);
  if (el.autoOn.checked) {
    try {
      localStorage.setItem('tb_crash_auto', el.autoAt.value);
    } catch {
      /* storage blocked */
    }
  }
});

el.copySeed.addEventListener('click', async () => {
  if (!S.seed) return;
  try {
    await navigator.clipboard.writeText(S.seed);
    toast(t('crash.copied'), 'ok');
  } catch {
    toast(S.seed.slice(0, 40) + '…', '');
  }
});

el.muteBtn.addEventListener('click', () => {
  setMuted(!S.muted);
  if (S.muted) toast(t('crash.muted'), '');
  else toast(t('crash.unmuted'), '');
});

/* ------------------------------------------------------------------ */
/* Crash effect                                                        */
/* ------------------------------------------------------------------ */

function showCrash(crashAt, roundNo) {
  S.shownCrash = roundNo;
  S.crashElapsed = Math.log(Math.max(1, crashAt)) / S.growth;
  el.stage.dataset.phase = 'crashed';

  el.crashFlash.classList.remove('play');
  void el.crashFlash.offsetWidth;
  el.crashFlash.classList.add('play');

  const app = document.querySelector('.app');
  if (app) {
    app.classList.remove('shake');
    void app.offsetWidth;
    app.classList.add('shake');
  }

  stopDrone();
  if (!S.muted) boom();
  if (navigator.vibrate) navigator.vibrate([35, 50, 90]);
  setTimeout(() => {
    if (app) app.classList.remove('shake');
  }, 500);
}

/* ------------------------------------------------------------------ */
/* Sound                                                               */
/* ------------------------------------------------------------------ */

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

function chime(freq = 660, gain = 0.05) {
  const ac = audioContext();
  if (!ac || S.muted) return;
  if (ac.state === 'suspended') ac.resume().catch(() => {});
  try {
    const now = ac.currentTime;
    const osc = ac.createOscillator();
    const vol = ac.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.exponentialRampToValueAtTime(freq * 1.5, now + 0.09);
    vol.gain.setValueAtTime(gain, now);
    vol.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
    osc.connect(vol);
    vol.connect(ac.destination);
    osc.start(now);
    osc.stop(now + 0.18);
  } catch {
    /* stay silent */
  }
}

function cashoutSound() {
  chime(880, 0.06);
  setTimeout(() => chime(1320, 0.05), 90);
}

function boom() {
  const ac = audioContext();
  if (!ac) return;
  if (ac.state === 'suspended') ac.resume().catch(() => {});
  try {
    const now = ac.currentTime;
    const out = ac.createGain();
    out.gain.setValueAtTime(0.8, now);
    out.gain.exponentialRampToValueAtTime(0.0001, now + 0.85);
    out.connect(ac.destination);

    const len = Math.floor(ac.sampleRate * 0.7);
    const buffer = ac.createBuffer(1, len, ac.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const noise = ac.createBufferSource();
    noise.buffer = buffer;
    const filter = ac.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(2600, now);
    filter.frequency.exponentialRampToValueAtTime(180, now + 0.6);
    noise.connect(filter);
    filter.connect(out);
    noise.start(now);
    noise.stop(now + 0.7);

    const sub = ac.createOscillator();
    const subGain = ac.createGain();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(120, now);
    sub.frequency.exponentialRampToValueAtTime(32, now + 0.45);
    subGain.gain.setValueAtTime(0.85, now);
    subGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.7);
    sub.connect(subGain);
    subGain.connect(out);
    sub.start(now);
    sub.stop(now + 0.75);

    setTimeout(() => {
      try {
        out.disconnect();
        filter.disconnect();
        subGain.disconnect();
      } catch {}
    }, 1200);
  } catch {
    /* stay silent */
  }
}

function startDrone() {
  if (S.muted) return;
  const ac = audioContext();
  if (!ac) return;
  if (ac.state === 'suspended') ac.resume().catch(() => {});
  stopDrone();
  try {
    const now = ac.currentTime;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    const filter = ac.createBiquadFilter();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(70, now);
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(420, now);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.035, now + 0.5);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(ac.destination);
    osc.start(now);
    S.drone = { osc, gain, filter, ac };
  } catch {
    S.drone = null;
  }
}

function updateDrone(multiplier) {
  if (!S.drone) return;
  try {
    const target = 70 + Math.log(Math.max(1, multiplier)) * 55;
    S.drone.osc.frequency.setTargetAtTime(target, S.drone.ac.currentTime, 0.12);
    S.drone.filter.frequency.setTargetAtTime(Math.min(1400, 380 + target * 2), S.drone.ac.currentTime, 0.15);
  } catch {
    /* audio node gone */
  }
}

function stopDrone() {
  if (!S.drone) return;
  const { osc, gain, ac, filter } = S.drone;
  S.drone = null;
  try {
    const now = ac.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setTargetAtTime(0, now, 0.04);
    osc.stop(now + 0.25);
    setTimeout(() => {
      try {
        osc.disconnect();
        filter.disconnect();
        gain.disconnect();
      } catch {}
    }, 400);
  } catch {
    /* already stopped */
  }
}

function setMuted(muted) {
  S.muted = !!muted;
  el.muteIcon.textContent = S.muted ? '🔇' : '🔊';
  el.muteBtn.setAttribute('aria-pressed', S.muted ? 'true' : 'false');
  try {
    localStorage.setItem('tb_crash_mute', S.muted ? '1' : '0');
  } catch {
    /* storage blocked */
  }
  if (S.muted) stopDrone();
  else if (S.phase === 'running') startDrone();
}

/* ------------------------------------------------------------------ */
/* Realtime                                                            */
/* ------------------------------------------------------------------ */

function connect() {
  S.socket = io('/crash', { transports: ['websocket', 'polling'] });
  S.socket.on('crash:state', (state) => applyState(state));
  S.socket.on('crash:tick', (tick) => {
    if (tick && tick.phase === 'betting' && tick.msLeft != null) {
      S.betEndLocal = Date.now() + tick.msLeft;
    }
  });
  S.socket.on('crash:crashed', (info) => {
    // The state event also carries the crash; this only makes sure the effect
    // fires even if a state packet was dropped.
    if (info && info.crashAt && S.shownCrash !== info.roundNo) {
      S.crashAt = info.crashAt;
      S.phase = 'crashed';
      S.crashElapsed = Math.log(info.crashAt) / S.growth;
      showCrash(info.crashAt, info.roundNo);
      renderAction();
    }
  });
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

(function boot() {
  const dev = new URLSearchParams(location.search).get('dev') === '1';
  const suffix = dev ? '?dev=1' : '';
  const walletSuffix = dev ? '?dev=1&wallet=1' : '?wallet=1';
  $('backBtn').setAttribute('href', `/${suffix}`);
  $('walletChip').setAttribute('href', `/${walletSuffix}`);

  try {
    const savedAuto = Number(localStorage.getItem('tb_crash_auto')) || 0;
    if (savedAuto >= 1.01) {
      el.autoOn.checked = true;
      el.autoAt.disabled = false;
      el.autoAt.value = savedAuto.toFixed(2);
    }
    S.muted = localStorage.getItem('tb_crash_mute') === '1';
  } catch {
    S.muted = false;
  }
  if (S.muted) {
    el.muteIcon.textContent = '🔇';
    el.muteBtn.setAttribute('aria-pressed', 'true');
  }

  ['pointerdown', 'keydown'].forEach((evt) =>
    window.addEventListener(evt, () => {
      const ac = audioContext();
      if (ac && ac.state === 'suspended') ac.resume().catch(() => {});
    }, { passive: true })
  );

  resizeCanvas();
  if (window.ResizeObserver) new ResizeObserver(resizeCanvas).observe($('chart'));
  requestAnimationFrame(frame);

  window.I18n.onChange(() => {
    S.lastStatus = '';
    S.lastMultText = '';
    el.hint.dataset.custom = '';
    renderAmounts();
    renderAction();
    renderBetList();
    paintStatus();
  });

  signIn().then(() => refresh());
  connect();

  // Wallets can change outside the game (admin top-up, another tab).
  setInterval(() => {
    if (!document.hidden) refreshMe();
  }, 12000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshMe();
  });
})();
