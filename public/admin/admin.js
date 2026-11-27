'use strict';

const t = (key, vars) => window.I18n.t(key, vars);
const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.max(0, Math.round(Number(n) || 0)).toLocaleString('en-US');

const A = {
  token: sessionStorage.getItem('tb_admin') || '',
  state: null,
  config: null,
  stats: null,
  users: [],
  rounds: [],
  payments: [],
  crash: { state: null, config: null, stats: null, clockOffset: 0 },
  autoStart: true,
  sync: { msLeft: 0, at: 0, paused: false },
  search: '',
  targetUser: null,
  socket: null,
  refreshTimer: null,
};

let toastTimer = null;
function toast(msg, kind = '') {
  const box = $('toast');
  box.textContent = msg;
  box.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (box.className = `toast ${kind}`), 2800);
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (A.token) headers.Authorization = `Bearer ${A.token}`;
  const res = await fetch(path, { ...options, headers });
  let body = {};
  try {
    body = await res.json();
  } catch {
    /* no body */
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

/* ------------------------------- login -------------------------------- */
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('loginBtn');
  $('loginError').textContent = '';
  if (!$('adminPassword').value) {
    $('loginError').textContent = t('admin.errRequired');
    return;
  }
  btn.disabled = true;
  try {
    const data = await api('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password: $('adminPassword').value }),
    });
    A.token = data.token;
    sessionStorage.setItem('tb_admin', data.token);
    $('adminPassword').value = '';
    await enterPanel();
  } catch (err) {
    $('loginError').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$('logoutBtn').addEventListener('click', () => {
  A.token = '';
  sessionStorage.removeItem('tb_admin');
  if (A.socket) A.socket.disconnect();
  clearInterval(A.refreshTimer);
  $('panel').style.display = 'none';
  $('login').classList.remove('hidden');
});

async function enterPanel() {
  $('login').classList.add('hidden');
  $('panel').style.display = 'block';
  await refresh();
  setView((location.hash || '#overview').slice(1), false);
  connectSocket();
  clearInterval(A.refreshTimer);
  A.refreshTimer = setInterval(() => {
    if (!A.socket || !A.socket.connected) refresh();
  }, 8000);
}

/* ------------------------------ data load ------------------------------ */
async function refresh() {
  try {
    const data = await api('/api/admin/overview');
    A.state = data.state;
    A.config = data.config;
    A.stats = data.stats;
    A.users = data.users;
    A.rounds = data.rounds;
    A.payments = data.payments || [];
    if (data.crash) {
      A.crash.state = data.crash.state;
      A.crash.config = data.crash.config;
      A.crash.stats = data.crash.stats;
      A.crash.clockOffset = ((data.crash.state && data.crash.state.serverTime) || Date.now()) - Date.now();
    }
    A.autoStart = !!data.config.autoStart;
    fillSettings();
    renderStats();
    renderLive();
    fillCrash();
    renderCrash();
    renderRequests();
    renderUsers();
    renderRounds();
    $('dbPill').textContent = t('admin.db', { mode: data.dbMode });
    $('dbPill').className = `pill ${data.dbMode === 'mongo' ? 'ok' : 'warn'}`;
    if (data.dbMode !== 'mongo') $('dbPill').title = 'Memory mode: data is lost on restart. Set MONGODB_URI.';
    $('menuFoot').textContent = t('admin.db', { mode: data.dbMode });
    $('menuFoot').className = 'menu-foot';
  } catch (err) {
    if (err.status === 401) {
      $('panel').style.display = 'none';
      $('login').classList.remove('hidden');
      $('loginError').textContent = t('admin.expired');
    } else {
      toast(err.message, 'bad');
    }
  }
}

function fillSettings() {
  const c = A.config;
  if (!c) return;
  $('cfgEntryFee').value = c.entryFee;
  $('cfgHouseCut').value = c.houseCut;
  $('cfgStartSeconds').value = c.startSeconds;
  $('cfgResetSeconds').value = c.resetSeconds;
  $('cfgStartingBalance').value = c.startingBalance;
  $('cfgGap').value = c.minDepositGapMs;
  $('autoStartSwitch').classList.toggle('on', !!c.autoStart);
  $('pauseBtn').textContent = c.paused ? t('live.resume') : t('live.pause');
  $('pauseBtn').classList.toggle('go', !!c.paused);
  $('pauseBtn').classList.toggle('warn', !c.paused);
  $('endBtn').textContent = t('live.end');
  $('cancelBtn').textContent = t('live.cancel');
  $('startBtn').textContent = t('live.start');
  $('saveSettings').textContent = t('set.save');
}

function renderStats() {
  if (!A.stats) return;
  const unit = t('common.etb');
  $('sHouse').textContent = `${fmt(A.stats.houseEarned)} ${unit}`;
  $('sPaid').textContent = `${fmt(A.stats.paidOut)} ${unit}`;
  $('sRounds').textContent = fmt(A.stats.rounds);
  $('sPlayers').textContent = fmt(A.stats.players);
}

/* ------------------------------- live view ----------------------------- */
function getMsLeft() {
  const s = A.state;
  if (!s || !s.round || s.round.status !== 'live') return 0;
  if (s.paused) return s.msLeft;
  return Math.max(0, A.sync.msLeft - (performance.now() - A.sync.at));
}

function renderLive() {
  const s = A.state;
  if (!s) return;
  const round = s.round;
  const cfg = s.config || {};
  const paused = s.paused;
  const live = round && round.status === 'live';

  const bombLabel = paused ? t('status.paused') : live ? t('status.live') : t('status.idle');
  setGameState('menuBombState', paused ? 'paused' : live ? 'live' : 'idle', bombLabel);
  setGameState('tileBombState', paused ? 'paused' : live ? 'live' : 'idle', bombLabel);
  $('tileBombMeta').textContent = round
    ? t('agames.bombMeta', { pot: fmt(round.pot || 0), players: fmt(round.depositors || 0) })
    : t('agames.none');
  $('tileBombPause').textContent = paused ? t('live.resume') : t('live.pause');
  $('tileBombPause').classList.toggle('is-on', !!paused);
  $('roundTag').textContent = round ? t('live.round', { no: round.no }) : t('live.noRound');
  $('livePot').textContent = `${fmt(round?.pot || 0)} ${t('common.etb')}`;
  $('liveLast').textContent = round?.lastDepositor ? `@${round.lastDepositor.username}` : t('rounds.none');
  $('livePushes').textContent = round ? fmt(round.depositCount || 0) : '0';
  $('livePlayers').textContent = round ? fmt(round.depositors || 0) : '0';
  $('endBtn').disabled = !live;
  $('cancelBtn').disabled = !live || !round?.pot;
  $('startBtn').disabled = !!live;

  const cut = cfg.houseCut ?? 10;
  $('cancelBtn').title = `${t('live.cancel')} — ${fmt(round?.pot || 0)} ${t('common.etb')}`;
  $('endBtn').title = `@${round?.lastDepositor?.username || '—'} · ${fmt(Math.floor(((round?.pot || 0) * (100 - cut)) / 100))} ${t('common.etb')}`;
  paintClock();
}

function paintClock() {
  const s = A.state;
  const live = s?.round?.status === 'live';
  const left = live ? getMsLeft() : 0;
  const text = !live
    ? s?.paused
      ? t('status.paused')
      : '—'
    : left >= 10000
      ? String(Math.ceil(left / 1000))
      : left > 0
        ? (left / 1000).toFixed(1)
        : '00';
  if ($('fuse').textContent !== text) $('fuse').textContent = text;
  $('fuseBox').classList.toggle('danger', live && !s.paused && left > 0 && left <= 5000);
}

setInterval(() => requestAnimationFrame(paintClock), 100);
setInterval(() => requestAnimationFrame(paintCrash), 100);

/* -------------------------------- crash -------------------------------- */
function fillCrash() {
  const c = A.crash && A.crash.config;
  if (!c) return;
  const active = document.activeElement;
  if (active !== $('crashMin')) $('crashMin').value = c.minBet;
  if (active !== $('crashMax')) $('crashMax').value = c.maxBet;
  if (active !== $('crashSeconds')) $('crashSeconds').value = c.betSeconds;
  if (active !== $('crashEdge')) $('crashEdge').value = c.houseEdge;

  $('crashPause').textContent = c.paused ? t('acrash.resume') : t('acrash.pause');
  $('crashPause').classList.toggle('go', !!c.paused);
  $('crashPause').classList.toggle('warn', !c.paused);
  $('crashSave').textContent = t('acrash.save');
}

function crashMultiplier() {
  const state = A.crash && A.crash.state;
  if (!state) return 1;
  if (state.phase === 'crashed') return state.crashAt || 1;
  if (state.phase !== 'running' || !state.startedAt) return 1;
  const elapsed = Math.max(0, (Date.now() + A.crash.clockOffset - state.startedAt) / 1000);
  const growth = (state.config && state.config.growth) || 0.09;
  return Math.exp(growth * elapsed);
}

function renderCrash() {
  const data = A.crash;
  if (!data || !data.state) return;
  const state = data.state;
  const stats = data.stats || {};
  const unit = t('common.etb');

  const crashPhase = state.phase || 'idle';
  const crashLabel = t(`acrash.state.${crashPhase}`);
  setGameState('menuCrashState', crashPhase, crashLabel);
  setGameState('tileCrashState', crashPhase, crashLabel);
  const crashPaused = !!(data.config && data.config.paused);
  $('tileCrashPause').textContent = crashPaused ? t('acrash.resume') : t('acrash.pause');
  $('tileCrashPause').classList.toggle('is-on', crashPaused);
  $('tileCrashMeta').textContent = t('agames.crashMeta', {
    no: fmt(state.roundNo || 0),
    bets: fmt((state.bets || []).length),
  });

  $('crashPhase').textContent = crashLabel;
  $('crashRound').textContent = state.roundNo ? `#${state.roundNo}` : t('rounds.none');
  $('crashBets').textContent = fmt((state.bets || []).length);
  $('crashStaked').textContent = `${fmt((state.totals && state.totals.bet) || 0)} ${unit}`;
  $('crashPaid').textContent = `${fmt((state.totals && state.totals.payout) || 0)} ${unit}`;
  $('crashProfit').textContent = `${fmt(stats.houseProfit || 0)} ${unit}`;
  $('crashProfit').title = `${t('acrash.rounds')}: ${fmt(stats.rounds || 0)} · ${t('acrash.maxMult')}: ${Number(stats.maxMultiplier || 0).toFixed(2)}x`;
}

function paintCrash() {
  const state = A.crash && A.crash.state;
  if (!state) return;
  const live = state.phase === 'running' || state.phase === 'crashed';
  $('crashMult').textContent = live ? `${crashMultiplier().toFixed(2)}x` : '—';
}

$('crashForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('crashSave');
  btn.disabled = true;
  try {
    await api('/api/admin/crash/config', {
      method: 'POST',
      body: JSON.stringify({
        minBet: Number($('crashMin').value),
        maxBet: Number($('crashMax').value),
        betSeconds: Number($('crashSeconds').value),
        houseEdge: Number($('crashEdge').value),
      }),
    });
    toast(t('acrash.saved'), 'ok');
    await refresh();
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    btn.disabled = false;
  }
});

