const test = require('node:test');
const assert = require('node:assert/strict');

const { toCents, fromCents, round2, sameAmount, diffAmount, sumAmounts, parseAmount } = require('../src/utils/money');
const { dateOnly, formatIsoDate } = require('../src/utils/dates');
const { normalizeText, matchVendorName, normUuid, isObjectId, computeHuellas, safeAsciiFileName } = require('../src/utils/text');
const { csvText, csvMoney, splitCsvLine, detectCsvDelimiter } = require('../src/utils/csv');

test('money: toCents, fromCents, round2 y sameAmount operan en centavos enteros sin errores IEEE 754', () => {
  assert.equal(toCents(1160.05), 116005);
  assert.equal(toCents('19.99'), 1999);
  assert.equal(toCents(null), 0);
  assert.equal(toCents('invalido'), 0);

  assert.equal(fromCents(116005), 1160.05);
  assert.equal(fromCents(0.1 * 100 + 0.2 * 100), 0.3);

  assert.equal(round2(0.1 + 0.2), 0.3);
  assert.equal(round2(10.005), 10.01);

  assert.equal(sameAmount(100, 100.001), true);
  assert.equal(sameAmount(1160, 1160.04, 4), true);
  assert.equal(sameAmount(1160, 1160.05, 4), false);
  assert.equal(sameAmount('abc', 100), false);

  assert.equal(diffAmount(1160.05, 1160), 0.05);
  assert.equal(sumAmounts([0.1, 0.2, 0.3]), 0.6);
  assert.equal(parseAmount('$ 12,345.67'), 12345.67);
  assert.ok(Number.isNaN(parseAmount('')));
});

test('dates: dateOnly y formatIsoDate formatean fechas consistentemente', () => {
  assert.equal(dateOnly('2026-09-15T14:22:00'), '2026-09-15');
  assert.equal(dateOnly(''), '');
  assert.equal(formatIsoDate(new Date(2026, 8, 5)), '2026-09-05T00:00:00');
});

test('text: normUuid, isObjectId, computeHuellas y safeAsciiFileName', () => {
  assert.equal(normUuid('  abc-123 '), 'ABC-123');
  assert.equal(isObjectId('507f1f77bcf86cd799439011'), true);
  assert.equal(isObjectId('no-es-object-id'), false);
  assert.equal(normalizeText('Café & Más, S.A.'), 'cafe mas s a');
  assert.equal(matchVendorName('Servicios Starlink Mexico', 'CARGO STARLINK INTERNET'), true);

  // Dos movimientos identicos el mismo dia reciben huellas distintas gracias al indice de ocurrencia
  const movs = [
    { fecha: '10-SEP-2026', tipo: 'Retiro', monto: 1724.24, concepto: 'STARLINK', cuenta: '123' },
    { fecha: '10-SEP-2026', tipo: 'Retiro', monto: 1724.24, concepto: 'STARLINK', cuenta: '123' }
  ];
  const huellas = computeHuellas(movs);
  assert.equal(huellas.length, 2);
  assert.notEqual(huellas[0], huellas[1]);

  assert.equal(safeAsciiFileName('Conciliación_Niño_2026-09.csv'), 'Conciliacion_Nino_2026-09.csv');
});

test('csv: csvText escapa comillas y neutraliza inyeccion de formulas (=, +, -, @)', () => {
  assert.equal(csvText('Proveedor "El Sol", S.A.'), '"Proveedor ""El Sol"", S.A."');
  assert.equal(csvText('=CMD|" /C calc"!A0'), '"\'=CMD|"" /C calc""!A0"');
  assert.equal(csvText('+SUM(A1:A2)'), '"\'+SUM(A1:A2)"');
  assert.equal(csvText('-100+200'), '"\'-100+200"');
  assert.equal(csvText('@IMPORT'), '"\'@IMPORT"');
  assert.equal(csvText(null), '""');

  assert.equal(csvMoney(1234.5), '1234.50');
  assert.equal(csvMoney(''), '');

  assert.deepEqual(splitCsvLine('"Hola, mundo",123,"Con ""comillas"""'), ['Hola, mundo', '123', 'Con "comillas"']);
  assert.equal(detectCsvDelimiter(['a;b;c', '1;2;3']), ';');
});
