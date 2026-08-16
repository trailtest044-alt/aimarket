import rateLimit from 'express-rate-limit';

export const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 200,
  standardHeaders: true,
  legacyHeaders: false
});

export const orderLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many order attempts. Try again later.' }
});

export const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again later.' }
});

// Customer authentication is Google-only. Keep old email-auth URLs closed so
// a stale client cannot re-enable the retired login method.
export function emailLoginStartLimiter(req, res) {
  return res.status(404).json({ error: 'Email login is disabled. Continue with Google.' });
}

export const emailLoginVerifyLimiter = emailLoginStartLimiter;