$('crashPause').addEventListener('click', async () => {
  const paused = !(A.crash && A.crash.config && A.crash.config.paused);
  try {
    await api('/api/admin/crash/config', { method: 'POST', body: JSON.stringify({ paused }) });
    toast(paused ? t('acrash.paused') : t('acrash.resumed'), 'ok');
    await refresh();
  } catch (err) {
    toast(err.message, 'bad');
  }
});

$('crashStop').addEventListener('click', async () => {
  if (!confirm(t('acrash.confirmStop'))) return;
  try {
    const res = await api('/api/admin/crash/stop', { method: 'POST' });
    toast(t('acrash.stopped', { mult: Number(res.result && res.result.crashAt ? res.result.crashAt : 0).toFixed(2) }), 'ok');
    await refresh();
  } catch (err) {
    toast(err.message, 'bad');
  }
});

/* --------------------------- payment requests -------------------------- */
function renderRequests() {
  const body = $('reqBody');
  const pending = A.payments || [];
  $('reqTag').textContent = t('req.pending', { n: fmt(pending.length) });
  const badge = $('menuDeposits');
  badge.hidden = !pending.length;
  badge.textContent = fmt(pending.length);
  if (!pending.length) {
    body.innerHTML = `<tr><td colspan="5" style="color: var(--dim-2); text-align: center; padding: 20px">${t('req.empty')}</td></tr>`;
    return;
  }
  body.innerHTML = pending
    .map((p) => {
      const kind = p.type === 'withdraw' ? t('req.withdraw') : t('req.deposit');
      const detail = p.type === 'withdraw' ? p.phone : p.text;
      return `<tr>
        <td>
          <span class="uname">${esc(p.username)}</span>
          <span class="sub">${p.telegramId ? `ID ${esc(p.telegramId)}` : t('players.noPhone')}</span>
        </td>
        <td data-label="${t('req.type')}"><span class="badge req">${kind}</span></td>
        <td class="mono" data-label="${t('req.amount')}">${fmt(p.amount)}</td>
        <td class="msg-cell" data-label="${t('req.message')}" title="${esc(detail)}">${esc(detail)}</td>
        <td data-label="${t('req.actions')}">
          <button class="mini plus" data-req="approve" data-id="${p.id}">${t('req.approve')}</button>
          <button class="mini minus" data-req="reject" data-id="${p.id}">${t('req.reject')}</button>
        </td>
      </tr>`;
    })
    .join('');
}

