/**
 * Servicio de autenticacion, generacion y verificacion de JWT HS256.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const env = require('../config/env');
const defaultUserRepo = require('../repositories/userRepository');
const { httpError } = require('../utils/errors');

const base64url = (input) =>
  Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

const signJwtInput = (signingInput, secret = env.SESSION_SECRET) =>
  crypto
    .createHmac('sha256', secret)
    .update(signingInput)
    .digest('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

/** Token de sesion con formato JWT firmado con HMAC-SHA256 */
const generateSessionToken = (
  userId,
  ttlSeconds,
  secret = env.SESSION_SECRET,
  nowSeconds = Math.floor(Date.now() / 1000)
) => {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ sub: String(userId), iat: nowSeconds, exp: nowSeconds + ttlSeconds }));
  const signature = signJwtInput(`${header}.${payload}`, secret);
  return `${header}.${payload}.${signature}`;
};

/**
 * Verifica la firma HS256 en tiempo constante y la vigencia (exp) del token JWT.
 * Devuelve el payload decodificado o null si es invalido/expirado.
 */
const verifySessionToken = (
  token,
  secret = env.SESSION_SECRET,
  nowSeconds = Math.floor(Date.now() / 1000)
) => {
  if (typeof token !== 'string' || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts;
  if (!headerB64 || !payloadB64 || !signatureB64) return null;

  const expectedSig = signJwtInput(`${headerB64}.${payloadB64}`, secret);
  const sigBuf = Buffer.from(signatureB64, 'utf8');
  const expBuf = Buffer.from(expectedSig, 'utf8');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!header || header.alg !== 'HS256') return null;
    if (!payload || typeof payload.exp !== 'number' || payload.exp <= nowSeconds) return null;
    return payload;
  } catch (_) {
    return null;
  }
};

/** Comparacion de texto en tiempo constante validando que ambos argumentos sean cadenas */
const safeEqual = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
};

const createAuthService = ({
  userRepo = defaultUserRepo,
  config = env,
  nowSecondsFn = () => Math.floor(Date.now() / 1000)
} = {}) => {
  const login = async ({ username, email, password, rememberMe } = {}) => {
    const loginIdentifier = String(username || email || '').trim().toLowerCase();

    if (!loginIdentifier || !password || typeof password !== 'string') {
      throw httpError(400, 'Debe ingresar el usuario y la contrasena.');
    }

    let user = null;
    try {
      if (userRepo.isConnected()) {
        user = await userRepo.findByUsername(loginIdentifier);
      }
    } catch (_) {
      user = null;
    }

    const adminUsername = String(config.ADMIN_USERNAME || 'admin').trim();
    const adminPassword = String(config.ADMIN_PASSWORD || 'admin');

    let isPasswordValid = false;
    let userId = 'usr_admin';
    let userName = 'Administrador';
    let userRole = 'Administrador';

    if (user) {
      isPasswordValid = user.password ? await bcrypt.compare(password, user.password) : false;
      userId = user._id;
      userName = user.name || 'Administrador';
      userRole = user.role || 'Administrador';
    } else if (loginIdentifier === adminUsername.toLowerCase()) {
      isPasswordValid = safeEqual(password, adminPassword);
    }

    if (!isPasswordValid) {
      throw httpError(401, 'Usuario o contrasena incorrectos.');
    }

    const ttl = rememberMe ? 3600 * 24 * 30 : 3600 * 24;
    const token = generateSessionToken(userId, ttl, config.SESSION_SECRET, nowSecondsFn());

    return {
      success: true,
      message: 'Sesion iniciada correctamente.',
      token,
      user: {
        id: userId,
        username: user?.username || adminUsername,
        name: userName,
        role: userRole
      },
      duration: rememberMe ? '30d' : '24h'
    };
  };

  const ensureAdminUser = async () => {
    if (!userRepo.isConnected()) return;
    const adminUsername = String(config.ADMIN_USERNAME || 'admin').trim();
    const adminPassword = String(config.ADMIN_PASSWORD || 'admin');
    try {
      const existingAdmin = await userRepo.findByUsername(adminUsername);
      if (!existingAdmin) {
        const hashedPassword = await bcrypt.hash(adminPassword, 10);
        await userRepo.create({
          username: adminUsername,
          name: 'Administrador',
          password: hashedPassword,
          role: 'Administrador'
        });
        console.log(`[Auth] Usuario ${adminUsername} inicial creado con contrasena hasheada.`);
      }
    } catch (err) {
      console.error('[Auth] Error asegurando usuario admin:', err.message);
    }
  };

  return {
    login,
    ensureAdminUser
  };
};

const defaultService = createAuthService();

module.exports = {
  base64url,
  generateSessionToken,
  verifySessionToken,
  safeEqual,
  createAuthService,
  ...defaultService
};
