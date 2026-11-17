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

test('rate limit: 429 tras demasiados 401 y se reinicia al expirar la ventana', () => {
  let t = 0;
  const mw = createLoginRateLimit({ windowMs: 1000, maxFailures: 2, now: () => t });
  const call = (status) => {
    const handlers = {};
    const res = {
      statusCode: status,
      set() {},
      status(c) { this.statusCode = c; return this; },
      json() { return this; },
      on(ev, fn) { handlers[ev] = fn; }
    };
    let passed = false;
    mw({ ip: '1.1.1.1' }, res, () => { passed = true; });
    if (passed) handlers.finish();
    return passed ? status : res.statusCode;
  };
  assert.equal(call(401), 401);
  assert.equal(call(401), 401);
  assert.equal(call(200), 429);
  t = 2000;
  assert.equal(call(200), 200);
});
