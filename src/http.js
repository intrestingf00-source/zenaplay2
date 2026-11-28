'use strict';

/** Wraps async express handlers so rejections reach the error middleware. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Small in-process counter used to slow down login/registration abuse. */
function createThrottle() {
  const hits = new Map();

  function throttled(key, max, windowMs) {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now > entry.reset) {
      hits.set(key, { count: 1, reset: now + windowMs });
      return false;
    }
    entry.count += 1;
    return entry.count > max;
  }

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (now > entry.reset) hits.delete(key);
  }, 60000);
  if (timer.unref) timer.unref();

  return { throttled };
}

/** JSON error with a stable code the client can translate. */
function fail(res, status, code, message) {
  return res.status(status).json({ error: message || code, code });
}

module.exports = { wrap, createThrottle, fail };
