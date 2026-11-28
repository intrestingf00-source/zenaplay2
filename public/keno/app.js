'use strict';

(function () {
  const t = (key, vars) => window.I18n.t(key, vars);
  const $ = (id) => document.getElementById(id);

  const tg = window.Telegram && window.Telegram.WebApp;
  if (tg) {
    try {
      tg.ready();
      tg.expand();
      if (tg.setHeaderColor) tg.setHeaderColor('#07050c');
      if (tg.setBackgroundColor) tg.setBackgroundColor('#07050c');
      if (tg.disableVerticalSwipes) tg.disableVerticalSwipes();
    } catch (err) {
      /* older Telegram clients */
    }
  }

  const params = new URLSearchParams(location.search);
  const devMode = params.get('dev') === '1';

  const K = {
    token: '',
    me: null,
    config: { minBet: 10, maxBet: 500, maxPicks: 10 },
    betMs: 30000,
    modes: { straight: {}, hitall: {}, against: {}, halves: {} },
    mode: 'straight',
    side: 'top',
    picks: new Set(),
    drawn: [],
    amount: 10,
    busy: false,
    round: null,
    offset: 0,
    order: null,
    ticket: null,
    last: null,
    revealTimer: 0,
    revealBase: 0,
    drawRound: 0,
    shownRound: 0,
    resultDraw: null,
    solved: false,
    loadingTicket: false,
  };

  const clock = (ms) => {
    const total = Math.max(0, Math.ceil(Number(ms) / 1000));
    return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
  };

  const fmt = (n) => Math.max(0, Math.round(Number(n) || 0)).toLocaleString('en-US');
  const mult = (n) => (Number(n) >= 10 ? fmt(n) : String(Number(n).toFixed(2)).replace(/\.?0+$/, ''));

  /* ------------------------------- identity ------------------------------- */

  function devIdentity() {
    let devId = '';
    try {
      devId = localStorage.getItem('tb_dev_id') || '';
      if (!devId) {
        devId = Math.random().toString(36).slice(2, 10);
        localStorage.setItem('tb_dev_id', devId);
      }
    } catch (err) {
      devId = 'local';
    }

    // Browser play: ?name= wins, then the Telegram profile, then a generic name.
    let name = (params.get('name') || '').trim();
    if (!name && tg && tg.initDataUnsafe && tg.initDataUnsafe.user) {
      const u = tg.initDataUnsafe.user;
      name =
        [u.first_name, u.last_name].filter(Boolean).join(' ').trim() ||
        String(u.username || '').trim();
    }
    if (!name) name = 'Local Player';

    return { devId, name };
  }

  async function api(path, body) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (K.token) headers.Authorization = 'Bearer ' + K.token;
    const res = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = {};
    try {
      data = await res.json();
    } catch (err) {
      /* empty body */
    }
    if (!res.ok) {
      let text = data.error || 'Request failed (' + res.status + ')';
      if (data.code) {
        const translated = t('err.' + data.code);
        if (translated && translated !== 'err.' + data.code) text = translated;
      }
      const error = new Error(text);
      error.status = res.status;
      error.code = data.code;
      throw error;
    }
    return data;
  }

  async function signIn() {
    const identity = devIdentity();
    const payload = {
      initData: (tg && tg.initData) || '',
      devId: identity.devId,
      devName: identity.name,
    };
    if (devMode) payload.devBypass = true;
    try {
      const data = await api('/api/auth/telegram', payload);
      K.token = data.token;
      K.me = data.user;
      paintWallet();
    } catch (err) {
      K.token = '';
      K.me = null;
      msg(err.message, 'bad');
      paintWallet();
    }
  }

  /* -------------------------------- wallet -------------------------------- */

  function paintWallet() {
    $('walletAmount').textContent = fmt(K.me ? K.me.balance : 0);
    $('walletChip').href = devMode ? '/?wallet=1&dev=1' : '/?wallet=1';
  }

  async function refreshMe() {
    if (!K.token) return;
    try {
      const data = await api('/api/me');
      K.me = data.user;
      paintWallet();
    } catch (err) {
      /* keep the last known balance */
    }
  }

  /* --------------------------------- grid --------------------------------- */

  function buildGrid() {
    const grid = $('grid');
    const cells = [];
    for (let n = 1; n <= 80; n++) {
      cells.push(`<button class="cell" type="button" role="gridcell" data-n="${n}">${n}</button>`);
    }
    grid.innerHTML = cells.join('');
    grid.addEventListener('click', function (event) {
      const cell = event.target.closest('.cell');
      if (!cell) return;
      togglePick(Number(cell.dataset.n));
    });
  }

  function bounds() {
    if (K.mode === 'hitall') return { min: 2, max: Math.min(7, K.config.maxPicks) };
    if (K.mode === 'against') return { min: 8, max: K.config.maxPicks };
    if (K.mode === 'halves') return { min: 0, max: 0 };
    return { min: 1, max: K.config.maxPicks };
  }

  function togglePick(n) {
    if (K.busy || K.mode === 'halves') return;
    if (K.round && K.round.phase === 'drawing') return;
    if (K.picks.has(n)) {
      K.picks.delete(n);
    } else {
      if (K.picks.size >= bounds().max) {
        msg(t('keno.maxPicks', { max: bounds().max }), 'bad');
        return;
      }
      K.picks.add(n);
    }
    K.drawn = [];
    paintCells();
    paintPicks();
    msg('');
  }

  function paintCells() {
    const cells = $('grid').children;
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      const n = Number(cell.dataset.n);
      const picked = K.picks.has(n);
      const drawn = K.drawn.includes(n);
      cell.classList.toggle('picked', picked);
      cell.classList.toggle('drawn', drawn && !picked);
      cell.classList.toggle('hit', picked && drawn);
      cell.classList.toggle('miss', picked && K.drawn.length > 0 && !drawn);
    }
  }

  function paintPicks() {
    const b = bounds();
    $('pickCount').textContent =
      K.mode === 'halves' ? t('keno.halvesTag') : t('keno.pickCount', { n: K.picks.size, max: b.max });
    $('grid').hidden = K.mode === 'halves';
    $('halves').hidden = K.mode !== 'halves';
    paintModes();
    paintPaytable();
  }

  function paintModes() {
    const labels = {
      straight: 'keno.modeStraight',
      hitall: 'keno.modeHitAll',
      against: 'keno.modeAgainst',
      halves: 'keno.modeHalves',
    };
    Array.prototype.forEach.call($('modes').querySelectorAll('.mode-btn'), function (btn) {
      btn.classList.toggle('active', btn.dataset.mode === K.mode);
      btn.textContent = t(labels[btn.dataset.mode]);
      // Bet Against needs at least 8 picks; hide it when the admin lowers the limit.
      if (btn.dataset.mode === 'against') btn.disabled = K.config.maxPicks < 8;
    });
    Array.prototype.forEach.call($('halfChoices').querySelectorAll('button'), function (btn) {
      btn.classList.toggle('active', btn.dataset.side === K.side);
    });
    const hints = {
      straight: 'keno.hintStraight',
      hitall: 'keno.hintHitAll',
      against: 'keno.hintAgainst',
      halves: 'keno.hintHalves',
    };
    $('modeHint').textContent = t(hints[K.mode]);
  }

  function paintPaytable() {
    const list = $('paytable');
    $('payTag').textContent = '';

    if (K.mode === 'halves') {
      $('payTag').textContent = t('keno.halvesTag');
      list.innerHTML = ['top', 'even', 'bottom']
        .map(
          (side) =>
            `<li class="${side === K.side ? 'sel' : ''}"><span>${t('keno.' + side)}</span><b>${mult(
              K.modes.halves[side] || 0
            )}x</b></li>`
        )
        .join('');
      return;
    }

    if (K.mode === 'hitall') {
      const m = K.modes.hitall[K.picks.size];
      $('payTag').textContent = t('keno.picksTag', { n: K.picks.size });
      list.innerHTML =
        K.picks.size >= 2 && m
          ? `<li><span>${t('keno.allHit', { n: K.picks.size })}</span><b>${mult(m)}x</b></li>`
          : `<li class="empty">${t('keno.payEmpty')}</li>`;
      return;
    }

    if (K.mode === 'against') {
      const m = K.modes.against[K.picks.size];
      $('payTag').textContent = t('keno.picksTag', { n: K.picks.size });
      list.innerHTML =
        K.picks.size >= 8 && m
          ? `<li><span>${t('keno.noneHit', { n: K.picks.size })}</span><b>${mult(m)}x</b></li>`
          : `<li class="empty">${t('keno.payEmpty')}</li>`;
      return;
    }

    const table = K.modes.straight[String(K.picks.size)] || K.modes.straight[K.picks.size];
    $('payTag').textContent = K.picks.size ? t('keno.picksTag', { n: K.picks.size }) : '';
    if (!table) {
      list.innerHTML = `<li class="empty">${t('keno.payEmpty')}</li>`;
      return;
    }
    list.innerHTML = Object.keys(table)
      .map(Number)
      .sort((a, b) => a - b)
      .map(
        (hits) =>
          `<li><span>${t('keno.match', { n: hits })}</span><b>${mult(table[hits])}x</b></li>`
      )
      .join('');
  }

  /* -------------------------------- controls ------------------------------- */

  function paintControls() {
    $('limits').textContent = t('keno.limits', {
      min: fmt(K.config.minBet),
      max: fmt(K.config.maxBet),
    });
    const placed = !!(K.ticket && K.round && K.ticket.roundNo === K.round.no);
    const drawing = !!(K.round && K.round.phase === 'drawing');
    $('drawBtn').textContent = placed ? t('keno.ticketPlaced') : t('keno.placeBet');
    $('drawBtn').classList.toggle('placed', placed);
    $('drawBtn').disabled = K.busy || drawing || placed;
    $('quickPick').textContent = t('keno.quickPick');
    $('clearPicks').textContent = t('keno.clear');

    const quick = $('quick');
    const values = Array.from(new Set([K.config.minBet, 50, 100, K.config.maxBet]))
      .filter((v) => v >= K.config.minBet && v <= K.config.maxBet)
      .sort((a, b) => a - b);
    quick.innerHTML = values
      .map(
        (v) =>
          `<button type="button" data-amount="${v}" class="${Number(K.amount) === v ? 'active' : ''}">${fmt(v)}</button>`
      )
      .join('');
  }

  function msg(text, kind) {
    const box = $('result');
    box.textContent = text || '';
    if (kind) box.setAttribute('data-kind', kind);
    else box.removeAttribute('data-kind');
  }

  /* --------------------------------- state --------------------------------- */

  async function refreshState() {
    try {
      const state = await api('/api/keno/state');
      K.config = state.config;
      K.modes = state.modes;
      K.betMs = (state.limits && state.limits.betMs) || K.betMs;
      if (K.mode === 'against' && K.config.maxPicks < 8) K.mode = 'straight';
      if (K.picks.size > K.config.maxPicks) {
        K.picks = new Set(Array.from(K.picks).slice(0, K.config.maxPicks));
      }
      if (Number(K.amount) < K.config.minBet || Number(K.amount) > K.config.maxBet) {
        K.amount = K.config.minBet;
        $('amount').value = String(K.amount);
      }
      applyRound(state.round, state.drawn);
      paintControls();
      paintPicks();
    } catch (err) {
      /* the draw endpoint reports its own errors */
    }
  }

  /* --------------------------------- blower -------------------------------- */

  const SPHERE_BALLS = 26;

  function sphereNumbers() {
    const taken = new Set();
    while (taken.size < SPHERE_BALLS) taken.add(1 + Math.floor(Math.random() * 80));
    return Array.from(taken);
  }

  // Fill the glass sphere with numbered balls spread evenly around its centre.
  function buildSphere() {
    const field = $('ballField');
    if (!field) return;
    field.innerHTML = '';
    sphereNumbers().forEach(function (n) {
      const ball = document.createElement('span');
      ball.className = 'mini-ball';
      const radius = 72 * Math.sqrt(Math.random());
      const angle = Math.random() * Math.PI * 2;
      ball.style.setProperty('--x', (Math.cos(angle) * radius).toFixed(1) + 'px');
      ball.style.setProperty('--y', (Math.sin(angle) * radius).toFixed(1) + 'px');
      ball.style.setProperty('--dur', (2.2 + Math.random() * 2.2).toFixed(2) + 's');
      ball.style.setProperty('--delay', (-Math.random() * 3).toFixed(2) + 's');
      ball.textContent = String(n);
      field.appendChild(ball);
    });
  }

  function resetBlower() {
    const tray = $('tray');
    if (tray) tray.innerHTML = '';
    buildSphere();
  }

  // A ball leaves the sphere and lands in the tray under it.
  function releaseBall(n) {
    const field = $('ballField');
    if (field && field.children.length) {
      const shown = new Set();
      Array.prototype.forEach.call(field.children, function (ball) {
        shown.add(Number(ball.textContent));
      });
      let next = 1 + Math.floor(Math.random() * 80);
      for (let i = 0; i < 80 && (shown.has(next) || K.drawn.indexOf(next) !== -1); i++) {
        next = 1 + Math.floor(Math.random() * 80);
      }
      const out = field.children[Math.floor(Math.random() * field.children.length)];
      out.textContent = String(next);
      out.style.setProperty('--dur', (2.2 + Math.random() * 2.2).toFixed(2) + 's');
    }
    const tray = $('tray');
    if (!tray) return;
    const ball = document.createElement('span');
    ball.className = 'drawn-ball';
    ball.textContent = String(n);
    tray.appendChild(ball);
  }

  /* --------------------------------- round -------------------------------- */

  function paintRound() {
    const round = K.round;
    if (!round) return;
    const now = Date.now() + K.offset;
    // The poll can trail the clock by a moment: a closed bet window is already drawing.
    const drawing = round.phase === 'drawing' || now >= round.betEndsAt;
    const left = Math.max(0, (drawing ? round.drawEndsAt : round.betEndsAt) - now);
    const span = drawing ? round.drawEndsAt - round.drawStartsAt : K.betMs;
    $('roundNo').textContent = t('keno.round', { no: round.no });
    $('roundState').textContent = drawing ? t('keno.drawingPhase') : t('keno.selectPhase');
    $('roundClock').textContent = clock(left);
    const bar = $('roundBar');
    bar.classList.toggle('drawing', drawing);
    bar.classList.toggle('closing', !drawing && left < 5000);
    $('roundFill').style.transform = 'scaleX(' + Math.max(0, Math.min(1, left / (span || 1))).toFixed(4) + ')';
  }

  function currentTicket() {
    if (K.ticket && K.round && K.ticket.roundNo === K.round.no) return K.ticket;
    if (K.last && K.round && K.last.roundNo === K.round.no) return K.last;
    return null;
  }

  function paintTicketLine() {
    const line = $('ticketInfo');
    const ticket = currentTicket();
    if (!ticket) {
      line.hidden = true;
      return;
    }
    line.hidden = false;
    const picks = ticket.picks || [];
    let text =
      ticket.mode === 'halves'
        ? t('keno.ticketLineHalves', { side: t('keno.' + (ticket.side || 'top')), amount: fmt(ticket.amount) })
        : t('keno.ticketLine', { picks: picks.length, amount: fmt(ticket.amount) });
    if (picks.length && K.round && K.round.phase === 'drawing') {
      const hits = picks.filter((n) => K.drawn.includes(n)).length;
      text += ' · ' + t('keno.ticketHits', { hits, picks: picks.length });
    }
    line.textContent = text;
  }

  function applyRound(round, drawn) {
    if (!round) return;
    const changed = !K.round || K.round.no !== round.no || K.round.phase !== round.phase;
    K.round = round;
    K.offset = round.serverNow - Date.now();
    const drawing = round.phase === 'drawing';
    document.querySelector('.app').classList.toggle('drawing', drawing);
    if (drawing) startDraw(round, drawn || []);
    else endDraw(round);
    if (changed) paintTicketLine();
    paintRound();
  }

  function startDraw(round, order) {
    if (K.drawRound === round.no && K.revealTimer) return;
    K.drawRound = round.no;
    K.order = order.slice();
    K.drawn = [];
    K.solved = false;
    resetBlower();
    $('blower').classList.add('drawing');
    $('drawCount').textContent = '';
    msg(''); // the previous round's result does not belong on this draw
    paintCells();
    paintTicketLine();
    K.revealBase = round.drawStartsAt - K.offset;
    if (K.revealTimer) clearInterval(K.revealTimer);
    K.revealTimer = setInterval(revealTick, 200);
    revealTick();
    const box = $('blower').getBoundingClientRect();
    if (box.top < 8 || box.bottom > window.innerHeight - 8) {
      $('blower').scrollIntoView({ block: 'center' });
    }
  }

  function revealTick() {
    if (!K.order) return;
    const elapsed = Date.now() - K.revealBase;
    const target = Math.max(0, Math.min(K.order.length, Math.floor(elapsed / 1500)));
    if (target > K.drawn.length) {
      while (K.drawn.length < target) {
        const n = K.order[K.drawn.length];
        K.drawn.push(n);
        releaseBall(n);
      }
      paintCells();
      paintTicketLine();
    }
    $('drawCount').textContent = K.drawn.length
      ? t('keno.drawProgress', { n: K.drawn.length, total: K.order.length })
      : '';
    if (K.drawn.length >= K.order.length && !K.solved) {
      K.solved = true;
      clearInterval(K.revealTimer);
      K.revealTimer = 0;
      $('blower').classList.remove('drawing');
      loadTicket();
    }
  }

  function endDraw(round) {
    if (K.revealTimer) {
      clearInterval(K.revealTimer);
      K.revealTimer = 0;
    }
    $('blower').classList.remove('drawing');
    K.order = null;
    // A new round brings a fresh board, so the previous draw's marks no longer apply.
    if (K.drawRound && K.drawRound !== round.no) {
      if (K.drawn.length) {
        K.drawn = [];
        paintCells();
      }
      resetBlower();
      // The draw is over: fetch the settled ticket once the result is available.
      if (K.shownRound !== K.drawRound) loadTicket();
    }
  }

  function resultMessage(r) {
    const m = mult(r.multiplier);
    if (r.mode === 'halves') {
      const vars = { top: r.topHits, bottom: r.bottomHits, amount: fmt(r.payout), mult: m };
      return r.payout ? t('keno.halvesWin', vars) : t('keno.halvesMiss', vars);
    }
    if (r.mode === 'hitall') {
      return r.payout
        ? t('keno.hitAllWin', { n: r.picks.length, amount: fmt(r.payout), mult: m })
        : t('keno.hitAllMiss', { hits: r.hits, n: r.picks.length });
    }
    if (r.mode === 'against') {
      return r.payout
        ? t('keno.againstWin', { n: r.picks.length, amount: fmt(r.payout), mult: m })
        : t('keno.againstMiss', { hits: r.hits });
    }
    return r.payout
      ? t('keno.hit', { n: r.hits, amount: fmt(r.payout), mult: m })
      : t('keno.miss', { n: r.hits });
  }

  async function loadTicket() {
    if (!K.token || K.loadingTicket) return;
    K.loadingTicket = true;
    try {
      const data = await api('/api/keno/ticket');
      K.ticket = data.current;
      K.last = data.last;
      paintTicketLine();
      paintControls();
      const last = K.last;
      if (last && K.drawRound && last.roundNo === K.drawRound && K.shownRound !== last.roundNo) {
        K.shownRound = last.roundNo;
        K.resultDraw = last;
        msg(resultMessage(last), last.payout ? 'ok' : 'bad');
        if (last.payout > 0 && tg && tg.HapticFeedback) {
          try { tg.HapticFeedback.notificationOccurred('success'); } catch (err) { /* no haptics */ }
        }
        refreshMe();
      }
    } catch (err) {
      /* keep the last known ticket */
    } finally {
      K.loadingTicket = false;
    }
  }

  async function placeBet() {
    if (K.busy) return;
    if (K.round && K.round.phase !== 'betting') return msg(t('keno.bettingClosed'), 'bad');
    if (K.ticket && K.round && K.ticket.roundNo === K.round.no) return;

    const b = bounds();
    if (K.mode !== 'halves') {
      if (!K.picks.size) return msg(t('keno.needPicks'), 'bad');
      if (K.picks.size < b.min) return msg(t('keno.needMore', { n: b.min }), 'bad');
    }

    const stake = Math.round(Number($('amount').value) || 0);
    if (!stake || stake <= 0) return msg(t('err.positive_amount'), 'bad');
    K.amount = stake;

    if (!K.token) await signIn();
    if (!K.token) return;

    K.busy = true;
    msg('');
    $('drawBtn').disabled = true;

    try {
      const data = await api('/api/keno/draw', {
        amount: stake,
        mode: K.mode,
        picks: K.mode === 'halves' ? [] : Array.from(K.picks),
        side: K.side,
      });

      K.ticket = data.ticket;
      if (data.round) {
        K.round = data.round;
        K.offset = data.round.serverNow - Date.now();
      }
      if (K.me) K.me.balance = data.balance;
      paintWallet();
      paintRound();
      paintTicketLine();
      paintControls();
      msg(t('keno.ticketPlacedMsg', { time: clock(data.round.betEndsAt - data.round.serverNow) }), 'ok');
      await refreshState();
    } catch (err) {
      msg(err.message, 'bad');
      if (err.code === 'insufficient_funds') refreshMe();
      if (err.code === 'ticket_exists') loadTicket();
    } finally {
      K.busy = false;
      paintControls();
    }
  }

  /* --------------------------------- events -------------------------------- */

  $('modes').addEventListener('click', function (event) {
    const btn = event.target.closest('.mode-btn');
    if (!btn || btn.disabled || K.busy || btn.dataset.mode === K.mode) return;
    if (K.round && K.round.phase === 'drawing') return;
    K.mode = btn.dataset.mode;
    K.picks.clear();
    K.drawn = [];
    paintCells();
    paintPicks();
    msg('');
  });

  $('halfChoices').addEventListener('click', function (event) {
    const btn = event.target.closest('button[data-side]');
    if (!btn || K.busy) return;
    if (K.round && K.round.phase === 'drawing') return;
    K.side = btn.dataset.side;
    paintPicks();
    msg('');
  });

  $('quickPick').addEventListener('click', function () {
    if (K.busy || K.mode === 'halves') return;
    if (K.round && K.round.phase === 'drawing') return;
    const b = bounds();
    const count = K.mode === 'hitall' ? Math.min(5, b.max) : K.mode === 'against' ? Math.max(8, b.min) : K.config.maxPicks;
    const pool = [];
    for (let n = 1; n <= 80; n++) pool.push(n);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    K.picks = new Set(pool.slice(0, Math.min(count, b.max)));
    K.drawn = [];
    resetBlower();
    paintCells();
    paintPicks();
    msg('');
  });

  $('clearPicks').addEventListener('click', function () {
    if (K.busy) return;
    if (K.round && K.round.phase === 'drawing') return;
    K.picks.clear();
    K.drawn = [];
    paintCells();
    paintPicks();
    msg('');
  });

  $('amount').addEventListener('input', function (event) {
    K.amount = Math.round(Number(event.target.value) || 0);
    paintControls();
  });

  $('quick').addEventListener('click', function (event) {
    const btn = event.target.closest('button[data-amount]');
    if (!btn) return;
    K.amount = Number(btn.getAttribute('data-amount'));
    $('amount').value = String(K.amount);
    paintControls();
  });

  $('drawBtn').addEventListener('click', placeBet);

  if (window.I18n) {
    window.I18n.onChange(function () {
      paintControls();
      paintPicks();
      refreshState();
      // Keep the settle message in the language the player just switched to.
      if (K.resultDraw && $('result').textContent) {
        msg(resultMessage(K.resultDraw), K.resultDraw.payout ? 'ok' : 'bad');
      }
    });
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) {
      refreshState();
      loadTicket();
      refreshMe();
    }
  });

  /* --------------------------------- boot --------------------------------- */

  (async function boot() {
    buildGrid();
    buildSphere();
    await signIn();
    await refreshState();
    await loadTicket();
    K.amount = Math.max(
      K.config.minBet,
      Math.min(K.config.maxBet, K.me && K.me.balance ? Math.min(50, K.me.balance) : K.config.minBet)
    );
    $('amount').value = String(K.amount);
    paintControls();
    paintPicks();
    setInterval(refreshState, 2000);
    setInterval(paintRound, 250);
    setInterval(loadTicket, 5000);
    setInterval(refreshMe, 20000);
  })();
})();
