'use strict';

/**
 * Storage layer. Uses MongoDB (Mongoose) when MONGODB_URI is set, otherwise an
 * in-memory store so the game can be run/tested locally without a database.
 * Both implementations expose the same small API and return plain objects
 * with an `id` field.
 */

const mongoose = require('mongoose');

const DEFAULT_CONFIG = {
  entryFee: 50,
  startSeconds: 30,
  resetSeconds: 15,
  houseCut: 10,
        startingBalance: 0,
  autoStart: true,
  paused: false,
  minDepositGapMs: 700,
};

const CRASH_DEFAULT_CONFIG = {
  minBet: 10,
  maxBet: 500,
  betSeconds: 7,
  houseEdge: 5,
  growth: 0.09,
  maxMultiplier: 300,
  paused: false,
};

const KENO_DEFAULT_CONFIG = {
  minBet: 10,
  maxBet: 500,
  maxPicks: 10,
  paused: false,
};

const MINES_DEFAULT_CONFIG = {
  minBet: 10,
  maxBet: 500,
  defaultMines: 3,
  houseEdge: 3,
  maxMultiplier: 1000,
  paused: false,
};

let mode = 'memory';
const mem = {
  users: [],
  rounds: [],
  payments: [],
  crashRounds: [],
  kenoDraws: [],
  minesRounds: [],
  config: { ...DEFAULT_CONFIG },
  crashConfig: { ...CRASH_DEFAULT_CONFIG },
  kenoConfig: { ...KENO_DEFAULT_CONFIG },
  minesConfig: { ...MINES_DEFAULT_CONFIG },
};
let seq = { user: 0, round: 0, payment: 0, crash: 0, keno: 0, mines: 0 };

const clone = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));

/* ------------------------------------------------------------------ */
/* Mongoose schemas                                                    */
/* ------------------------------------------------------------------ */

const UserSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    username: { type: String, required: true },
    telegramId: { type: String, default: '', index: true },
    photoUrl: { type: String, default: '' },
    balance: { type: Number, default: 0, min: 0 },
    depositCount: { type: Number, default: 0 },
    depositTotal: { type: Number, default: 0 },
    wins: { type: Number, default: 0 },
    winnings: { type: Number, default: 0 },
    banned: { type: Boolean, default: false },
  },
  { timestamps: true }
);

