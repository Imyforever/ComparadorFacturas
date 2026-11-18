// Pruebas de caracterizacion del motor de conciliacion: fijan el comportamiento actual.
// Si un cambio las rompe, debe ser intencional y documentado.
const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcile, matchVendorName, normalizeText } = require('../src/services/reconciler');

const inv = (over = {}) => ({
  uuid: 'U1',
  emisor: 'Papeleria Lopez SA de CV',
  rfcEmisor: 'PLO010101AAA',
  fechaEmision: '2026-09-05',
  total: 1160,
  estadoSat: 'Vigente',
  efecto: 'Ingreso',
  ...over
});
const tx = (over = {}) => ({
  _id: 'T1',
  tipo: 'Retiro',
  monto: 1160,
  concepto: 'SPEI ENVIADO PAPELERIA LOPEZ',
  fecha: '06-SEP-2026',
  banco: 'BBVA',
  ...over
});

test('normalizeText quita acentos, signos y mayusculas', () => {
  assert.equal(normalizeText('  Ñandú, S.A. de C.V. '), 'nandu s a de c v');
  assert.equal(normalizeText(null), '');
});

test('matchVendorName usa palabras completas y omite stop words', () => {
  assert.equal(matchVendorName('Papeleria Lopez', 'SPEI PAPELERIA X'), true);
  assert.equal(matchVendorName('Rosa', 'PAGO BARROSA'), false);
  assert.equal(matchVendorName('Grupo Comercial Mexico', 'PAGO OXXO'), false);
});

test('factura con monto exacto queda Pagada y enlazada al retiro', () => {
  const r = reconcile([inv()], [tx()]);
  const [f] = r.reconciledInvoices;
  assert.equal(f.estadoPago, 'Pagada');
  assert.equal(f.pagoAsociado.movimientoId, 'T1');
  assert.equal(f.pagoAsociado.diferencia, 0);
  assert.equal(r.summary.pagadasCount, 1);
  assert.equal(r.unmatchedWithdrawals.length, 0);
});

test('centavos de diferencia: hasta 4 solo si el retiro identifica al proveedor', () => {
  const estado = (over) => reconcile([inv()], [tx(over)]).reconciledInvoices[0].estadoPago;
  // Con el nombre del proveedor en el concepto: acepta 1..4 centavos, rechaza 5
  for (const monto of [1159.99, 1160.01, 1159.96, 1160.04]) assert.equal(estado({ monto }), 'Pagada', String(monto));
  assert.equal(estado({ monto: 1160.05 }), 'No Pagada');
  assert.equal(estado({ monto: 1159.95 }), 'No Pagada');
  // Con el RFC en el concepto (con espacios, como lo imprime el banco)
  assert.equal(estado({ monto: 1160.02, concepto: 'TIENDA X RFC: PLO 010101AAA' }), 'Pagada');
  // Sin RFC ni nombre: solo exacto
  assert.equal(estado({ monto: 1160, concepto: 'PAGO TARJETA' }), 'Pagada');
  assert.equal(estado({ monto: 1160.01, concepto: 'PAGO TARJETA' }), 'No Pagada');
  // RFC detectado de otro proveedor
  assert.equal(estado({ monto: 1160.01, concepto: 'PAGO TARJETA', rfcDetectado: 'ZZZ010101ZZZ' }), 'No Pagada');
});

test('el monto exacto gana sobre uno con centavos de diferencia', () => {
  const r = reconcile([inv()], [tx({ _id: 'CASI', monto: 1160.01 }), tx({ _id: 'EXACTO', monto: 1160 })]);
  assert.equal(r.reconciledInvoices[0].pagoAsociado.movimientoId, 'EXACTO');
  const r2 = reconcile([inv()], [tx({ monto: 1160.03 })]);
  assert.equal(r2.reconciledInvoices[0].pagoAsociado.diferencia, 0.03);
});

test('depositos no se usan para pagar facturas', () => {
  const r = reconcile([inv()], [tx({ tipo: 'Deposito' })]);
  assert.equal(r.reconciledInvoices[0].estadoPago, 'No Pagada');
  assert.equal(r.summary.movimientosBancariosCount, 0);
});

test('canceladas, egresos, traslados y total 0 no consumen retiros', () => {
  const r = reconcile(
    [
      inv({ uuid: 'C', estadoSat: 'Cancelado' }),
      inv({ uuid: 'E', efecto: 'Egreso' }),
      inv({ uuid: 'T', efecto: 'Traslado' }),
      inv({ uuid: 'Z', total: 0 })
    ],
    [tx()]
  );
  assert.deepEqual(
    r.reconciledInvoices.map((i) => i.estadoPago),
    ['Cancelada', 'No Aplica', 'No Aplica', 'No Aplica']
  );
  assert.equal(r.summary.canceladasCount, 1);
  assert.equal(r.unmatchedWithdrawals.length, 1);
});

test('mismo importe: el RFC en el concepto gana sobre el orden de llegada', () => {
  const a = inv({ uuid: 'A', emisor: 'Proveedor Uno', rfcEmisor: 'AAA010101AAA' });
  const b = inv({ uuid: 'B', emisor: 'Proveedor Dos', rfcEmisor: 'BBB010101BBB' });
  const t1 = tx({ _id: 'X', concepto: 'PAGO BBB010101BBB' });
  const t2 = tx({ _id: 'Y', concepto: 'PAGO AAA010101AAA' });
  const r = reconcile([a, b], [t1, t2]);
  const byUuid = Object.fromEntries(r.reconciledInvoices.map((i) => [i.uuid, i.pagoAsociado.movimientoId]));
  assert.deepEqual(byUuid, { A: 'Y', B: 'X' });
});

test('un retiro no paga dos facturas', () => {
  const r = reconcile([inv({ uuid: 'A' }), inv({ uuid: 'B' })], [tx()]);
  assert.deepEqual(r.reconciledInvoices.map((i) => i.estadoPago).sort(), ['No Pagada', 'Pagada']);
});

test('desempate por cercania de fecha', () => {
  const r = reconcile([inv()], [tx({ _id: 'LEJOS', fecha: '30-NOV-2026' }), tx({ _id: 'CERCA', fecha: '07-SEP-2026' })]);
  assert.equal(r.reconciledInvoices[0].pagoAsociado.movimientoId, 'CERCA');
});

test('entradas invalidas no truenan', () => {
  const r = reconcile(null, undefined);
  assert.equal(r.summary.totalFacturas, 0);
  assert.deepEqual(r.reconciledInvoices, []);
});
