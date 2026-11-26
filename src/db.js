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
  startingBalance: 500,
  autoStart: true,
  paused: false,
  minDepositGapMs: 700,
};

let mode = 'memory';
const mem = { users: [], rounds: [], config: { ...DEFAULT_CONFIG } };
let seq = { user: 0, round: 0 };

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
    await Config.findOneAndUpdate(
      { key: 'main' },
      { $setOnInsert: { key: 'main', ...DEFAULT_CONFIG } },
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
  creditBalance,
  adjustBalance,
  setBanned,
  nextRoundNo,
  createRound,
  updateRound,
  findLiveRound,
  listRounds,
  getStats,
  get mode() {
    return mode;
  },
  DEFAULT_CONFIG,
};