const DepositSchema = new mongoose.Schema(
  {
    userId: { type: String, default: '' },
    username: String,
    amount: Number,
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const PaymentSchema = new mongoose.Schema(
  {
    userId: { type: String, default: '', index: true },
    username: String,
    telegramId: { type: String, default: '' },
    type: { type: String, enum: ['deposit', 'withdraw'], default: 'deposit' },
    amount: Number,
    phone: { type: String, default: '' },
    text: { type: String, default: '' },
    status: { type: String, default: 'pending', index: true },
    decidedAt: Date,
  },
  { timestamps: true }
);

const CrashBetSchema = new mongoose.Schema(
  {
    userId: { type: String, default: '' },
    username: String,
    photoUrl: { type: String, default: '' },
    amount: Number,
    autoCashout: { type: Number, default: 0 },
    cashedAt: { type: Number, default: 0 },
    payout: { type: Number, default: 0 },
  },
  { _id: false }
);

const CrashRoundSchema = new mongoose.Schema(
  {
    no: { type: Number, required: true, index: true },
    seed: String,
    seedHash: String,
    crashAt: { type: Number, default: 1 },
    bets: { type: [CrashBetSchema], default: [] },
    totalBet: { type: Number, default: 0 },
    totalPayout: { type: Number, default: 0 },
    houseProfit: { type: Number, default: 0 },
    startedAt: Date,
    crashedAt: Date,
  },
  { timestamps: true }
);

const CrashConfigSchema = new mongoose.Schema({
  key: { type: String, default: 'main', unique: true },
  minBet: { type: Number, default: CRASH_DEFAULT_CONFIG.minBet },
  maxBet: { type: Number, default: CRASH_DEFAULT_CONFIG.maxBet },
  betSeconds: { type: Number, default: CRASH_DEFAULT_CONFIG.betSeconds },
  houseEdge: { type: Number, default: CRASH_DEFAULT_CONFIG.houseEdge },
  growth: { type: Number, default: CRASH_DEFAULT_CONFIG.growth },
  maxMultiplier: { type: Number, default: CRASH_DEFAULT_CONFIG.maxMultiplier },
  paused: { type: Boolean, default: false },
});

const KENO_MODES = ['straight', 'hitall', 'against', 'halves'];

const KenoDrawSchema = new mongoose.Schema(
  {
    no: { type: Number, required: true, index: true },
    roundNo: { type: Number, default: 0, index: true },
    status: { type: String, default: 'settled', index: true },
    userId: { type: String, default: '', index: true },
    username: { type: String, default: 'player' },
    amount: { type: Number, default: 0 },
    mode: { type: String, default: 'straight' },
    side: { type: String, default: '' },
    picks: { type: [Number], default: [] },
    drawn: { type: [Number], default: [] },
    hits: { type: Number, default: 0 },
    topHits: { type: Number, default: 0 },
    bottomHits: { type: Number, default: 0 },
    multiplier: { type: Number, default: 0 },
    payout: { type: Number, default: 0 },
    seed: { type: String, default: '' },
    seedHash: { type: String, default: '' },
  },
  { timestamps: true }
);

const KenoConfigSchema = new mongoose.Schema({
  key: { type: String, default: 'main', unique: true },
  minBet: { type: Number, default: KENO_DEFAULT_CONFIG.minBet },
  maxBet: { type: Number, default: KENO_DEFAULT_CONFIG.maxBet },
  maxPicks: { type: Number, default: KENO_DEFAULT_CONFIG.maxPicks },
  paused: { type: Boolean, default: false },
});

const MINES_STATUS = ['live', 'won', 'lost', 'cashed', 'void'];

const MinesRoundSchema = new mongoose.Schema(
  {
    no: { type: Number, required: true, index: true },
    userId: { type: String, default: '', index: true },
    username: { type: String, default: 'player' },
    amount: { type: Number, default: 0 },
    mines: { type: Number, default: 3 },
    layout: { type: [Number], default: [] },
    revealed: { type: [Number], default: [] },
    status: { type: String, default: 'live', index: true },
    multiplier: { type: Number, default: 1 },
    payout: { type: Number, default: 0 },
    seed: { type: String, default: '' },
    seedHash: { type: String, default: '' },
    startedAt: Date,
    endedAt: Date,
  },
  { timestamps: true }
);

const MinesConfigSchema = new mongoose.Schema({
  key: { type: String, default: 'main', unique: true },
  minBet: { type: Number, default: MINES_DEFAULT_CONFIG.minBet },
  maxBet: { type: Number, default: MINES_DEFAULT_CONFIG.maxBet },
  defaultMines: { type: Number, default: MINES_DEFAULT_CONFIG.defaultMines },
  houseEdge: { type: Number, default: MINES_DEFAULT_CONFIG.houseEdge },
  maxMultiplier: { type: Number, default: MINES_DEFAULT_CONFIG.maxMultiplier },
  paused: { type: Boolean, default: false },
});

const RoundSchema = new mongoose.Schema(
  {
    no: { type: Number, required: true, index: true },
    status: { type: String, default: 'live', index: true },
    entryFee: Number,
    resetSeconds: Number,
    startSeconds: Number,
    pot: { type: Number, default: 0 },
    deposits: { type: [DepositSchema], default: [] },
    depositorCount: { type: Number, default: 0 },
    lastDepositor: { type: DepositSchema, default: null },
    startedAt: Date,
    endsAt: Date,
    endedAt: Date,
    winnerId: String,
    winnerName: String,
    payout: Number,
    houseCut: Number,
    endedReason: String,
  },
  { timestamps: true }
);

const ConfigSchema = new mongoose.Schema({
  key: { type: String, default: 'main', unique: true },
  entryFee: { type: Number, default: DEFAULT_CONFIG.entryFee },
  startSeconds: { type: Number, default: DEFAULT_CONFIG.startSeconds },
  resetSeconds: { type: Number, default: DEFAULT_CONFIG.resetSeconds },
  houseCut: { type: Number, default: DEFAULT_CONFIG.houseCut },
  startingBalance: { type: Number, default: DEFAULT_CONFIG.startingBalance },
  autoStart: { type: Boolean, default: true },
  paused: { type: Boolean, default: false },
  minDepositGapMs: { type: Number, default: DEFAULT_CONFIG.minDepositGapMs },
});

let User;
let Round;
let Config;
let Payment;
let CrashRound;
let CrashConfig;
let KenoDraw;
let KenoConfig;
let MinesRound;
let MinesConfig;

/* ------------------------------------------------------------------ */
/* Shaping helpers                                                     */
/* ------------------------------------------------------------------ */

function shapeUser(doc) {
  if (!doc) return null;
  const u = clone(doc);
  return {
    id: String(u.id ?? u._id),
    username: u.username,
    telegramId: u.telegramId || '',
    photoUrl: u.photoUrl || '',
    balance: Math.round(u.balance || 0),
    depositCount: u.depositCount || 0,
    depositTotal: u.depositTotal || 0,
    wins: u.wins || 0,
    winnings: u.winnings || 0,
    banned: !!u.banned,
    createdAt: u.createdAt,
  };
}

function shapeRound(doc) {
  if (!doc) return null;
  const r = clone(doc);
  return {
    id: String(r.id ?? r._id),
    no: r.no,
    status: r.status,
    entryFee: r.entryFee,
    resetSeconds: r.resetSeconds,
    startSeconds: r.startSeconds,
    pot: Math.round(r.pot || 0),
    deposits: (r.deposits || []).map((d) => ({
      userId: String(d.userId || ''),
      username: d.username || 'player',
      amount: d.amount || 0,
      at: d.at,
    })),
    depositorCount: r.depositorCount || 0,
    lastDepositor: r.lastDepositor
      ? {
          userId: String(r.lastDepositor.userId || ''),
          username: r.lastDepositor.username || 'player',
          amount: r.lastDepositor.amount || 0,
          at: r.lastDepositor.at,
        }
      : null,
    startedAt: r.startedAt,
    endsAt: r.endsAt,
    endedAt: r.endedAt,
    winnerId: r.winnerId ? String(r.winnerId) : null,
    winnerName: r.winnerName || null,
    payout: r.payout || 0,
    houseCut: r.houseCut || 0,
    endedReason: r.endedReason || null,
  };
}

function shapeConfig(doc) {
  const c = clone(doc) || {};
  return {
    entryFee: Number(c.entryFee ?? DEFAULT_CONFIG.entryFee),
    startSeconds: Number(c.startSeconds ?? DEFAULT_CONFIG.startSeconds),
    resetSeconds: Number(c.resetSeconds ?? DEFAULT_CONFIG.resetSeconds),
    houseCut: Number(c.houseCut ?? DEFAULT_CONFIG.houseCut),
    startingBalance: Number(c.startingBalance ?? DEFAULT_CONFIG.startingBalance),
    autoStart: c.autoStart !== false,
    paused: !!c.paused,
    minDepositGapMs: Number(c.minDepositGapMs ?? DEFAULT_CONFIG.minDepositGapMs),
  };
}

function shapePayment(doc) {
  if (!doc) return null;
  const p = clone(doc);
  return {
    id: String(p.id ?? p._id),
    userId: String(p.userId || ''),
    username: p.username || 'player',
    telegramId: p.telegramId || '',
    type: p.type === 'withdraw' ? 'withdraw' : 'deposit',
    amount: Math.round(p.amount || 0),
    phone: p.phone || '',
    text: p.text || '',
    status: p.status || 'pending',
    createdAt: p.createdAt,
    decidedAt: p.decidedAt || null,
  };
}

function shapeCrashRound(doc) {
  if (!doc) return null;
  const r = clone(doc);
  return {
    id: String(r.id ?? r._id),
    no: r.no,
    seed: r.seed || '',
    seedHash: r.seedHash || '',
    crashAt: Number(r.crashAt) || 1,
    bets: (r.bets || []).map((b) => ({
      userId: String(b.userId || ''),
      username: b.username || 'player',
      photoUrl: b.photoUrl || '',
      amount: Math.round(b.amount || 0),
      autoCashout: Number(b.autoCashout) || 0,
      cashedAt: Number(b.cashedAt) || 0,
      payout: Math.round(b.payout || 0),
    })),
    totalBet: Math.round(r.totalBet || 0),
    totalPayout: Math.round(r.totalPayout || 0),
    houseProfit: Math.round(r.houseProfit || 0),
    startedAt: r.startedAt,
    crashedAt: r.crashedAt,
  };
}

function shapeCrashConfig(doc) {
  const c = clone(doc) || {};
  return {
    minBet: Number(c.minBet ?? CRASH_DEFAULT_CONFIG.minBet),
    maxBet: Number(c.maxBet ?? CRASH_DEFAULT_CONFIG.maxBet),
    betSeconds: Number(c.betSeconds ?? CRASH_DEFAULT_CONFIG.betSeconds),
    houseEdge: Number(c.houseEdge ?? CRASH_DEFAULT_CONFIG.houseEdge),
    growth: Number(c.growth ?? CRASH_DEFAULT_CONFIG.growth),
    maxMultiplier: Number(c.maxMultiplier ?? CRASH_DEFAULT_CONFIG.maxMultiplier),
    paused: !!c.paused,
  };
}

function shapeKenoDraw(doc) {
  if (!doc) return null;
  const d = clone(doc);
  return {
    id: String(d.id ?? d._id),
    no: d.no,
    roundNo: Number(d.roundNo || 0),
    status: d.status === 'pending' ? 'pending' : d.status === 'void' ? 'void' : 'settled',
    userId: String(d.userId || ''),
    username: d.username || 'player',
    amount: Math.round(d.amount || 0),
    mode: KENO_MODES.includes(d.mode) ? d.mode : 'straight',
    side: d.side === 'even' || d.side === 'bottom' || d.side === 'top' ? d.side : '',
    picks: (d.picks || []).map(Number),
    drawn: (d.drawn || []).map(Number),
    hits: Number(d.hits || 0),
    topHits: Number(d.topHits || 0),
    bottomHits: Number(d.bottomHits || 0),
    multiplier: Number(Number(d.multiplier || 0).toFixed(2)),
    payout: Math.round(d.payout || 0),
    seed: d.seed || '',
    seedHash: d.seedHash || '',
    createdAt: d.createdAt,
  };
}

function shapeKenoConfig(doc) {
  const c = clone(doc) || {};
  return {
    minBet: Number(c.minBet ?? KENO_DEFAULT_CONFIG.minBet),
    maxBet: Number(c.maxBet ?? KENO_DEFAULT_CONFIG.maxBet),
    maxPicks: Number(c.maxPicks ?? KENO_DEFAULT_CONFIG.maxPicks),
    paused: !!c.paused,
  };
}

function shapeMinesRound(doc) {
  if (!doc) return null;
  const r = clone(doc);
  return {
    id: String(r.id ?? r._id),
    no: Number(r.no || 0),
    userId: String(r.userId || ''),
    username: r.username || 'player',
    amount: Math.round(r.amount || 0),
    mines: Number(r.mines || 0),
    layout: (r.layout || []).map(Number),
    revealed: (r.revealed || []).map(Number),
    status: MINES_STATUS.includes(r.status) ? r.status : 'live',
    multiplier: Number(Number(r.multiplier || 0).toFixed(2)),
    payout: Math.round(r.payout || 0),
    seed: r.seed || '',
    seedHash: r.seedHash || '',
    startedAt: r.startedAt || r.createdAt,
    endedAt: r.endedAt || null,
    createdAt: r.createdAt,
  };
}

function shapeMinesConfig(doc) {
  const c = clone(doc) || {};
  return {
    minBet: Number(c.minBet ?? MINES_DEFAULT_CONFIG.minBet),
    maxBet: Number(c.maxBet ?? MINES_DEFAULT_CONFIG.maxBet),
    defaultMines: Number(c.defaultMines ?? MINES_DEFAULT_CONFIG.defaultMines),
    houseEdge: Number(c.houseEdge ?? MINES_DEFAULT_CONFIG.houseEdge),
    maxMultiplier: Number(c.maxMultiplier ?? MINES_DEFAULT_CONFIG.maxMultiplier),
    paused: !!c.paused,
  };
}

/* ------------------------------------------------------------------ */
/* Connection                                                          */
/* ------------------------------------------------------------------ */

async function init() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn('[db] MONGODB_URI is not set — running in MEMORY mode (data is lost on restart).');
    return 'memory';
  }

  try {
    mongoose.set('strictQuery', true);
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 12000,
      maxPoolSize: 10,
      dbName: process.env.MONGODB_DB || 'timebomb',
    });
    User = mongoose.model('User', UserSchema);
    Round = mongoose.model('Round', RoundSchema);
    Config = mongoose.model('Config', ConfigSchema);
    Payment = mongoose.model('Payment', PaymentSchema);
    CrashRound = mongoose.model('CrashRound', CrashRoundSchema);
    CrashConfig = mongoose.model('CrashConfig', CrashConfigSchema);
    KenoDraw = mongoose.model('KenoDraw', KenoDrawSchema);
    KenoConfig = mongoose.model('KenoConfig', KenoConfigSchema);
    MinesRound = mongoose.model('MinesRound', MinesRoundSchema);
    MinesConfig = mongoose.model('MinesConfig', MinesConfigSchema);
    await Config.findOneAndUpdate(
      { key: 'main' },
      { $setOnInsert: { key: 'main', ...DEFAULT_CONFIG } },
      { upsert: true, setDefaultsOnInsert: true }
    );
    await CrashConfig.findOneAndUpdate(
      { key: 'main' },
      { $setOnInsert: { key: 'main', ...CRASH_DEFAULT_CONFIG } },
      { upsert: true, setDefaultsOnInsert: true }
    );
    await KenoConfig.findOneAndUpdate(
      { key: 'main' },
      { $setOnInsert: { key: 'main', ...KENO_DEFAULT_CONFIG } },
      { upsert: true, setDefaultsOnInsert: true }
    );
    await MinesConfig.findOneAndUpdate(
      { key: 'main' },
      { $setOnInsert: { key: 'main', ...MINES_DEFAULT_CONFIG } },
      { upsert: true, setDefaultsOnInsert: true }
    );
    mode = 'mongo';
    console.log('[db] connected to MongoDB');
    return 'mongo';
  } catch (err) {
    console.error('[db] MongoDB connection failed:', err.message);
    console.error('[db] Falling back to MEMORY mode (data is lost on restart).');
    mode = 'memory';
    return 'memory';
  }
}

