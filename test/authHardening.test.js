const test = require('node:test');
const assert = require('node:assert/strict');
const { createAuthService, isStrongAdminPassword } = require('../src/services/authService');
const { createLoginRateLimit } = require('../src/middleware/loginRateLimit');

const noDbRepo = { isConnected: () => false, findByUsername: async () => null, create: async () => {} };
const cfg = (pwd) => ({ ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: pwd, SESSION_SECRET: 's' });

test('isStrongAdminPassword rechaza vacias, cortas y comunes', () => {
  for (const p of ['', 'admin', 'ADMIN', 'corta', 'administrador', undefined]) assert.equal(isStrongAdminPassword(p), false, String(p));
  assert.equal(isStrongAdminPassword('Xk9!pLq2vR7m'), true);
});

test('acceso de respaldo sin BD desactivado si ADMIN_PASSWORD falta o es debil', async () => {
  for (const pwd of ['', 'admin']) {
    const svc = createAuthService({ userRepo: noDbRepo, config: cfg(pwd) });
    await assert.rejects(svc.login({ username: 'admin', password: pwd || 'admin' }), { status: 401 });
  }
});

test('acceso de respaldo funciona con ADMIN_PASSWORD robusta', async () => {
  const svc = createAuthService({ userRepo: noDbRepo, config: cfg('Xk9!pLq2vR7m') });
  const r = await svc.login({ username: 'admin', password: 'Xk9!pLq2vR7m' });
  assert.equal(r.success, true);
});

test('no se crea usuario admin con contrasena debil', async () => {
  let created = false;
  const repo = { isConnected: () => true, findByUsername: async () => null, create: async () => { created = true; } };
  await createAuthService({ userRepo: repo, config: cfg('admin') }).ensureAdminUser();
  assert.equal(created, false);
});

// Simula una peticion: devuelve { status, finish } — finish() emite 'finish' con el estado indicado
const makeCall = (mw) => (status, { ip = '1.1.1.1', username = 'admin', finish = true } = {}) => {
  const handlers = {};
  const res = {
    statusCode: status,
    set() {},
    status(c) { this.statusCode = c; return this; },
    json() { return this; },
    on(ev, fn) { handlers[ev] = fn; }
  };
  let passed = false;
  mw({ ip, body: { username } }, res, () => { passed = true; });
  if (passed && finish) handlers.finish();
  return passed ? status : res.statusCode;
};

test('rate limit: 429 tras demasiados fallos y se reinicia al expirar la ventana', () => {
  let t = 0;
  const call = makeCall(createLoginRateLimit({ windowMs: 1000, maxAttempts: 2, now: () => t }));
  assert.equal(call(401), 401);
  assert.equal(call(401), 401);
  assert.equal(call(200), 429);
  t = 2000;
  assert.equal(call(200), 200);
});

test('rate limit: peticiones en paralelo (sin terminar) cuentan desde el inicio', () => {
  const call = makeCall(createLoginRateLimit({ maxAttempts: 2 }));
  assert.equal(call(401, { finish: false }), 401);
  assert.equal(call(401, { finish: false }), 401);
  assert.equal(call(401, { finish: false }), 429);
});

test('rate limit: un exito en otra cuenta no borra los fallos acumulados', () => {
  const call = makeCall(createLoginRateLimit({ maxAttempts: 3 }));
  call(401, { username: 'victima' });
  call(401, { username: 'victima' });
  assert.equal(call(200, { username: 'propia' }), 200);
  assert.equal(call(401, { username: 'victima' }), 401);
  assert.equal(call(401, { username: 'victima' }), 429);
});

test('rate limit: el limite por usuario aplica aunque cambie la IP', () => {
  const call = makeCall(createLoginRateLimit({ maxAttempts: 2 }));
  call(401, { ip: '1.1.1.1' });
  call(401, { ip: '2.2.2.2' });
  assert.equal(call(401, { ip: '3.3.3.3' }), 429);
});
