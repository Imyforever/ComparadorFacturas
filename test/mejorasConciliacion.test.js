// Mejoras de conciliacion: alias aprendidos, redondeo a peso, comisiones del banco, mes anterior,
// pagos conjuntos, limpieza de conceptos y duplicados entre archivos.
const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcile } = require('../src/services/reconciler');
const { learnVendorAliases, extractConceptTokens } = require('../src/services/vendorAliases');
const { previousPeriodo, selectPreviousMonthMovements } = require('../src/services/previousMonth');
const { matchJointPayments } = require('../src/services/jointPaymentMatcher');
const { matchPartialCreditNotes } = require('../src/services/creditNoteMatcher');
const { findDuplicatesOfExisting } = require('../src/services/duplicateDetector');
const { cleanBankConcept, isBankFeeConcept } = require('../src/utils/text');

const inv = (over = {}) => ({
  uuid: 'U1',
  emisor: 'Productos de Harina SA de CV',
  rfcEmisor: 'PHA820319Q36',
  fechaEmision: '2026-09-17',
  total: 2034.81,
  estadoSat: 'Vigente',
  efecto: 'Ingreso',
  ...over
});
const tx = (over = {}) => ({
  _id: 'T1',
  tipo: 'Retiro',
  monto: 2034.81,
  concepto: '17 SEP SWEB TRANSF.INTERB SPEI 0000 BANAMEX 10004378 /69241228',
  fecha: '17-SEP-2026',
  banco: 'Scotiabank',
  ...over
});
const paid = (uuid, rfc, concepto, movimientoId, diferencia = 0) => ({
  uuid,
  rfcEmisor: rfc,
  estadoPago: 'Pagada',
  pagoAsociado: { movimientoId, conceptoBanco: concepto, diferencia }
});
const estado = (r) => r.reconciledInvoices[0].estadoPago;

test('alias: aprende un token visto en 2 pagos del mismo RFC y descarta los compartidos o vistos 1 vez', () => {
  const aliases = learnVendorAliases([
    paid('A', 'PHA820319Q36', 'SPEI BANAMEX 10004378 REF. 0029124613', 'm1'),
    paid('B', 'PHA820319Q36', 'SPEI BANAMEX 10004378 REF. 0029124613', 'm2'),
    paid('C', 'NWM9709244W4', 'BODEGA REF. 0029124613 RFC NWM 9709244W4', 'm3'),
    paid('D', 'BPU7901018D4', 'HSBC 2052000053164', 'm4'),
    // diferencia distinta de 0 y comisiones del banco no ensenan
    paid('E', 'BPU7901018D4', 'HSBC 2052000053164', 'm5', 0.01),
    paid('F', 'BIM011108DJ5', 'APLI TASA DE DES DEBITO 174516475 TERMINALES PUNTO DE VENTA', 'm6'),
    paid('G', 'BIM011108DJ5', 'APLI TASA DE DES CREDITO 174516475 TERMINALES PUNTO DE VENTA', 'm7')
  ]);
  assert.deepEqual([...(aliases.get('PHA820319Q36') || [])], ['10004378']);
  assert.equal(aliases.has('BPU7901018D4'), false);
  assert.equal(aliases.has('BIM011108DJ5'), false);
  assert.ok(extractConceptTokens('RFC: PLA 120807BK0').has('PLA120807BK0'));
});

test('alias habilita diferencia de centavos; sin alias solo exacto', () => {
  const aliases = new Map([['PHA820319Q36', new Set(['10004378'])]]);
  assert.equal(estado(reconcile([inv()], [tx({ monto: 2034.82 })], { aliases })), 'Pagada');
  assert.equal(estado(reconcile([inv()], [tx({ monto: 2034.82 })])), 'No Pagada');
});

test('redondeo a peso: solo con proveedor identificado y retiro en pesos cerrados', () => {
  const bep = inv({ emisor: 'Embotelladoras Bepensa', rfcEmisor: 'EBE7711037Y5', total: 2178.5 });
  const concepto = 'BPK*MISC BEPENSA ******2544 RFC: PLA 120807BK0';
  assert.equal(estado(reconcile([bep], [tx({ monto: 2178, concepto })])), 'Pagada');
  assert.equal(estado(reconcile([bep], [tx({ monto: 2178, concepto: 'SPEI ENVIADO 0001' })])), 'No Pagada');
  // retiro con centavos a mas de 4 centavos: no es redondeo a peso
  assert.equal(estado(reconcile([bep], [tx({ monto: 2178.2, concepto })])), 'No Pagada');
  // el exacto gana sobre el redondeo
  const r = reconcile([bep], [tx({ _id: 'RED', monto: 2178, concepto }), tx({ _id: 'EXA', monto: 2178.5, concepto })]);
  assert.equal(r.reconciledInvoices[0].pagoAsociado.movimientoId, 'EXA');
});

test('comisiones del banco no pagan facturas sin proveedor identificado (ni exactas)', () => {
  const bimbo = inv({ emisor: 'Bimbo', rfcEmisor: 'BIM011108DJ5', total: 41.5 });
  const fee = tx({ monto: 41.5, concepto: 'APLI TASA DE DES DEBITO 174516475 TERMINALES PUNTO DE VENTA' });
  assert.equal(isBankFeeConcept(fee.concepto), true);
  assert.equal(estado(reconcile([bimbo], [fee])), 'No Pagada');
  // tampoco via nota de credito parcial: 100 - 58.50 = 41.50 contra una comision
  const factura = { ...bimbo, uuid: 'F', total: 100, estadoPago: 'No Pagada' };
  const nota = { uuid: 'NC', rfcEmisor: 'BIM011108DJ5', emisor: 'Bimbo', total: 58.5, efecto: 'Egreso', estadoSat: 'Vigente' };
  assert.equal(matchPartialCreditNotes([factura], [nota], [fee]).length, 0);
});