async function close() {
  if (mode === 'mongo') await mongoose.disconnect().catch(() => {});
}

/* ------------------------------------------------------------------ */
/* Config                                                             */
/* ------------------------------------------------------------------ */

async function getConfig() {
  if (mode === 'mongo') {
    const doc = await Config.findOne({ key: 'main' }).lean();
    return shapeConfig(doc);
  }
  return shapeConfig(mem.config);
}

async function saveConfig(patch) {
  const clean = shapeConfig({ ...(await getConfig()), ...patch });
  if (mode === 'mongo') {
    const doc = await Config.findOneAndUpdate(
      { key: 'main' },
      { $set: clean },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    return shapeConfig(doc);
  }
  mem.config = { ...clean };
  return shapeConfig(mem.config);
}

/* ------------------------------------------------------------------ */
/* Users                                                              */
/* ------------------------------------------------------------------ */

/**
 * Create or refresh a player from their Telegram identity. The Telegram user id
 * is the account key, so the same person always gets the same wallet.
 */
async function upsertTelegramUser({ telegramId, username, photoUrl, startingBalance }) {
  const id = String(telegramId);
  const key = `tg:${id}`;
  const name = String(username || 'Player').slice(0, 32);

  if (mode === 'mongo') {
    const update = {
      $set: { username: name, telegramId: id, photoUrl: photoUrl || '' },
      $setOnInsert: {
        key,
        balance: Math.max(0, Math.round(startingBalance || 0)),
        depositCount: 0,
        depositTotal: 0,
        wins: 0,
        winnings: 0,
        banned: false,
      },
    };
    try {
      const doc = await User.findOneAndUpdate({ key }, update, {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      }).lean();
      return shapeUser(doc);
    } catch (err) {
      if (err.code !== 11000) throw err;
      const doc = await User.findOne({ key }).lean();
      return shapeUser(doc);
    }
  }

  let doc = mem.users.find((u) => u.key === key);
  if (!doc) {
    doc = {
      id: `u${++seq.user}`,
      key,
      username: name,
      telegramId: id,
      photoUrl: photoUrl || '',
      balance: Math.max(0, Math.round(startingBalance || 0)),
      depositCount: 0,
      depositTotal: 0,
      wins: 0,
      winnings: 0,
      banned: false,
      createdAt: new Date(),
    };
    mem.users.push(doc);
  } else {
    doc.username = name;
    if (photoUrl) doc.photoUrl = photoUrl;
  }
  return shapeUser(doc);
}

async function getUserById(id) {
  if (mode === 'mongo') {
    if (!mongoose.isValidObjectId(id)) return null;
    const doc = await User.findById(id).lean();
    return shapeUser(doc);
  }
  return shapeUser(mem.users.find((u) => u.id === String(id)));
}

/**
 * Atomically take money from a wallet (never allows a negative balance).
 * Returns the updated user or null when the funds are not there.
 */
async function spendBalance(id, amount) {
  const amt = Math.max(0, Math.round(amount));
  if (mode === 'mongo') {
    if (!mongoose.isValidObjectId(id)) return null;
    const doc = await User.findOneAndUpdate(
      { _id: id, banned: { $ne: true }, balance: { $gte: amt } },
      { $inc: { balance: -amt, depositCount: 1, depositTotal: amt } },
      { new: true }
    ).lean();
    return shapeUser(doc);
  }
  const doc = mem.users.find((u) => u.id === String(id));
  if (!doc || doc.banned || doc.balance < amt) return null;
  doc.balance -= amt;
  doc.depositCount += 1;
  doc.depositTotal += amt;
  return shapeUser(doc);
}

/** Atomic wallet debit for game stakes (does not count as a deposit). */
async function debitBalance(id, amount) {
  const amt = Math.max(0, Math.round(amount));
  if (!amt) return null;
  if (mode === 'mongo') {
    if (!mongoose.isValidObjectId(id)) return null;
    const doc = await User.findOneAndUpdate(
      { _id: id, banned: { $ne: true }, balance: { $gte: amt } },
      { $inc: { balance: -amt } },
      { new: true }
    ).lean();
    return shapeUser(doc);
  }
  const doc = mem.users.find((u) => u.id === String(id));
  if (!doc || doc.banned || doc.balance < amt) return null;
  doc.balance -= amt;
  return shapeUser(doc);
}

async function creditBalance(id, amount, counters = {}) {
  const amt = Math.max(0, Math.round(amount));
  const inc = { balance: amt };
  if (counters.wins) inc.wins = counters.wins;
  if (counters.winnings) inc.winnings = counters.winnings;
  if (mode === 'mongo') {
    if (!mongoose.isValidObjectId(id)) return null;
    const doc = await User.findByIdAndUpdate(id, { $inc: inc }, { new: true }).lean();
    return shapeUser(doc);
  }
  const doc = mem.users.find((u) => u.id === String(id));
  if (!doc) return null;
  doc.balance += amt;
  if (counters.wins) doc.wins += counters.wins;
  if (counters.winnings) doc.winnings += counters.winnings;
  return shapeUser(doc);
}

/** Admin credit/debit. Debit is clamped so a wallet never goes below zero. */
async function adjustBalance(id, delta) {
  const amount = Math.round(Number(delta) || 0);
  if (mode === 'mongo') {
    if (!mongoose.isValidObjectId(id)) return null;
    const user = await User.findById(id).lean();
    if (!user) return null;
    const next = Math.max(0, (user.balance || 0) + amount);
    const doc = await User.findByIdAndUpdate(id, { balance: next }, { new: true }).lean();
    return shapeUser(doc);
  }
  const doc = mem.users.find((u) => u.id === String(id));
  if (!doc) return null;
  doc.balance = Math.max(0, doc.balance + amount);
  return shapeUser(doc);
}

async function setBanned(id, banned) {
  if (mode === 'mongo') {
    if (!mongoose.isValidObjectId(id)) return null;
    const doc = await User.findByIdAndUpdate(id, { banned: !!banned }, { new: true }).lean();
    return shapeUser(doc);
  }
  const doc = mem.users.find((u) => u.id === String(id));
  if (!doc) return null;
  doc.banned = !!banned;
  return shapeUser(doc);
}

async function listUsers({ limit = 100, search = '' } = {}) {
  const q = String(search || '').trim().toLowerCase();
  if (mode === 'mongo') {
    const filter = q
      ? {
          $or: [
            { key: new RegExp(escapeRegex(q), 'i') },
            { username: new RegExp(escapeRegex(q), 'i') },
            { telegramId: new RegExp(escapeRegex(q), 'i') },
          ],
        }
      : {};
    const docs = await User.find(filter).sort({ balance: -1 }).limit(limit).lean();
    return docs.map(shapeUser);
  }
  return mem.users
    .filter(
      (u) =>
        !q ||
        u.key.includes(q) ||
        (u.username || '').toLowerCase().includes(q) ||
        (u.telegramId || '').toLowerCase().includes(q)
    )
    .sort((a, b) => b.balance - a.balance)
    .slice(0, limit)
    .map(shapeUser);
}

async function topUsers(limit = 10) {
  if (mode === 'mongo') {
    const docs = await User.find({ wins: { $gt: 0 } }).sort({ winnings: -1 }).limit(limit).lean();
    return docs.map(shapeUser);
  }
  return mem.users
    .filter((u) => u.wins > 0)
    .sort((a, b) => b.winnings - a.winnings)
    .slice(0, limit)
    .map(shapeUser);
}

async function countUsers() {
  if (mode === 'mongo') return User.countDocuments();
  return mem.users.length;
}

/** Escapes a user-supplied string for a case-insensitive regex search. */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ------------------------------------------------------------------ */
/* Rounds                                                             */
/* ------------------------------------------------------------------ */

async function nextRoundNo() {
  if (mode === 'mongo') {
    const last = await Round.findOne().sort({ no: -1 }).select({ no: 1 }).lean();
    return (last?.no || 0) + 1;
  }
  return mem.rounds.reduce((max, r) => Math.max(max, r.no || 0), 0) + 1;
}

async function createRound(data) {
  if (mode === 'mongo') {
    const doc = await Round.create({ ...data, deposits: data.deposits || [] });
    return shapeRound(doc.toObject());
  }
  const doc = { id: `r${++seq.round}`, ...clone(data), createdAt: new Date(), updatedAt: new Date() };
  mem.rounds.push(doc);
  return shapeRound(doc);
}

async function updateRound(id, patch) {
  if (mode === 'mongo') {
    if (!mongoose.isValidObjectId(id)) return null;
    const doc = await Round.findByIdAndUpdate(id, { $set: patch }, { new: true }).lean();
    return shapeRound(doc);
  }
  const doc = mem.rounds.find((r) => r.id === String(id));
  if (!doc) return null;
  Object.assign(doc, clone(patch), { updatedAt: new Date() });
  return shapeRound(doc);
}

async function findLiveRound() {
  if (mode === 'mongo') {
    const doc = await Round.findOne({ status: 'live' }).sort({ no: -1 }).lean();
    return shapeRound(doc);
  }
  const doc = mem.rounds.filter((r) => r.status === 'live').sort((a, b) => b.no - a.no)[0];
  return shapeRound(doc);
}

async function listRounds({ limit = 25, includeEmpty = false } = {}) {
  const filter = includeEmpty ? { status: { $ne: 'live' } } : { status: { $ne: 'live' }, pot: { $gt: 0 } };
  if (mode === 'mongo') {
    const docs = await Round.find(filter).sort({ no: -1 }).limit(limit).lean();
    return docs.map(shapeRound);
  }
  return mem.rounds
    .filter((r) => r.status !== 'live' && (includeEmpty || (r.pot || 0) > 0))
    .sort((a, b) => b.no - a.no)
    .slice(0, limit)
    .map(shapeRound);
}

async function getStats() {
  if (mode === 'mongo') {
    const [agg] = await Round.aggregate([
      { $match: { status: { $in: ['ended', 'cancelled'] }, pot: { $gt: 0 } } },
      {
        $group: {
          _id: null,
          rounds: { $sum: 1 },
          houseEarned: { $sum: '$houseCut' },
          paidOut: { $sum: '$payout' },
          totalPot: { $sum: '$pot' },
          maxPot: { $max: '$pot' },
        },
      },
    ]);
    const players = await User.countDocuments();
    return {
      rounds: agg?.rounds || 0,
      houseEarned: Math.round(agg?.houseEarned || 0),
      paidOut: Math.round(agg?.paidOut || 0),
      totalPot: Math.round(agg?.totalPot || 0),
      maxPot: Math.round(agg?.maxPot || 0),
      players,
    };
  }
  const settled = mem.rounds.filter((r) => (r.status === 'ended' || r.status === 'cancelled') && r.pot > 0);
  return {
    rounds: settled.length,
    houseEarned: settled.reduce((s, r) => s + (r.status === 'ended' ? r.houseCut || 0 : 0), 0),
    paidOut: settled.reduce((s, r) => s + (r.payout || 0), 0),
    totalPot: settled.reduce((s, r) => s + (r.pot || 0), 0),
    maxPot: settled.reduce((m, r) => Math.max(m, r.pot || 0), 0),
    players: mem.users.length,
  };
}

/* ------------------------------------------------------------------ */
/* Payment requests (Telebirr top-ups and withdrawals)                  */
/* ------------------------------------------------------------------ */

async function createPayment({ userId, username, telegramId, type, amount, phone, text }) {
  const doc = {
    userId: String(userId || ''),
    username: String(username || 'player').slice(0, 32),
    telegramId: String(telegramId || ''),
    type: type === 'withdraw' ? 'withdraw' : 'deposit',
    amount: Math.max(0, Math.round(Number(amount) || 0)),
    phone: String(phone || '').slice(0, 24),
    text: String(text || '').slice(0, 600),
    status: 'pending',
  };
  if (mode === 'mongo') {
    const saved = await Payment.create(doc);
    return shapePayment(saved.toObject());
  }
  const saved = { id: `p${++seq.payment}`, ...doc, createdAt: new Date(), decidedAt: null };
  mem.payments.push(saved);
  return shapePayment(saved);
}

async function listPayments({ status = 'pending', limit = 50 } = {}) {
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  if (mode === 'mongo') {
    const filter = status ? { status } : {};
    const docs = await Payment.find(filter).sort({ createdAt: -1 }).limit(lim).lean();
    return docs.map(shapePayment);
  }
  return mem.payments
    .filter((p) => !status || p.status === status)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, lim)
    .map(shapePayment);
}

