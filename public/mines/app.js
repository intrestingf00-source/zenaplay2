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
    config: { minBet: 10, maxBet: 500, defaultMines: 3, houseEdge: 3, maxMultiplier: 1000 },
    limits: { tiles: 25, cols: 5, minMines: 1, maxMines: 24 },
    paused: false,
    mines: 3,
    amount: 10,
    quote: null,
    round: null,
    result: null,
    busy: false,
  };

  const fmt = (n) => Math.max(0, Math.round(Number(n) || 0)).toLocaleString('en-US');
  const mult = (n) => {
    const value = Number(n) || 0;
    return value >= 100 ? fmt(value) : String(value.toFixed(2));
  };
  const shortHash = (value) => (value ? String(value).slice(0, 10) + '…' + String(value).slice(-6) : '');

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
      paintWallet();
      if (devMode) setResult('mines.signInFailed', {}, 'bad');
    }
  }

  /* -------------------------------- wallet -------------------------------- */

  function paintWallet() {
    $('walletAmount').textContent = fmt(K.me ? K.me.balance : 0);
    $('walletChip').href = devMode ? '/?wallet=1&dev=1' : '/?wallet=1';
  }

  function applyBalance(balance) {
    if (balance == null) return;
    if (!K.me) K.me = { balance: 0 };
    K.me.balance = balance;
    paintWallet();
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
    const cells = [];
    for (let i = 0; i < 25; i++) {
      cells.push(
        `<button class="tile" type="button" role="gridcell" data-i="${i}" aria-label="${t('mines.tile', {
          n: i + 1,
        })}"><span class="mark" aria-hidden="true"></span></button>`
      );
    }
    $('grid').innerHTML = cells.join('');
  }

  function roundStatus() {
    return K.round ? K.round.status : '';
  }

  function paintGrid() {
    const round = K.round;
    const live = roundStatus() === 'live';
    const ended = !!round && !live;
    const revealed = round ? round.revealed : [];
    const layout = round && ended ? round.layout : [];

    Array.prototype.forEach.call($('grid').children, function (tile, index) {
      const safe = revealed.indexOf(index) !== -1;
      const bomb = layout.indexOf(index) !== -1;
      tile.classList.toggle('safe', safe);
      tile.classList.toggle('bomb', bomb);
      tile.querySelector('.mark').textContent = safe ? '💎' : bomb ? '💣' : '';
      tile.disabled = K.busy || !live || safe;
    });
  }

  /* ---------------------------------- hud --------------------------------- */

  function paintHud() {
    const round = K.round;
    const live = roundStatus() === 'live';

    let multiplier = 1;
    if (live) multiplier = round.multiplier;
    else if (round) multiplier = round.status === 'lost' ? 0 : round.multiplier;
    $('multValue').innerHTML = mult(multiplier) + '<span>x</span>';

    let next = null;
    if (live) next = round.nextMultiplier;
    else if (!round && K.quote && K.quote.table) next = K.quote.table[1];
    $('nextValue').textContent = next ? mult(next) + 'x' : '—';

    let cash = null;
    if (live && round.revealed.length) cash = Math.floor(round.amount * round.multiplier);
    else if (round && round.payout) cash = round.payout;
    $('cashValue').textContent = cash == null ? '—' : fmt(cash);

    $('bombTag').textContent = String(round ? round.mines : K.mines);
  }

  function paintState() {
    const status = roundStatus();
    const key =
      status === 'live'
        ? 'mines.live'
        : status === 'lost'
          ? 'mines.bust'
          : status === 'cashed'
            ? 'mines.cashed'
            : status === 'won'
              ? 'mines.cleared'
              : K.paused
                ? 'mines.paused'
                : 'mines.ready';
    $('stateTag').textContent = t(key);
    $('board').dataset.status = status || (K.paused ? 'paused' : 'idle');
  }

  function paintActions() {
    const live = roundStatus() === 'live';
    const ended = !!K.round && !live;
    const btn = $('actionBtn');

    btn.classList.toggle('cash', live && K.round.revealed.length > 0);
    btn.classList.toggle('again', ended);
    btn.disabled = K.busy || (!live && K.paused) || (live && K.round.revealed.length === 0);

    if (live) {
      btn.textContent = K.round.revealed.length
        ? t('mines.cashout', { amount: fmt(Math.floor(K.round.amount * K.round.multiplier)) })
        : t('mines.pickTile');
    } else if (ended) {
      const secs = autoRemaining();
      btn.textContent = secs ? t('mines.nextRoundIn', { n: secs }) : t('mines.newRound');
    } else {
      btn.textContent = K.paused ? t('mines.paused') : t('mines.placeBet');
    }

    const pending = autoDeadline ? Math.max(0, Math.min(1, (autoDeadline - Date.now()) / AUTO_DELAY_MS)) : 0;
    btn.dataset.auto = autoDeadline ? '1' : '0';
    btn.style.setProperty('--auto', pending.toFixed(3));

    const locked = live || K.busy;
    $('minesRange').disabled = locked;
    $('amount').disabled = locked;
    paintQuick();
  }

  function paintFair() {
    const line = $('fairness');
    if (!K.round) {
      line.hidden = true;
      line.textContent = '';
      line.title = '';
      return;
    }
    line.hidden = false;
    if (K.round.status === 'live') {
      line.textContent = t('mines.hashLabel') + ' ' + shortHash(K.round.seedHash);
      line.title = K.round.seedHash;
    } else {
      line.textContent = t('mines.seedLabel') + ' ' + shortHash(K.round.seed);
      line.title = K.round.seed;
    }
  }

  function paintLimits() {
    const edge = Number(K.config.houseEdge) || 0;
    const rtp = Math.round((100 - edge) * 10) / 10;
    $('limits').textContent =
      t('mines.limits', { min: fmt(K.config.minBet), max: fmt(K.config.maxBet) }) +
      ' · ' +
      t('mines.rtp', { rtp });
  }

  function paintQuick() {
    Array.prototype.forEach.call($('quick').children, function (btn) {
      btn.classList.toggle('active', Number(btn.dataset.amount) === Number($('amount').value));
      btn.disabled = roundStatus() === 'live' || K.busy;
    });
  }

  function paintAll() {
    paintGrid();
    paintHud();
    paintActions();
    paintFair();
    paintState();
  }

  function msg(text, kind) {
    const box = $('result');
    box.textContent = text || '';
    if (kind) box.setAttribute('data-kind', kind);
    else box.removeAttribute('data-kind');
  }

  function setResult(key, vars, kind) {
    K.result = key ? { key, vars: vars || {}, kind } : null;
    msg(key ? t(key, vars || {}) : '', kind);
  }

  function repaintResult() {
    if (K.result) msg(t(K.result.key, K.result.vars), K.result.kind);
  }

  function haptic(kind) {
    if (!tg || !tg.HapticFeedback) return;
    try {
      if (kind === 'success') tg.HapticFeedback.notificationOccurred('success');
      else if (kind === 'error') tg.HapticFeedback.notificationOccurred('error');
      else tg.HapticFeedback.impactOccurred('light');
    } catch (err) {
      /* no haptics */
    }
  }

  /* --------------------------------- round -------------------------------- */

  function applyRound(round) {
    K.round = round;
    if (!round) {
      cancelAuto();
      paintAll();
      return;
    }
    // A finished round rolls straight into the next one on its own.
    if (round.status !== 'live') scheduleAuto();
    else cancelAuto();
    K.mines = round.mines;
    K.amount = round.amount;
    $('minesRange').value = String(round.mines);
    $('minesValue').textContent = String(round.mines);
    $('amount').value = String(round.amount);
    paintAll();
    if (round.status === 'live' && round.id !== K.dealtId) {
      K.dealtId = round.id;
      dealGrid();
    }
  }

  let dealTimer = 0;
  function dealGrid() {
    const grid = $('grid');
    grid.classList.remove('deal');
    void grid.offsetWidth;
    grid.classList.add('deal');
    clearTimeout(dealTimer);
    dealTimer = setTimeout(function () {
      grid.classList.remove('deal');
    }, 620);
  }

  async function refreshState() {
    try {
      const state = await api('/api/mines/state');
      K.config = state.config;
      K.limits = state.limits;
      K.paused = !!state.paused;

      if (!K.round) {
        if (K.mines < K.limits.minMines || K.mines > K.limits.maxMines) {
          K.mines = K.config.defaultMines;
        }
        const stake = Number($('amount').value) || 0;
        if (stake < K.config.minBet || stake > K.config.maxBet) {
          K.amount = K.config.minBet;
          $('amount').value = String(K.amount);
        }
        $('minesRange').min = String(K.limits.minMines);
        $('minesRange').max = String(K.limits.maxMines);
        $('minesRange').value = String(K.mines);
        $('minesValue').textContent = String(K.mines);
      }

      paintLimits();
      paintAll();
    } catch (err) {
      /* the action endpoints report their own errors */
    }
  }

  async function syncRound() {
    if (!K.token) return;
    try {
      const data = await api('/api/mines/round');
      if (data.round) {
        if (K.round && data.round.id === K.round.id && data.round.status === K.round.status) {
          // Same open round: refresh the tiles only, keep any result message.
          K.round = data.round;
          paintAll();
        } else {
          applyRound(data.round);
        }
        return;
      }
      if (K.round && K.round.status === 'live') {
        applyRound(null);
        setResult('mines.roundClosed', {}, 'bad');
        refreshMe();
      }
    } catch (err) {
      /* ignore a dropped poll */
    }
  }

  /* ------------------------------ auto rounds ------------------------------ */

  const AUTO_DELAY_MS = 3000;
  let autoTimer = 0;
  let autoTick = 0;
  let autoDeadline = 0;

  function autoRemaining() {
    if (!autoDeadline) return 0;
    return Math.max(0, Math.ceil((autoDeadline - Date.now()) / 1000));
  }

  function cancelAuto() {
    if (autoTimer) clearTimeout(autoTimer);
    if (autoTick) clearInterval(autoTick);
    autoTimer = 0;
    autoTick = 0;
    autoDeadline = 0;
  }

  function scheduleAuto() {
    cancelAuto();
    if ((K.round && K.round.status === 'live') || K.paused) {
      paintActions();
      return;
    }
    autoDeadline = Date.now() + AUTO_DELAY_MS;
    autoTick = setInterval(paintActions, 250);
    autoTimer = setTimeout(function () {
      cancelAuto();
      if (K.busy || K.paused || roundStatus() === 'live' || !K.round) {
        paintActions();
        return;
      }
      startRound({ auto: true });
    }, AUTO_DELAY_MS);
    paintActions();
  }

  /* -------------------------------- actions ------------------------------- */

  let quoteTimer = 0;
  function loadQuote() {
    clearTimeout(quoteTimer);
    quoteTimer = setTimeout(async function () {
      try {
        K.quote = await api('/api/mines/quote?mines=' + K.mines);
        paintHud();
      } catch (err) {
        /* keep the last quote */
      }
    }, 90);
  }

  async function startRound(opts) {
    cancelAuto();
    if (K.busy || roundStatus() === 'live') return;
    const stake = Math.round(Number($('amount').value) || 0);
    if (!stake) {
      setResult('err.positive_amount', {}, 'bad');
      return;
    }
    if (!K.token) await signIn();
    if (!K.token) return;

    K.busy = true;
    paintAll();
    try {
      const data = await api('/api/mines/start', { amount: stake, mines: K.mines });
      applyBalance(data.balance);
      if (opts && opts.auto) setResult(null);
      else setResult('mines.started', {}, 'ok');
      applyRound(data.round);
      haptic('light');
    } catch (err) {
      setResult(null);
      msg(err.message, 'bad');
      if (err.code === 'insufficient_funds') refreshMe();
      if (err.code === 'round_active') syncRound();
    } finally {
      K.busy = false;
      paintAll();
    }
  }

  async function reveal(index) {
    if (K.busy || roundStatus() !== 'live') return;
    if (K.round.revealed.indexOf(index) !== -1) return;

    K.busy = true;
    paintAll();
    try {
      const data = await api('/api/mines/reveal', { index });
      applyBalance(data.balance);
      setResult(null);
      applyRound(data.round);
      const round = data.round;
      if (round.status === 'lost') {
        haptic('error');
        setResult('mines.lost', { n: round.revealed.length }, 'bad');
      } else if (round.status === 'won') {
        haptic('success');
        setResult('mines.won', { amount: fmt(round.payout), mult: mult(round.multiplier) }, 'ok');
      } else {
        haptic('light');
      }
    } catch (err) {
      msg(err.message, 'bad');
      if (err.code === 'no_round') syncRound();
      if (err.code === 'tile_open') paintAll();
    } finally {
      K.busy = false;
      paintAll();
    }
  }

  async function cashout() {
    if (K.busy || roundStatus() !== 'live' || !K.round.revealed.length) return;

    K.busy = true;
    paintAll();
    try {
      const data = await api('/api/mines/cashout', {});
      applyBalance(data.balance);
      setResult(null);
      applyRound(data.round);
      haptic('success');
      setResult(
        'mines.win',
        { amount: fmt(data.round.payout), mult: mult(data.round.multiplier) },
        'ok'
      );
    } catch (err) {
      msg(err.message, 'bad');
      if (err.code === 'no_round') syncRound();
    } finally {
      K.busy = false;
      paintAll();
    }
  }

  /* -------------------------------- controls ------------------------------- */

  function buildQuick() {
    const values = Array.from(new Set([K.config.minBet, 50, 100, K.config.maxBet]))
      .filter((v) => v >= K.config.minBet && v <= K.config.maxBet)
      .sort((a, b) => a - b);
    $('quick').innerHTML = values
      .map((v) => `<button type="button" data-amount="${v}">${fmt(v)}</button>`)
      .join('');
    paintQuick();
  }

  $('grid').addEventListener('click', function (event) {
    const tile = event.target.closest('.tile');
    if (!tile || tile.disabled) return;
    reveal(Number(tile.dataset.i));
  });

  $('minesRange').addEventListener('input', function (event) {
    K.mines = Math.round(Number(event.target.value) || K.config.defaultMines);
    $('minesValue').textContent = String(K.mines);
    $('bombTag').textContent = String(K.mines);
    loadQuote();
  });

  $('amount').addEventListener('input', function (event) {
    K.amount = Math.round(Number(event.target.value) || 0);
    paintQuick();
  });

  $('quick').addEventListener('click', function (event) {
    const btn = event.target.closest('button[data-amount]');
    if (!btn || btn.disabled) return;
    K.amount = Number(btn.dataset.amount);
    $('amount').value = String(K.amount);
    paintQuick();
  });

  $('actionBtn').addEventListener('click', function () {
    if (roundStatus() === 'live') {
      if (K.round.revealed.length) cashout();
      return;
    }
    startRound();
  });

  if (window.I18n) {
    window.I18n.onChange(function () {
      buildGrid();
      paintAll();
      paintLimits();
      repaintResult();
    });
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    refreshState();
    syncRound();
    refreshMe();
  });

  /* --------------------------------- boot --------------------------------- */

  (async function boot() {
    buildGrid();
    paintAll();

    await signIn();
    await refreshState();

    K.mines = Math.min(K.limits.maxMines, Math.max(K.limits.minMines, K.config.defaultMines));
    $('minesRange').value = String(K.mines);
    $('minesValue').textContent = String(K.mines);

    const balance = K.me && K.me.balance ? K.me.balance : K.config.minBet;
    K.amount = Math.max(K.config.minBet, Math.min(K.config.maxBet, Math.min(50, balance)));
    $('amount').value = String(K.amount);

    buildQuick();
    loadQuote();
    await syncRound();
    paintAll();

    setInterval(refreshState, 15000);
    setInterval(function () {
      if (roundStatus() === 'live') syncRound();
    }, 8000);
    setInterval(refreshMe, 20000);
  })();
})();
