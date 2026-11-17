/**
 * Limite de intentos de login (en memoria) para frenar ataques de fuerza bruta.
 *
 * - Dos contadores: por IP y por par (usuario, IP). El de usuario va ligado a la IP para que alguien
 *   desde otra IP no pueda bloquear la cuenta del usuario real.
 * - El intento se reserva ANTES de procesar la peticion: las peticiones en paralelo y las abortadas cuentan.
 * - Un login exitoso solo devuelve SU propio intento; no borra fallos de otras claves.
 * - Memoria acotada: claves con hash de tamano fijo, identificador truncado, barrido de vencidas
 *   y tope de entradas (se descartan las mas antiguas).
 */

const crypto = require('crypto');

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const MAX_ENTRIES = 10000;
const MAX_IDENTIFIER_LENGTH = 254;

const hashKey = (value) => crypto.createHash('sha256').update(value).digest('base64').slice(0, 22);

const createLoginRateLimit = ({
  windowMs = WINDOW_MS,
  maxAttempts = MAX_ATTEMPTS,
  maxEntries = MAX_ENTRIES,
  now = () => Date.now()
} = {}) => {
  const counters = new Map(); // hash de clave -> { count, resetAt } (orden de insercion = antiguedad)

  const read = (key) => {
    const e = counters.get(key);
    if (e && e.resetAt <= now()) {
      counters.delete(key);
      return null;
    }
    return e || null;
  };

  const sweep = () => {
    const t = now();
    for (const [k, e] of counters) if (e.resetAt <= t) counters.delete(k);
    // Si aun excede el tope, descartar las entradas mas antiguas
    while (counters.size >= maxEntries) counters.delete(counters.keys().next().value);
  };

  const reserve = (key) => {
    let e = read(key);
    if (!e) {
      if (counters.size >= maxEntries) sweep();
      e = { count: 0, resetAt: now() + windowMs };
      counters.set(key, e);
    }
    e.count += 1;
  };

  const tooMany = (res, entry) => {
    res.set('Retry-After', String(Math.max(1, Math.ceil((entry.resetAt - now()) / 1000))));
    return res.status(429).json({
      success: false,
      message: 'Demasiados intentos fallidos. Intente de nuevo en unos minutos.'
    });
  };

  const middleware = (req, res, next) => {
    const ip = String(req.ip || req.socket?.remoteAddress || 'desconocida');
    const body = req.body || {};
    const user = String(body.username || body.email || '')
      .slice(0, MAX_IDENTIFIER_LENGTH)
      .trim()
      .toLowerCase();

    // Primero la IP: si ya esta bloqueada no se crea ninguna clave nueva
    const ipKey = hashKey(`ip:${ip}`);
    const ipEntry = read(ipKey);
    if (ipEntry && ipEntry.count >= maxAttempts) return tooMany(res, ipEntry);

    const keys = [ipKey];
    if (user) {
      const userKey = hashKey(`user:${user}|ip:${ip}`);
      const userEntry = read(userKey);
      if (userEntry && userEntry.count >= maxAttempts) return tooMany(res, userEntry);
      keys.push(userKey);
    }

    keys.forEach(reserve);

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

  middleware._size = () => counters.size; // solo para pruebas
  return middleware;
};

module.exports = { createLoginRateLimit };
