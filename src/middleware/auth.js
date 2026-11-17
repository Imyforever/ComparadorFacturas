/**
 * Middleware de autenticacion JWT (HS256) para proteger las rutas de la API.
 */

const env = require('../config/env');
const { verifySessionToken, generateSessionToken } = require('../services/authService');

const INVALID_SESSION_MESSAGE = 'Sesion invalida o expirada.';

const isPublicApiRoute = (req) => {
  const method = String(req.method || '').toUpperCase();
  const path = String(req.path || req.url || '').split('?')[0];
  const originalUrl = String(req.originalUrl || '').split('?')[0];

  if (method === 'POST' && (path === '/auth/login' || originalUrl === '/api/auth/login')) {
    return true;
  }
  if (method === 'GET' && (path === '/health' || originalUrl === '/api/health')) {
    return true;
  }
  return false;
};

const extractBearerToken = (req) => {
  const header = req?.headers?.authorization || (typeof req?.get === 'function' ? req.get('authorization') : '');
  if (typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
};

const createAuthMiddleware = ({
  secretFn = () => env.SESSION_SECRET,
  nowSecondsFn = () => Math.floor(Date.now() / 1000)
} = {}) => {
  return (req, res, next) => {
    if (isPublicApiRoute(req)) {
      return next();
    }

    const token = extractBearerToken(req);
    const payload = token ? verifySessionToken(token, secretFn(), nowSecondsFn()) : null;

    if (!payload) {
      return res.status(401).json({
        success: false,
        message: INVALID_SESSION_MESSAGE
      });
    }

    req.user = payload;
    return next();
  };
};

const authMiddleware = createAuthMiddleware();

authMiddleware.authMiddleware = authMiddleware;
authMiddleware.createAuthMiddleware = createAuthMiddleware;
authMiddleware.verifySessionToken = verifySessionToken;
authMiddleware.generateSessionToken = generateSessionToken;
authMiddleware.extractBearerToken = extractBearerToken;
authMiddleware.INVALID_SESSION_MESSAGE = INVALID_SESSION_MESSAGE;

module.exports = authMiddleware;
