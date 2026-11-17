/**
 * Limite de intentos de login (en memoria) para frenar ataques de fuerza bruta.
 *
 * Contadores (ventana de 15 min, el intento se reserva ANTES de procesar la peticion):
 *  - Por IP (IPv6 agrupado por /64): maxAttempts.
 *  - Por par (usuario, IP): maxAttempts.
 *  - Global por cuenta: maxAccountAttempts (mas alto). Frena ataques distribuidos desde muchas IPs.
 *    No aplica a IPs "conocidas" (desde las que ese usuario ya inicio sesion), para que un atacante
 *    no pueda bloquear al usuario real.
 * Un login exitoso solo devuelve SU propio intento y marca la IP como conocida para ese usuario.
 *
 * Memoria acotada: claves con hash de tamano fijo, identificador truncado y barrido de vencidas.
 * Las entradas activas nunca se descartan: si la tabla se llena, se rechaza (429) en vez de olvidar bloqueos.
 */

const crypto = require('crypto');

const WINDOW_MS = 15 * 60 * 1000;
const TRUSTED_TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_ATTEMPTS = 10;
const MAX_ACCOUNT_ATTEMPTS = 50;
const MAX_ENTRIES = 20000;
const { normalizeLoginIdentifier } = require('../utils/text');

const hashKey = (value) => crypto.createHash('sha256').update(value).digest('base64').slice(0, 22);

/** Normaliza la IP: IPv4 (incluida la forma ::ffff:a.b.c.d) tal cual; IPv6 reducida a su prefijo /64 */
const ipBucket = (rawIp) => {
  const ip = String(rawIp || 'desconocida').trim().toLowerCase();
  const v4 = ip.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) return v4[1];
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const fill = new Array(Math.max(0, 8 - headParts.length - tailParts.length)).fill('0');
  const full = ip.includes('::') ? [...headParts, ...fill, ...tailParts] : headParts;
  return `${full.slice(0, 4).map((p) => p || '0').join(':')}::/64`;
};

const createLoginRateLimit = ({
  windowMs = WINDOW_MS,
  maxAttempts = MAX_ATTEMPTS,
  maxAccountAttempts = MAX_ACCOUNT_ATTEMPTS,
  maxEntries = MAX_ENTRIES,
  now = () => Date.now()
} = {}) => {
  const counters = new Map(); // hash -> { count, resetAt }
  const trusted = new Map(); // hash(usuario|ip) -> expira

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
    for (const [k, exp] of trusted) if (exp <= t) trusted.delete(k);
  };

  const tooMany = (res, entry) => {
    const resetAt = entry ? entry.resetAt : now() + windowMs;
    res.set('Retry-After', String(Math.max(1, Math.ceil((resetAt - now()) / 1000))));
    return res.status(429).json({
      success: false,
      message: 'Demasiados intentos fallidos. Intente de nuevo en unos minutos.'
    });
  };

  const middleware = (req, res, next) => {
    const ip = ipBucket(req.ip || req.socket?.remoteAddress);
    // Misma normalizacion que el servicio de login: no hay forma de que dos escrituras distintas
    // del mismo usuario caigan en contadores diferentes
    const user = normalizeLoginIdentifier(req.body || {});
    if (user === null) {
      return res.status(400).json({ success: false, message: 'El usuario es demasiado largo.' });
    }

    // 1. Limite por IP (antes de crear cualquier clave nueva)
    const ipKey = hashKey(`ip:${ip}`);
    const ipEntry = read(ipKey);
    if (ipEntry && ipEntry.count >= maxAttempts) return tooMany(res, ipEntry);

    const checks = [[ipKey, maxAttempts]];
    let trustKey = null;
    let isTrusted = false;
    if (user) {
      // 2. Limite por (usuario, IP)
      const pairKey = hashKey(`user:${user}|ip:${ip}`);
      const pairEntry = read(pairKey);
      if (pairEntry && pairEntry.count >= maxAttempts) return tooMany(res, pairEntry);
      checks.push([pairKey, maxAttempts]);

      // 3. Limite global por cuenta, salvo IPs conocidas para ese usuario
      trustKey = pairKey;
      const exp = trusted.get(trustKey);
      isTrusted = Boolean(exp && exp > now());
      if (!isTrusted) {
        const accKey = hashKey(`account:${user}`);
        const accEntry = read(accKey);
        if (accEntry && accEntry.count >= maxAccountAttempts) return tooMany(res, accEntry);
        checks.push([accKey, maxAccountAttempts]);
      }
    }

    // Claves nuevas necesarias; si no caben ni tras barrer vencidas, rechazar (no olvidar bloqueos activos).
    // Excepcion: un usuario desde una IP conocida siempre puede intentar (sus claves nuevas no se guardan).
    const missing = checks.filter(([k]) => !read(k)).length;
    let full = false;
    if (counters.size + missing > maxEntries) {
      sweep();
      full = counters.size + missing > maxEntries;
      if (full && !isTrusted) return tooMany(res, null);
    }

    const keys = checks.map(([k]) => k);
    for (const key of keys) {
      let e = read(key);
      if (!e) {
        // Con la tabla llena solo llega aqui un par conocido: sus contadores se guardan igual
        // (excede el tope a lo mucho por las IPs conocidas, que tambien estan acotadas), nunca sin contar.
        e ={ count: 0, resetAt: now() + windowMs };
        counters.set(key, e);
      }
      e.count += 1;
    }

    // Solo un login exitoso devuelve el intento reservado y marca la IP como conocida
    res.on('finish', () => {
      if (res.statusCode !== 200) return;
      for (const key of keys) {
        const e = read(key);
        if (e) e.count = Math.max(0, e.count - 1);
      }
      if (trustKey) {
        if (trusted.size >= maxEntries) sweep();
        if (trusted.size < maxEntries) trusted.set(trustKey, now() + TRUSTED_TTL_MS);
      }
    });
    return next();
  };

  middleware._size = () => counters.size; // solo para pruebas
  return middleware;
};

module.exports = { createLoginRateLimit, ipBucket };
