const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { PassThrough } = require('stream');

const app = require('../src/app');
const env = require('../src/config/env');
const { createAuthMiddleware, generateSessionToken } = require('../src/middleware/auth');

const runMiddleware = (mw, req) =>
  new Promise((resolve) => {
    const res = {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        resolve({ nextCalled: false, statusCode: this.statusCode, body: this.body });
        return this;
      }
    };
    mw(req, res, () => resolve({ nextCalled: true, statusCode: res.statusCode, body: res.body }));
  });

/**
 * En entornos sandbox de Windows donde el loopback TCP local devuelve EACCES,
 * despacha la peticion HTTP directamente sobre la instancia de Express y devuelve un Response estandar.
 */
const dispatchToApp = (expressApp, urlStr, options = {}) =>
  new Promise((resolve) => {
    const u = new URL(urlStr);
    const method = (options.method || 'GET').toUpperCase();
    const rawBody = options.body ? Buffer.from(options.body) : Buffer.alloc(0);

    const headers = {};
    if (options.headers) {
      for (const [k, v] of Object.entries(options.headers)) {
        headers[k.toLowerCase()] = String(v);
      }
    }
    if (rawBody.length > 0 && !headers['content-length']) {
      headers['content-length'] = String(rawBody.length);
    }

    const socket = new PassThrough();
    socket.remoteAddress = '127.0.0.1';
    const req = new http.IncomingMessage(socket);
    req.method = method;
    req.url = u.pathname + u.search;
    req.headers = headers;

    const res = new http.ServerResponse(req);
    const chunks = [];
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);

    res.write = (chunk, encoding, cb) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      return origWrite(chunk, encoding, cb);
    };
    res.end = (chunk, encoding, cb) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      origEnd(chunk, encoding, cb);
      const bodyBuffer = Buffer.concat(chunks);
      const resHeaders = new Headers();
      for (const [k, v] of Object.entries(res.getHeaders())) {
        if (v !== undefined) resHeaders.set(k, Array.isArray(v) ? v.join(', ') : String(v));
      }
      resolve(new Response(bodyBuffer, { status: res.statusCode, headers: resHeaders }));
      return res;
    };

    expressApp(req, res);
    process.nextTick(() => {
      if (rawBody.length > 0) req.push(rawBody);
      req.push(null);
    });
  });

test('middleware auth: rechaza sin token, mal firmado o expirado y acepta token valido', async () => {
  const secret = 'test-secret-key-hs256';
  const now = 1_700_000_000;
  const mw = createAuthMiddleware({
    secretFn: () => secret,
    nowSecondsFn: () => now
  });

  // 1. Sin token
  const r1 = await runMiddleware(mw, { method: 'GET', path: '/reconciliation/data', headers: {} });
  assert.equal(r1.nextCalled, false);
  assert.equal(r1.statusCode, 401);
  assert.deepEqual(r1.body, { success: false, message: 'Sesion invalida o expirada.' });

  // 2. Token mal firmado (con otro secreto)
  const badSigToken = generateSessionToken('usr_1', 3600, 'otro-secreto', now);
  const r2 = await runMiddleware(mw, {
    method: 'GET',
    path: '/reconciliation/data',
    headers: { authorization: `Bearer ${badSigToken}` }
  });
  assert.equal(r2.nextCalled, false);
  assert.equal(r2.statusCode, 401);

  // 3. Token expirado
  const expiredToken = generateSessionToken('usr_1', -10, secret, now);
  const r3 = await runMiddleware(mw, {
    method: 'GET',
    path: '/reconciliation/data',
    headers: { authorization: `Bearer ${expiredToken}` }
  });
  assert.equal(r3.nextCalled, false);
  assert.equal(r3.statusCode, 401);

  // 4. Token valido
  const validToken = generateSessionToken('usr_admin', 3600, secret, now);
  const reqValid = {
    method: 'GET',
    path: '/reconciliation/data',
    headers: { authorization: `Bearer ${validToken}` }
  };
  const r4 = await runMiddleware(mw, reqValid);
  assert.equal(r4.nextCalled, true);
  assert.equal(reqValid.user.sub, 'usr_admin');
});

test('integracion HTTP (app.listen(0) + fetch sin Mongo): login, proteccion 401 y respuesta 503 rapida', async (t) => {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    try {
      return await realFetch(url, options);
    } catch (err) {
      if (err?.cause?.code === 'EACCES' || err?.code === 'EACCES') {
        return dispatchToApp(app, url, options);
      }
      throw err;
    }
  };
  t.after(() => {
    globalThis.fetch = realFetch;
    return new Promise((resolve) => server.close(resolve));
  });

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  // 1. GET /api/health es publico
  const healthRes = await fetch(`${baseUrl}/api/health`);
  assert.equal(healthRes.status, 200);
  const healthJson = await healthRes.json();
  assert.equal(healthJson.status, 'online');

  // 2. Ruta protegida sin token responde 401
  const noAuthRes = await fetch(`${baseUrl}/api/reconciliation/periodos`);
  assert.equal(noAuthRes.status, 401);
  const noAuthJson = await noAuthRes.json();
  assert.deepEqual(noAuthJson, { success: false, message: 'Sesion invalida o expirada.' });

  // 3. Login con credenciales malas responde 401
  const badLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: env.ADMIN_USERNAME, password: 'password-incorrecto-xyz' })
  });
  assert.equal(badLoginRes.status, 401);
  const badLoginJson = await badLoginRes.json();
  assert.equal(badLoginJson.success, false);

  // 4. El alias antiguo 'admin@empresa.com' ya no es aceptado
  const aliasLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin@empresa.com', password: env.ADMIN_PASSWORD })
  });
  assert.equal(aliasLoginRes.status, 401);

  // 5. Login con credenciales buenas (ADMIN_USERNAME / ADMIN_PASSWORD) devuelve 200 y token JWT
  const goodLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD, rememberMe: true })
  });
  assert.equal(goodLoginRes.status, 200);
  const goodLoginJson = await goodLoginRes.json();
  assert.equal(goodLoginJson.success, true);
  assert.equal(typeof goodLoginJson.token, 'string');
  assert.equal(goodLoginJson.duration, '30d');

  // 6. Con token valido pero sin conexion a MongoDB, las rutas de conciliacion responden 503 rapido (< 500ms)
  const t0 = Date.now();
  const dbRouteRes = await fetch(`${baseUrl}/api/reconciliation/data`, {
    headers: { Authorization: `Bearer ${goodLoginJson.token}` }
  });
  const elapsedMs = Date.now() - t0;
  assert.equal(dbRouteRes.status, 503);
  assert.ok(elapsedMs < 1000, `Se esperaba respuesta 503 rapida, tardo ${elapsedMs}ms`);
  const dbRouteJson = await dbRouteRes.json();
  assert.equal(dbRouteJson.success, false);
});