$('reqBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-req]');
  if (!btn) return;
  const request = A.payments.find((p) => String(p.id) === btn.dataset.id);
  if (!request) return;
  btn.disabled = true;
  try {
    await api(`/api/admin/payments/${request.id}`, {
      method: 'POST',
      body: JSON.stringify({ action: btn.dataset.req }),
    });
    toast(
      btn.dataset.req === 'approve'
        ? t('req.approved', { name: request.username, amount: fmt(request.amount) })
        : t('req.rejected', { name: request.username }),
      'ok'
    );
    await refresh();
  } catch (err) {
    toast(err.message, 'bad');
    btn.disabled = false;
  }
});

/* ------------------------------- players ------------------------------- */
function esc(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderUsers() {
  const body = $('usersBody');
  $('playersTag').textContent = fmt(A.users.length);
  if (!A.users.length) {
    body.innerHTML = `<tr><td colspan="4" style="color: var(--dim-2); text-align: center; padding: 20px">${t('players.empty')}</td></tr>`;
    return;
  }
  body.innerHTML = A.users
    .map((u) => {
      const banned = u.banned ? ` · <span class="badge banned">${t('players.banned')}</span>` : '';
      return `<tr>
        <td>
          <span class="uname">${esc(u.username)}</span>
          <span class="sub">${u.telegramId ? `ID ${esc(u.telegramId)}` : t('players.noPhone')}${banned}</span>
        </td>
        <td class="mono" data-label="${t('players.wallet')}">${fmt(u.balance)}</td>
        <td class="mono" data-label="${t('players.wins')}">${fmt(u.wins)} <span class="sub" style="display:inline">/ ${fmt(u.winnings)} ${t('common.etb')}</span></td>
        <td data-label="${t('players.actions')}">
          <button class="mini plus" data-act="credit" data-id="${u.id}">${t('players.deposit')}</button>
          <button class="mini minus" data-act="debit" data-id="${u.id}">${t('players.withdraw')}</button>
          <button class="mini" data-act="ban" data-id="${u.id}">${u.banned ? t('players.unban') : t('players.ban')}</button>
        </td>
      </tr>`;
    })
    .join('');
}

$('usersBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const user = A.users.find((u) => String(u.id) === btn.dataset.id);
  if (!user) return;

  if (btn.dataset.act === 'ban') {
    try {
      await api(`/api/admin/users/${user.id}/ban`, {
        method: 'POST',
        body: JSON.stringify({ banned: !user.banned }),
      });
      toast(user.banned ? t('at.unbanned', { name: user.username }) : t('at.banned', { name: user.username }), 'ok');
      await refresh();
    } catch (err) {
      toast(err.message, 'bad');
    }
    return;
  }

  A.targetUser = user;
  $('balTitle').textContent = user.username;
  $('balSub').textContent = t('modal.sub', { amount: fmt(user.balance) });
  $('balAmount').value = '';
  $('balanceModal').classList.add('open');
  $('balanceModal').dataset.action = btn.dataset.act;
  setTimeout(() => $('balAmount').focus(), 60);
});

