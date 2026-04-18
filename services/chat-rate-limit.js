const DEFAULT_WINDOW_MS = 60 * 1000;
const DEFAULT_DAY_MS = 24 * 60 * 60 * 1000;

const createBucket = () => ({ count: 0, resetAt: 0 });

const buckets = new Map();

const getBucket = (key, windowMs) => {
  const now = Date.now();
  let entry = buckets.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = createBucket();
    entry.resetAt = now + windowMs;
    buckets.set(key, entry);
  }
  return entry;
};

const clientKey = (req, sessionId) => {
  const auth = req.body?.userId || req.body?.userEmail || req.query?.userId || req.query?.userEmail;
  if (auth) {
    return `user:${auth}`;
  }
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  return `anon:${ip}:${sessionId || 'nosession'}`;
};

// Sliding-window in-memory limiter. Safe for a single node process; for multi-node scale,
// swap internal bucket storage for Redis (we intentionally avoid that dependency for now).
const createChatRateLimiter = ({
  perMinute = 120,
  perDay = 500,
  imagePerDay = 25,
} = {}) => {
  return (req, res, next) => {
    try {
      const sessionId = req.body?.sessionId || req.query?.sessionId;
      const key = clientKey(req, sessionId);
      const minuteBucket = getBucket(`${key}:min`, DEFAULT_WINDOW_MS);
      const dayBucket = getBucket(`${key}:day`, DEFAULT_DAY_MS);

      const hasImage = Array.isArray(req.body?.images) && req.body.images.length > 0;
      const imageBucket = hasImage ? getBucket(`${key}:img-day`, DEFAULT_DAY_MS) : null;

      if (minuteBucket.count >= perMinute) {
        const retryAfter = Math.max(1, Math.ceil((minuteBucket.resetAt - Date.now()) / 1000));
        res.set('Retry-After', String(retryAfter));
        return res.status(429).json({ error: 'Too many requests', scope: 'minute', retryAfter });
      }

      if (dayBucket.count >= perDay) {
        const retryAfter = Math.max(1, Math.ceil((dayBucket.resetAt - Date.now()) / 1000));
        res.set('Retry-After', String(retryAfter));
        return res.status(429).json({ error: 'Daily message limit reached', scope: 'day', retryAfter });
      }

      if (imageBucket && imageBucket.count >= imagePerDay) {
        const retryAfter = Math.max(1, Math.ceil((imageBucket.resetAt - Date.now()) / 1000));
        res.set('Retry-After', String(retryAfter));
        return res.status(429).json({ error: 'Daily image limit reached', scope: 'image-day', retryAfter });
      }

      minuteBucket.count += 1;
      dayBucket.count += 1;
      if (imageBucket) imageBucket.count += 1;

      return next();
    } catch (error) {
      console.error('Rate limiter error:', error);
      return next();
    }
  };
};

module.exports = { createChatRateLimiter };
