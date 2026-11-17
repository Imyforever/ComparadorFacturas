/**
 * Limite de intentos de login (en memoria) para frenar ataques de fuerza bruta.
 *
 * - Se cuenta por IP y por usuario (normalizado): bloquea si cualquiera de los dos supera el limite.
 * - El intento se reserva ANTES de procesar la peticion, asi las peticiones en paralelo no se saltan el limite
 *   y las abortadas tambien cuentan.
 * - Un login exitoso solo devuelve SU propio intento; no borra los fallos acumulados de la IP ni de otras cuentas.
 */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

const createLoginRateLimit = ({ windowMs = WINDOW_MS, maxAttempts = MAX_ATTEMPTS, now = () => Date.now() } = {}) => {
  const counters = new Map(); // clave -> { count, resetAt }

  const read = (key) => {
    const e = counters.get(key);
    if (e && e.resetAt <= now()) {
      counters.delete(key);
      return null;
    }
    return e || null;
  };

  const middleware = (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || 'desconocida';
    const body = req.body || {};
    const user = String(body.username || body.email || '').trim().toLowerCase();
    const keys = [`ip:${ip}`, ...(user ? [`user:${user}`] : [])];

    const blocked = keys.map(read).filter((e) => e && e.count >= maxAttempts);
    if (blocked.length > 0) {
      const resetAt = Math.max(...blocked.map((e) => e.resetAt));
      res.set('Retry-After', String(Math.ceil((resetAt - now()) / 1000)));
      return res.status(429).json({
        success: false,
        message: 'Demasiados intentos fallidos. Intente de nuevo en unos minutos.'
      });
    }

    // Reservar el intento por adelantado
    for (const key of keys) {
      const e = read(key) || { count: 0, resetAt: now() + windowMs };
      e.count += 1;
      counters.set(key, e);
    }

    // Solo un login exitoso devuelve el intento reservado (fallos, errores y abortos siguen contando)
    res.on('finish', () => {
      if (res.statusCode !== 200) return;
      for (const key of keys) {
        const e = read(key);
        if (e) e.count = Math.max(0, e.count - 1);
      }
    });
    return next();
  };

  return middleware;
};

module.exports = { createLoginRateLimit };
