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
    A.autoStart = !!data.config.autoStart;
    fillSettings();
    renderStats();
    renderLive();
    renderUsers();
    renderRounds();
    $('dbPill').textContent = t('admin.db', { mode: data.dbMode });
    $('dbPill').className = `pill ${data.dbMode === 'mongo' ? 'ok' : 'warn'}`;
    if (data.dbMode !== 'mongo') $('dbPill').title = 'Memory mode: data is lost on restart. Set MONGODB_URI.';
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

  $('livePill').textContent = paused ? t('status.paused') : live ? t('status.live') : t('status.idle');
  $('livePill').className = `pill ${paused ? 'warn' : live ? 'ok' : ''}`;
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
        <td class="mono">${fmt(u.balance)}</td>
        <td class="mono">${fmt(u.wins)} <span class="sub" style="display:inline">/ ${fmt(u.winnings)} ${t('common.etb')}</span></td>
        <td>
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
        <td>${winner}</td>
        <td class="mono">${fmt(r.pot)}</td>
        <td class="mono">${fmt(r.payout)}</td>
        <td class="mono" style="color: var(--amber)">${fmt(r.houseCut)}</td>
        <td><span class="badge ${r.status}">${r.status}</span></td>
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