async function getPaymentById(id) {
  if (mode === 'mongo') {
    if (!mongoose.isValidObjectId(id)) return null;
    const doc = await Payment.findById(id).lean();
    return shapePayment(doc);
  }
  return shapePayment(mem.payments.find((p) => p.id === String(id)));
}

async function setPaymentStatus(id, status) {
  const next = status === 'approved' || status === 'rejected' ? status : 'pending';
  if (mode === 'mongo') {
    if (!mongoose.isValidObjectId(id)) return null;
    const doc = await Payment.findByIdAndUpdate(id, { status: next, decidedAt: new Date() }, { new: true }).lean();
    return shapePayment(doc);
  }
  const doc = mem.payments.find((p) => p.id === String(id));
  if (!doc) return null;
  doc.status = next;
  doc.decidedAt = new Date();
  return shapePayment(doc);
}

/* ------------------------------------------------------------------ */
/* Crash rounds                                                        */
/* ------------------------------------------------------------------ */

async function getCrashConfig() {
  if (mode === 'mongo') {
    const doc = await CrashConfig.findOne({ key: 'main' }).lean();
    return shapeCrashConfig(doc);
  }
  return shapeCrashConfig(mem.crashConfig);
}

async function saveCrashConfig(patch) {
  const clean = shapeCrashConfig({ ...(await getCrashConfig()), ...patch });
  if (mode === 'mongo') {
    const doc = await CrashConfig.findOneAndUpdate(
      { key: 'main' },
      { $set: clean },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    return shapeCrashConfig(doc);
  }
  mem.crashConfig = { ...clean };
  return shapeCrashConfig(mem.crashConfig);
}

async function nextCrashRoundNo() {
  if (mode === 'mongo') {
    const last = await CrashRound.findOne().sort({ no: -1 }).select({ no: 1 }).lean();
    return (last?.no || 0) + 1;
  }
  return mem.crashRounds.reduce((max, r) => Math.max(max, r.no || 0), 0) + 1;
}

async function saveCrashRound(data) {
  if (mode === 'mongo') {
    const doc = await CrashRound.create(data);
    return shapeCrashRound(doc.toObject());
  }
  const doc = { id: `cr${++seq.crash}`, ...clone(data), createdAt: new Date() };
  mem.crashRounds.push(doc);
  return shapeCrashRound(doc);
}

async function listCrashRounds({ limit = 25 } = {}) {
  const lim = Math.max(1, Math.min(200, Number(limit) || 25));
  if (mode === 'mongo') {
    const docs = await CrashRound.find().sort({ no: -1 }).limit(lim).lean();
    return docs.map(shapeCrashRound);
  }
  return mem.crashRounds
    .slice()
    .sort((a, b) => b.no - a.no)
    .slice(0, lim)
    .map(shapeCrashRound);
}

async function getCrashStats() {
  if (mode === 'mongo') {
    const [agg] = await CrashRound.aggregate([
      {
        $group: {
          _id: null,
          rounds: { $sum: 1 },
          totalBet: { $sum: '$totalBet' },
          totalPayout: { $sum: '$totalPayout' },
          houseProfit: { $sum: '$houseProfit' },
          maxMultiplier: { $max: '$crashAt' },
        },
      },
    ]);
    const [players] = await CrashRound.aggregate([
      { $unwind: '$bets' },
      { $group: { _id: '$bets.userId' } },
      { $count: 'count' },
    ]);
    return {
      rounds: agg?.rounds || 0,
      totalBet: Math.round(agg?.totalBet || 0),
      totalPayout: Math.round(agg?.totalPayout || 0),
      houseProfit: Math.round(agg?.houseProfit || 0),
      maxMultiplier: Number((agg?.maxMultiplier || 0).toFixed(2)),
      players: players?.count || 0,
    };
  }

  const rounds = mem.crashRounds;
  const players = new Set();
  for (const round of rounds) for (const bet of round.bets || []) players.add(bet.userId);
  return {
    rounds: rounds.length,
    totalBet: rounds.reduce((sum, r) => sum + (r.totalBet || 0), 0),
    totalPayout: rounds.reduce((sum, r) => sum + (r.totalPayout || 0), 0),
    houseProfit: rounds.reduce((sum, r) => sum + (r.houseProfit || 0), 0),
    maxMultiplier: rounds.reduce((max, r) => Math.max(max, r.crashAt || 0), 0),
    players: players.size,
  };
}

/* ------------------------------------------------------------------ */
/* Keno draws                                                          */
/* ------------------------------------------------------------------ */

async function getKenoConfig() {
  if (mode === 'mongo') {
    const doc = await KenoConfig.findOne({ key: 'main' }).lean();
    return shapeKenoConfig(doc);
  }
  return shapeKenoConfig(mem.kenoConfig);
}

async function saveKenoConfig(patch) {
  const clean = shapeKenoConfig({ ...(await getKenoConfig()), ...patch });
  if (mode === 'mongo') {
    const doc = await KenoConfig.findOneAndUpdate(
      { key: 'main' },
      { $set: clean },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    return shapeKenoConfig(doc);
  }
  mem.kenoConfig = { ...clean };
  return shapeKenoConfig(mem.kenoConfig);
}

async function nextKenoDrawNo() {
  if (mode === 'mongo') {
    const last = await KenoDraw.findOne().sort({ no: -1 }).select({ no: 1 }).lean();
    return (last?.no || 0) + 1;
  }
  return mem.kenoDraws.reduce((max, r) => Math.max(max, r.no || 0), 0) + 1;
}

async function saveKenoDraw(data) {
  const full = { status: 'settled', roundNo: 0, ...clone(data) };
  if (mode === 'mongo') {
    const doc = await KenoDraw.create(full);
    return shapeKenoDraw(doc.toObject());
  }
  const doc = { id: `k${++seq.keno}`, ...full, createdAt: new Date() };
  mem.kenoDraws.push(doc);
  if (mem.kenoDraws.length > 500) mem.kenoDraws.splice(0, mem.kenoDraws.length - 500);
  return shapeKenoDraw(doc);
}

async function listKenoDraws({ limit = 20, userId = '', status = 'settled' } = {}) {
  const lim = Math.max(1, Math.min(200, Number(limit) || 20));
  if (mode === 'mongo') {
    const filter =
      status === 'any'
        ? {}
        : status === 'pending'
          ? { status: 'pending' }
          : { $or: [{ status: 'settled' }, { status: { $exists: false } }] };
    if (userId) filter.userId = String(userId);
    const docs = await KenoDraw.find(filter).sort({ no: -1 }).limit(lim).lean();
    return docs.map(shapeKenoDraw);
  }
  return mem.kenoDraws
    .filter((d) => !userId || d.userId === String(userId))
    .filter((d) => status === 'any' || (status === 'pending' ? d.status === 'pending' : (d.status || 'settled') === 'settled'))
    .slice()
    .sort((a, b) => b.no - a.no)
    .slice(0, lim)
    .map(shapeKenoDraw);
}

async function listPendingKenoDraws() {
  if (mode === 'mongo') {
    const docs = await KenoDraw.find({ status: 'pending' }).lean();
    return docs.map(shapeKenoDraw);
  }
  return mem.kenoDraws.filter((d) => d.status === 'pending').map(shapeKenoDraw);
}

async function updateKenoDraw(id, patch) {
  if (mode === 'mongo') {
    const doc = await KenoDraw.findByIdAndUpdate(id, { $set: patch }, { new: true }).lean();
    return shapeKenoDraw(doc);
  }
  const doc = mem.kenoDraws.find((d) => d.id === id);
  if (!doc) return null;
  Object.assign(doc, patch);
  return shapeKenoDraw(doc);
}

async function getKenoStats() {
  if (mode === 'mongo') {
    const [agg] = await KenoDraw.aggregate([
      { $match: { $or: [{ status: 'settled' }, { status: { $exists: false } }] } },
      {
        $group: {
          _id: null,
          draws: { $sum: 1 },
          staked: { $sum: '$amount' },
          paidOut: { $sum: '$payout' },
          wins: { $sum: { $cond: [{ $gt: ['$payout', 0] }, 1, 0] } },
          biggestWin: { $max: '$payout' },
        },
      },
    ]);
    return {
      draws: agg?.draws || 0,
      staked: Math.round(agg?.staked || 0),
      paidOut: Math.round(agg?.paidOut || 0),
      houseProfit: Math.round((agg?.staked || 0) - (agg?.paidOut || 0)),
      wins: agg?.wins || 0,
      biggestWin: Math.round(agg?.biggestWin || 0),
    };
  }
  const draws = mem.kenoDraws.filter((d) => (d.status || 'settled') === 'settled');
  const staked = draws.reduce((sum, d) => sum + (d.amount || 0), 0);
  const paidOut = draws.reduce((sum, d) => sum + (d.payout || 0), 0);
  return {
    draws: draws.length,
    staked,
    paidOut,
    houseProfit: staked - paidOut,
    wins: draws.filter((d) => (d.payout || 0) > 0).length,
    biggestWin: draws.reduce((max, d) => Math.max(max, d.payout || 0), 0),
  };
}

/* ------------------------------------------------------------------ */
/* Mines rounds                                                        */
/* ------------------------------------------------------------------ */

async function getMinesConfig() {
  if (mode === 'mongo') {
    const doc = await MinesConfig.findOne({ key: 'main' }).lean();
    return shapeMinesConfig(doc);
  }
  return shapeMinesConfig(mem.minesConfig);
}

async function saveMinesConfig(patch) {
  const clean = shapeMinesConfig({ ...(await getMinesConfig()), ...patch });
  if (mode === 'mongo') {
    const doc = await MinesConfig.findOneAndUpdate(
      { key: 'main' },
      { $set: clean },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    return shapeMinesConfig(doc);
  }
  mem.minesConfig = { ...clean };
  return shapeMinesConfig(mem.minesConfig);
}

async function nextMinesRoundNo() {
  if (mode === 'mongo') {
    const last = await MinesRound.findOne().sort({ no: -1 }).select({ no: 1 }).lean();
    return (last?.no || 0) + 1;
  }
  return mem.minesRounds.reduce((max, r) => Math.max(max, r.no || 0), 0) + 1;
}

async function saveMinesRound(data) {
  const full = { status: 'live', revealed: [], layout: [], ...clone(data) };
  if (mode === 'mongo') {
    const doc = await MinesRound.create(full);
    return shapeMinesRound(doc.toObject());
  }
  const doc = { id: `m${++seq.mines}`, ...full, createdAt: new Date() };
  mem.minesRounds.push(doc);
  if (mem.minesRounds.length > 800) mem.minesRounds.splice(0, mem.minesRounds.length - 800);
  return shapeMinesRound(doc);
}

async function updateMinesRound(id, patch) {
  if (mode === 'mongo') {
    const doc = await MinesRound.findByIdAndUpdate(id, { $set: patch }, { new: true }).lean();
    return shapeMinesRound(doc);
  }
  const doc = mem.minesRounds.find((r) => r.id === id);
  if (!doc) return null;
  Object.assign(doc, clone(patch));
  return shapeMinesRound(doc);
}

async function listMinesRounds({ limit = 25, userId = '', status = 'any' } = {}) {
  const lim = Math.max(1, Math.min(200, Number(limit) || 25));
  const settled = ['won', 'lost', 'cashed'];
  if (mode === 'mongo') {
    let filter = {};
    if (status === 'settled') filter = { status: { $in: settled } };
    else if (status && status !== 'any') filter = { status };
    if (userId) filter.userId = String(userId);
    const docs = await MinesRound.find(filter).sort({ no: -1 }).limit(lim).lean();
    return docs.map(shapeMinesRound);
  }
  return mem.minesRounds
    .filter((r) => !userId || r.userId === String(userId))
    .filter((r) =>
      status === 'any' ? true : status === 'settled' ? settled.includes(r.status) : r.status === status
    )
    .slice()
    .sort((a, b) => b.no - a.no)
    .slice(0, lim)
    .map(shapeMinesRound);
}

async function listLiveMinesRounds() {
  if (mode === 'mongo') {
    const docs = await MinesRound.find({ status: 'live' }).lean();
    return docs.map(shapeMinesRound);
  }
  return mem.minesRounds.filter((r) => r.status === 'live').map(shapeMinesRound);
}

async function getMinesStats() {
  if (mode === 'mongo') {
    const [agg] = await MinesRound.aggregate([
      { $match: { status: { $in: ['won', 'lost', 'cashed'] } } },
      {
        $group: {
          _id: null,
          rounds: { $sum: 1 },
          staked: { $sum: '$amount' },
          paidOut: { $sum: '$payout' },
          wins: { $sum: { $cond: [{ $gt: ['$payout', 0] }, 1, 0] } },
          biggestWin: { $max: '$payout' },
          bestMultiplier: { $max: { $cond: [{ $gt: ['$payout', 0] }, '$multiplier', 0] } },
        },
      },
    ]);
    return {
      rounds: agg?.rounds || 0,
      staked: Math.round(agg?.staked || 0),
      paidOut: Math.round(agg?.paidOut || 0),
      houseProfit: Math.round((agg?.staked || 0) - (agg?.paidOut || 0)),
      wins: agg?.wins || 0,
      biggestWin: Math.round(agg?.biggestWin || 0),
      bestMultiplier: Number((agg?.bestMultiplier || 0).toFixed(2)),
    };
  }
  const rounds = mem.minesRounds.filter((r) => ['won', 'lost', 'cashed'].includes(r.status));
  const staked = rounds.reduce((sum, r) => sum + (r.amount || 0), 0);
  const paidOut = rounds.reduce((sum, r) => sum + (r.payout || 0), 0);
  return {
    rounds: rounds.length,
    staked,
    paidOut,
    houseProfit: staked - paidOut,
    wins: rounds.filter((r) => (r.payout || 0) > 0).length,
    biggestWin: rounds.reduce((max, r) => Math.max(max, r.payout || 0), 0),
    bestMultiplier: rounds
      .filter((r) => (r.payout || 0) > 0)
      .reduce((max, r) => Math.max(max, Number(r.multiplier) || 0), 0),
  };
}

module.exports = {
  init,
  close,
  getConfig,
  saveConfig,
  upsertTelegramUser,
  getUserById,
  listUsers,
  topUsers,
  countUsers,
  spendBalance,
  debitBalance,
  creditBalance,
  adjustBalance,
  setBanned,
  createPayment,
  listPayments,
  getPaymentById,
  setPaymentStatus,
  nextRoundNo,
  createRound,
  updateRound,
  findLiveRound,
  listRounds,
  getStats,
  getCrashConfig,
  saveCrashConfig,
  nextCrashRoundNo,
  saveCrashRound,
  listCrashRounds,
  getCrashStats,
  getKenoConfig,
  saveKenoConfig,
  nextKenoDrawNo,
  saveKenoDraw,
  listKenoDraws,
  listPendingKenoDraws,
  updateKenoDraw,
  getKenoStats,
  getMinesConfig,
  saveMinesConfig,
  nextMinesRoundNo,
  saveMinesRound,
  updateMinesRound,
  listMinesRounds,
  listLiveMinesRounds,
  getMinesStats,
  get mode() {
    return mode;
  },
  DEFAULT_CONFIG,
  CRASH_DEFAULT_CONFIG,
  KENO_DEFAULT_CONFIG,
  MINES_DEFAULT_CONFIG,
};
