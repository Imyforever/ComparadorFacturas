/**
 * Limite de intentos fallidos de login por IP (en memoria) para frenar ataques de fuerza bruta.
 * Tras MAX_FAILURES fallos en WINDOW_MS se responde 429 hasta que expire la ventana.
 */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;

const createLoginRateLimit = ({ windowMs = WINDOW_MS, maxFailures = MAX_FAILURES, now = () => Date.now() } = {}) => {
  const failures = new Map(); // ip -> { count, resetAt }

  const middleware = (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || 'desconocida';
    const entry = failures.get(ip);
    if (entry && entry.resetAt <= now()) failures.delete(ip);
    const current = failures.get(ip);
    if (current && current.count >= maxFailures) {
      const retrySeconds = Math.ceil((current.resetAt - now()) / 1000);
      res.set('Retry-After', String(retrySeconds));
      return res.status(429).json({
        success: false,
        message: 'Demasiados intentos fallidos. Intente de nuevo en unos minutos.'
      });
    }

    res.on('finish', () => {
      if (res.statusCode === 401) {
        const e = failures.get(ip) || { count: 0, resetAt: now() + windowMs };
        e.count += 1;
        failures.set(ip, e);
      } else if (res.statusCode === 200) {
        failures.delete(ip);
      }
    });
    return next();
  };

  return middleware;
};

module.exports = { createLoginRateLimit };