async function submitBalance(sign) {
  const user = A.targetUser;
  const amount = Math.round(Number($('balAmount').value) || 0);
  if (!user || !amount || amount <= 0) {
    toast(t('at.positiveAmount'), 'bad');
    return;
  }
  try {
    await api(`/api/admin/users/${user.id}/balance`, {
      method: 'POST',
      body: JSON.stringify({ delta: sign * amount }),
    });
    toast(t(sign > 0 ? 'at.credited' : 'at.debited', { amount: fmt(amount), name: user.username }), 'ok');
    $('balanceModal').classList.remove('open');
    await refresh();
  } catch (err) {
    toast(err.message, 'bad');
  }
}

$('balCredit').addEventListener('click', () => submitBalance(1));
$('balDebit').addEventListener('click', () => submitBalance(-1));
$('balanceModal').addEventListener('click', (e) => {
  if (e.target === $('balanceModal')) $('balanceModal').classList.remove('open');
});
$('balAmount').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitBalance(1);
});

let searchTimer = null;
$('userSearch').addEventListener('input', (e) => {
  A.search = e.target.value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    try {
      const data = await api(`/api/admin/users?search=${encodeURIComponent(A.search)}`);
      A.users = data.users;
      renderUsers();
    } catch {
      /* ignore */
    }
  }, 300);
});

