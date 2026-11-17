const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFlexibleDate, resolveYearForMonth, PERIODO_REGEX } = require('../src/utils/dates');

const ymd = (d) => (d ? [d.getFullYear(), d.getMonth() + 1, d.getDate()] : null);

test('parseFlexibleDate soporta los formatos de bancos y SAT', () => {
  assert.deepEqual(ymd(parseFlexibleDate('06-SEP-2026')), [2026, 9, 6]);
  assert.deepEqual(ymd(parseFlexibleDate('06/sep/26')), [2026, 9, 6]);
  assert.deepEqual(ymd(parseFlexibleDate('2026-09-05T12:30:00')), [2026, 9, 5]);
  assert.deepEqual(ymd(parseFlexibleDate('2026/9/5')), [2026, 9, 5]);
  assert.deepEqual(ymd(parseFlexibleDate('05/09/2026')), [2026, 9, 5]);
});

test('parseFlexibleDate rechaza valores invalidos', () => {
  for (const v of [null, '', 'hola', '32/01/2026', '2026-13-01', '01-XYZ-2026']) {
    assert.equal(parseFlexibleDate(v), null, String(v));
  }
});

test('resolveYearForMonth cruza diciembre/enero', () => {
  assert.equal(resolveYearForMonth(2027, 1, 12, 'end'), 2026);
  assert.equal(resolveYearForMonth(2026, 12, 1, 'start'), 2027);
  assert.equal(resolveYearForMonth(2026, 9, 9, 'end'), 2026);
});

test('PERIODO_REGEX acepta AAAA-MM', () => {
  assert.ok(PERIODO_REGEX.test('2026-09'));
  assert.ok(!PERIODO_REGEX.test('2026-13'));
  assert.ok(!PERIODO_REGEX.test('26-09'));
});
