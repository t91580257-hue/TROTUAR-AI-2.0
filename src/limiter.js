/**
 * TROTUAR AI 2.0 — простое ограничение частоты запросов (sliding window, in-memory).
 * Унаследовано из TROTUAR AI 1.x, расширено настраиваемыми лимитами и категориями.
 */
function createLimiter({ windowMs = 60_000, max = 20, message = "Слишком много запросов. Подождите немного и попробуйте снова." } = {}) {
  const hits = new Map();

  function sweep(now) {
    for (const [key, times] of hits) {
      const fresh = times.filter((time) => now - time < windowMs);
      if (fresh.length === 0) hits.delete(key);
      else hits.set(key, fresh);
    }
  }

  return function limit(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    const now = Date.now();
    if (!hits.has(ip)) hits.set(ip, []);
    const times = hits.get(ip).filter((time) => now - time < windowMs);

    if (times.length >= max) {
      sweep(now);
      const oldest = times[0];
      const retryAfter = Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000));
      res.set("Retry-After", String(retryAfter));
      return res.status(429).json({ error: message });
    }
    times.push(now);
    hits.set(ip, times);
    sweep(now);
    next();
  };
}

module.exports = { createLimiter };