/* -------------------------------- rounds ------------------------------- */
function renderRounds() {
  const body = $('roundsBody');
  $('roundsTag').textContent = fmt(A.rounds.length);
  if (!A.rounds.length) {
    body.innerHTML = `<tr><td colspan="6" style="color: var(--dim-2); text-align: center; padding: 20px">${t('rounds.empty')}</td></tr>`;
    return;
  }
  body.innerHTML = A.rounds
    .map((r) => {
      const winner = r.winnerName
        ? esc(r.winnerName)
        : r.status === 'live'
          ? t('rounds.inProgress')
          : t('rounds.none');
      return `<tr>
        <td class="mono">#${r.no}</td>
        <td data-label="${t('rounds.winner')}">${winner}</td>
        <td class="mono" data-label="${t('rounds.pot')}">${fmt(r.pot)}</td>
        <td class="mono" data-label="${t('rounds.payout')}">${fmt(r.payout)}</td>
        <td class="mono" data-label="${t('rounds.house')}" style="color: var(--amber)">${fmt(r.houseCut)}</td>
        <td data-label="${t('rounds.state')}"><span class="badge ${r.status}">${r.status}</span></td>
      </tr>`;
    })
    .join('');
}

/* ------------------------------- controls ------------------------------ */
$('pauseBtn').addEventListener('click', async () => {
  const paused = !A.config?.paused;
  try {
    await api('/api/admin/pause', { method: 'POST', body: JSON.stringify({ paused }) });
    toast(paused ? t('at.paused') : t('at.resumed'), 'ok');
    await refresh();
  } catch (err) {
    toast(err.message, 'bad');
  }
});

$('endBtn').addEventListener('click', async () => {
  const pot = A.state?.round?.pot || 0;
  const last = A.state?.round?.lastDepositor?.username || '—';
  if (!confirm(t('confirm.end', { name: last, pot: fmt(pot) }))) return;
  $('endBtn').disabled = true;
  try {
    const res = await api('/api/admin/round/end', { method: 'POST' });
    if (res.result?.expired) toast(t('at.recycled'), 'ok');
    else toast(t('at.paid', { name: res.result.winnerName, amount: fmt(res.result.payout) }), 'ok');
    await refresh();
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    $('endBtn').disabled = false;
  }
});

$('cancelBtn').addEventListener('click', async () => {
  const pot = A.state?.round?.pot || 0;
  if (!pot) return toast(t('at.nothingRefund'), 'bad');
  if (!confirm(t('confirm.cancel', { pot: fmt(pot) }))) return;
  $('cancelBtn').disabled = true;
  try {
    const res = await api('/api/admin/round/cancel', { method: 'POST' });
    toast(t('at.refunded', { amount: fmt(res.result.refunded) }), 'ok');
    await refresh();
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    $('cancelBtn').disabled = false;
  }
});

$('startBtn').addEventListener('click', async () => {
  $('startBtn').disabled = true;
  try {
    await api('/api/admin/round/start', { method: 'POST' });
    toast(t('at.newRound'), 'ok');
    await refresh();
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    $('startBtn').disabled = false;
  }
});

$('autoStartSwitch').addEventListener('click', async () => {
  A.autoStart = !A.autoStart;
  $('autoStartSwitch').classList.toggle('on', A.autoStart);
  try {
    await api('/api/admin/config', { method: 'POST', body: JSON.stringify({ autoStart: A.autoStart }) });
    toast(A.autoStart ? t('at.autoOn') : t('at.autoOff'), 'ok');
    await refresh();
  } catch (err) {
    toast(err.message, 'bad');
    await refresh();
  }
});