test('mes anterior: periodo previo, no roba retiros de su propio mes y solo casa con proveedor', () => {
  assert.equal(previousPeriodo('2026-01'), '2025-12');
  assert.equal(previousPeriodo('2026-09'), '2026-08');

  const candidates = [
    { _id: 'L', tipo: 'Retiro', monto: 2247.5, conciliado: false },
    { _id: 'P', tipo: 'Retiro', monto: 500, conciliado: false },
    { _id: 'C', tipo: 'Retiro', monto: 300, conciliado: true, facturaUuid: 'OTRA' }
  ];
  const sel = selectPreviousMonthMovements({ candidates, previousInvoices: [{ total: 500 }] });
  assert.deepEqual(sel.map((m) => m._id), ['L']);
  assert.equal(sel[0].mesAnterior, true);

  const wal = inv({ emisor: 'Nueva Wal Mart de Mexico', rfcEmisor: 'NWM9709244W4', total: 2247.5 });
  const conRfc = tx({ monto: 2247.5, concepto: 'BODEGA A CHETUMAL RFC NWM 9709244W4', mesAnterior: true });
  const sinRfc = tx({ monto: 2247.5, concepto: 'SPEI ENVIADO 0001', mesAnterior: true });
  assert.equal(estado(reconcile([wal], [conRfc])), 'Pagada');
  assert.equal(estado(reconcile([wal], [sinRfc])), 'No Pagada');
  // los retiros del mes anterior no cuentan como "sin factura" del mes
  assert.equal(reconcile([], [sinRfc]).unmatchedWithdrawals.length, 0);
});

test('pago conjunto: 2 o 3 facturas del mismo proveedor que suman exacto un retiro identificado', () => {
  const f = (uuid, total) => inv({ uuid, total, emisor: 'Mondelez Mexico', rfcEmisor: 'KFM920615PS8', estadoPago: 'No Pagada' });
  const retiro = (monto, concepto = 'MONDELEZ MEXICO S DE GUIA:7380821') => ({ _id: 'M', tipo: 'Retiro', monto, concepto, fecha: '10-OCT-2026' });

  const dos = matchJointPayments({ invoices: [f('A', 759.1), f('B', 180), f('C', 55)], withdrawals: [retiro(939.1)] });
  assert.equal(dos.length, 1);
  assert.deepEqual(dos[0].invoices.map((i) => i.uuid), ['A', 'B']);

  const tres = matchJointPayments({ invoices: [f('A', 100), f('B', 200), f('C', 300.5)], withdrawals: [retiro(600.5)] });
  assert.equal(tres.length, 1);
  assert.equal(tres[0].invoices.length, 3);

  // ambiguo: 100+200 y 150+150 suman 300 -> no asigna
  const amb = matchJointPayments({ invoices: [f('A', 100), f('B', 200), f('C', 150), f('D', 150)], withdrawals: [retiro(300)] });
  assert.equal(amb.length, 0);

  // sin proveedor identificado en el retiro -> no asigna
  const sinProv = matchJointPayments({ invoices: [f('A', 759.1), f('B', 180)], withdrawals: [retiro(939.1, 'PAGO CUENTA DE TERCERO 0019588729')] });
  assert.equal(sinProv.length, 0);
});

test('cleanBankConcept quita la basura de pagina del PDF', () => {
  const sucio =
    '07 SEP SWEB TRANSF.INTERB SPEI $967.35 BANAMEX ABARROTES LORENA /33220494 09:49:54 -- 2 of 18 -- 021659 Detalle de tus movimientos 2026090540044B36L0000492559406 FECHA OPERACION:';
  const limpio = cleanBankConcept(sucio);
  assert.ok(!/of 18|Detalle de tus movimientos/i.test(limpio), limpio);
  assert.ok(limpio.includes('BANAMEX ABARROTES LORENA'));

  const legal =
    '07 SEP DUNOSUSA CARIBE $1,711.50 "Para los efectos del art. 100 de la Ley de Instituciones de Crédito, se hace constar que la presente impresión proviene de medios magnéticos';
  assert.ok(!/Ley de Instituciones/i.test(cleanBankConcept(legal)));
  assert.ok(cleanBankConcept(legal).includes('DUNOSUSA CARIBE'));
});

test('duplicados: el mismo movimiento en otro archivo de la misma cuenta se detecta', () => {
  const existing = [{ _id: 'E1', fecha: '05-OCT-2026', tipo: 'Retiro', monto: 5000, saldo: 63179.36, cuenta: '25601064912' }];
  const nuevos = [
    { fecha: '05-OCT-2026', tipo: 'Retiro', monto: 5000, saldo: 63179.36, cuenta: '25601064912' },
    { fecha: '05-OCT-2026', tipo: 'Retiro', monto: 5000, saldo: 99999, cuenta: '25601064912' },
    { fecha: '06-OCT-2026', tipo: 'Retiro', monto: 5000, saldo: 63179.36, cuenta: '25601064912' }
  ];
  const r = findDuplicatesOfExisting(nuevos, existing);
  assert.equal(String(r[0]), 'E1');
  assert.equal(r[1], null);
  assert.equal(r[2], null);
});