$('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('saveSettings');
  const payload = {
    entryFee: Number($('cfgEntryFee').value),
    houseCut: Number($('cfgHouseCut').value),
    startSeconds: Number($('cfgStartSeconds').value),
    resetSeconds: Number($('cfgResetSeconds').value),
    startingBalance: Number($('cfgStartingBalance').value),
    minDepositGapMs: Number($('cfgGap').value),
  };
  btn.disabled = true;
  btn.textContent = t('set.saving');
  try {
    await api('/api/admin/config', { method: 'POST', body: JSON.stringify(payload) });
    toast(t('at.settingsSaved'), 'ok');
    $('settingsSaved').textContent = t('set.saved', { time: new Date().toLocaleTimeString() });
    await refresh();
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    btn.disabled = false;
    btn.textContent = t('set.save');
  }
});

/* --------------------------- view switching ---------------------------- */
const VIEWS = ['overview', 'bomb', 'crash', 'deposits', 'players', 'rounds'];

function setGameState(id, state, label) {
  const node = $(id);
  if (!node) return;
  node.dataset.state = state;
  node.textContent = label;
}

function setView(view, push = true) {
  const next = VIEWS.includes(view) ? view : 'overview';
  document.querySelectorAll('.view').forEach((section) => {
    section.classList.toggle('active', section.dataset.view === next);
  });
  document.querySelectorAll('.menu-item[data-view]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === next);
  });
  document.body.dataset.view = next;
  if (push) {
    if (location.hash !== `#${next}`) history.replaceState(null, '', `#${next}`);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

$('menu').addEventListener('click', (event) => {
  const btn = event.target.closest('[data-view]');
  if (btn) setView(btn.dataset.view);
});

Array.from(document.querySelectorAll('[data-goto]')).forEach((btn) => {
  btn.addEventListener('click', () => setView(btn.dataset.goto));
});

window.addEventListener('hashchange', () => setView(location.hash.slice(1), false));

$('tileBombPause').addEventListener('click', async () => {
  const paused = !A.config?.paused;
  try {
    await api('/api/admin/pause', { method: 'POST', body: JSON.stringify({ paused }) });
    toast(paused ? t('at.paused') : t('at.resumed'), 'ok');
    await refresh();
  } catch (err) {
    toast(err.message, 'bad');
  }
});

$('tileCrashPause').addEventListener('click', async () => {
  const paused = !(A.crash && A.crash.config && A.crash.config.paused);
  try {
    await api('/api/admin/crash/config', { method: 'POST', body: JSON.stringify({ paused }) });
    toast(paused ? t('acrash.paused') : t('acrash.resumed'), 'ok');
    await refresh();
  } catch (err) {
    toast(err.message, 'bad');
  }
});

/* ------------------------------- realtime ------------------------------ */
function applyState(state) {
  A.state = state;
  A.sync = { msLeft: state.msLeft, at: performance.now(), paused: state.paused };
  renderLive();
  if (state.config) {
    A.config = { ...A.config, ...state.config, paused: state.paused };
    fillSettings();
  }
}

function connectSocket() {
  if (A.socket) A.socket.disconnect();
  A.socket = io('/admin', { auth: { token: A.token } });
  A.socket.on('state', applyState);
  A.socket.on('crash:state', (state) => {
    A.crash.state = state;
    A.crash.clockOffset = (state.serverTime || Date.now()) - Date.now();
    renderCrash();
  });
  A.socket.on('connect_error', () => {
    /* falls back to polling in refreshTimer */
  });
  A.socket.on('round:ended', () => {
    toast(t('at.roundSettled'), 'ok');
    refresh();
  });
  A.socket.on('round:deposit', (info) => {
    if (info?.username) toast(t('at.deposit', { name: info.username, amount: fmt(info.amount) }));
  });
}

/* -------------------------------- language ----------------------------- */
window.I18n.onChange(() => {
  fillSettings();
  renderStats();
  renderLive();
  fillCrash();
  renderCrash();
  renderRequests();
  renderUsers();
  renderRounds();
  if (A.targetUser) $('balSub').textContent = t('modal.sub', { amount: fmt(A.targetUser.balance) });
  if (A.state) $('dbPill').textContent = t('admin.db', { mode: A.state.dbMode });
});

/* -------------------------------- boot --------------------------------- */
(async function boot() {
  if (!A.token) {
    $('login').classList.remove('hidden');
    return;
  }
  try {
    await api('/api/admin/overview');
    await enterPanel();
  } catch {
    A.token = '';
    sessionStorage.removeItem('tb_admin');
    $('loginError').textContent = t('admin.expired');
  }
})();
