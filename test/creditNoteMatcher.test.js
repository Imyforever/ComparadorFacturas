const test = require('node:test');
const assert = require('node:assert/strict');
const { matchPartialCreditNotes } = require('../src/services/creditNoteMatcher');

const makeInvoice = (over = {}) => ({
  uuid: 'INV-100',
  emisor: 'Papeleria Lopez SA de CV',
  rfcEmisor: 'PLO010101AAA',
  fechaEmision: '2026-09-05',
  total: 100,
  estadoSat: 'Vigente',
  efecto: 'Ingreso',
  estadoPago: 'No Pagada',
  egresoAsociado: null,
  rechazoAsignacionAutomatica: false,
  ...over
});

const makeNote = (over = {}) => ({
  uuid: 'NC-10',
  emisor: 'Papeleria Lopez SA de CV',
  rfcEmisor: 'PLO010101AAA',
  fechaEmision: '2026-09-06',
  total: 10,
  estadoSat: 'Vigente',
  efecto: 'Egreso',
  ingresoAsociado: null,
  ...over
});

const makeWithdrawal = (over = {}) => ({
  _id: 'MOV-90',
  tipo: 'Retiro',
  monto: 90,
  concepto: 'SPEI ENVIADO PAPELERIA LOPEZ',
  fecha: '07-SEP-2026',
  banco: 'BBVA',
  ...over
});

test('matcher: ejemplo 100 - 10 = 90 asigna factura, nota y retiro', () => {
  const result = matchPartialCreditNotes([makeInvoice()], [makeNote()], [makeWithdrawal()]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], {
    invoiceUuid: 'INV-100',
    creditNoteUuid: 'NC-10',
    movementId: 'MOV-90',
    montoNota: 10,
    montoRetiro: 90,
    diferencia: 0
  });
});

test('matcher: solo coincidencia exacta al centavo', () => {
  // 100 - 10 = 90 exacto -> asocia
  const ok = matchPartialCreditNotes([makeInvoice()], [makeNote()], [makeWithdrawal({ monto: 90 })]);
  assert.equal(ok.length, 1);
  assert.equal(ok[0].diferencia, 0);

  // 1 centavo de diferencia hacia cualquier lado -> NO asocia
  for (const monto of [89.99, 90.01, 89.96, 90.04]) {
    assert.equal(matchPartialCreditNotes([makeInvoice()], [makeNote()], [makeWithdrawal({ monto })]).length, 0, String(monto));
  }
});

test('matcher: RFC distinto entre factura y nota no asigna', () => {
  const result = matchPartialCreditNotes(
    [makeInvoice({ rfcEmisor: 'AAA010101AAA' })],
    [makeNote({ rfcEmisor: 'BBB010101BBB' })],
    [makeWithdrawal()]
  );
  assert.equal(result.length, 0);
});

test('matcher: nota mayor o igual que la factura no aplica (eso lo cubre el flujo 100%)', () => {
  const equalNote = matchPartialCreditNotes(
    [makeInvoice({ total: 100 })],
    [makeNote({ total: 100 })],
    [makeWithdrawal({ monto: 0.01 })]
  );
  assert.equal(equalNote.length, 0);

  const greaterNote = matchPartialCreditNotes(
    [makeInvoice({ total: 100 })],
    [makeNote({ total: 120 })],
    [makeWithdrawal({ monto: 20 })]
  );
  assert.equal(greaterNote.length, 0);
});

test('matcher: nota cancelada o ya asociada no aplica; factura rechazada no aplica', () => {
  const canceledNote = matchPartialCreditNotes(
    [makeInvoice()],
    [makeNote({ estadoSat: 'Cancelado' })],
    [makeWithdrawal()]
  );
  assert.equal(canceledNote.length, 0);

  const usedNote = matchPartialCreditNotes(
    [makeInvoice()],
    [makeNote({ ingresoAsociado: { uuid: 'OTRA-FACTURA' } })],
    [makeWithdrawal()]
  );
  assert.equal(usedNote.length, 0);

  const rejectedInv = matchPartialCreditNotes(
    [makeInvoice({ rechazoAsignacionAutomatica: true })],
    [makeNote()],
    [makeWithdrawal()]
  );
  assert.equal(rejectedInv.length, 0);
});

test('matcher: nota o retiro no se reutilizan y solo una nota por factura', () => {
  // Dos facturas de $100, una sola nota de $10, dos retiros de $90 -> solo 1 asignacion
  const res1 = matchPartialCreditNotes(
    [makeInvoice({ uuid: 'INV-A' }), makeInvoice({ uuid: 'INV-B' })],
    [makeNote({ uuid: 'NC-UNICA' })],
    [makeWithdrawal({ _id: 'MOV-1' }), makeWithdrawal({ _id: 'MOV-2' })]
  );
  assert.equal(res1.length, 1);

  // Dos facturas de $100, dos notas de $10, un solo retiro de $90 -> solo 1 asignacion
  const res2 = matchPartialCreditNotes(
    [makeInvoice({ uuid: 'INV-A' }), makeInvoice({ uuid: 'INV-B' })],
    [makeNote({ uuid: 'NC-1' }), makeNote({ uuid: 'NC-2' })],
    [makeWithdrawal({ _id: 'MOV-UNICO' })]
  );
  assert.equal(res2.length, 1);

  // Una factura de $100, dos notas de $10 -> solo usa una nota para esa factura
  const res3 = matchPartialCreditNotes(
    [makeInvoice({ uuid: 'INV-UNICA' })],
    [makeNote({ uuid: 'NC-1' }), makeNote({ uuid: 'NC-2' })],
    [makeWithdrawal({ _id: 'MOV-1' }), makeWithdrawal({ _id: 'MOV-2' })]
  );
  assert.equal(res3.length, 1);
  assert.equal(res3[0].invoiceUuid, 'INV-UNICA');
});

test('matcher: dos facturas compitiendo por el mismo retiro -> gana la de mejor puntaje (RFC > nombre > fecha)', () => {
  // Competencia por RFC en el concepto del retiro
  const invSinRfcEnBanco = makeInvoice({
    uuid: 'INV-1',
    emisor: 'Proveedor Uno',
    rfcEmisor: 'AAA010101AAA',
    total: 100
  });
  const invConRfcEnBanco = makeInvoice({
    uuid: 'INV-2',
    emisor: 'Proveedor Dos',
    rfcEmisor: 'BBB010101BBB',
    total: 100
  });
  const nc1 = makeNote({ uuid: 'NC-1', rfcEmisor: 'AAA010101AAA', total: 10 });
  const nc2 = makeNote({ uuid: 'NC-2', rfcEmisor: 'BBB010101BBB', total: 10 });
  const movConRfcB = makeWithdrawal({
    _id: 'MOV-90',
    monto: 90,
    concepto: 'PAGO FACTURA BBB010101BBB'
  });

  const resRfc = matchPartialCreditNotes([invSinRfcEnBanco, invConRfcEnBanco], [nc1, nc2], [movConRfcB]);
  assert.equal(resRfc.length, 1);
  assert.equal(resRfc[0].invoiceUuid, 'INV-2');
  assert.equal(resRfc[0].creditNoteUuid, 'NC-2');

  // Desempate por cercania de fecha cuando mismo proveedor tiene dos facturas
  const invLejos = makeInvoice({ uuid: 'INV-LEJOS', fechaEmision: '2026-08-01', total: 100 });
  const invCerca = makeInvoice({ uuid: 'INV-CERCA', fechaEmision: '2026-09-06', total: 100 });
  const ncUnica = makeNote({ uuid: 'NC-1', total: 10 });
  const mov = makeWithdrawal({ _id: 'MOV-90', fecha: '07-SEP-2026', monto: 90 });

  const resFecha = matchPartialCreditNotes([invLejos, invCerca], [ncUnica], [mov]);
  assert.equal(resFecha.length, 1);
  assert.equal(resFecha[0].invoiceUuid, 'INV-CERCA');
});

test('matcher: determinismo en multiples corridas y orden de entrada', () => {
  const invoices = [
    makeInvoice({ uuid: 'INV-1', rfcEmisor: 'AAA010101AAA', total: 500, fechaEmision: '2026-09-02' }),
    makeInvoice({ uuid: 'INV-2', rfcEmisor: 'BBB010101BBB', total: 300, fechaEmision: '2026-09-04' }),
    makeInvoice({ uuid: 'INV-3', rfcEmisor: 'AAA010101AAA', total: 500, fechaEmision: '2026-09-10' })
  ];
  const notes = [
    makeNote({ uuid: 'NC-A1', rfcEmisor: 'AAA010101AAA', total: 50 }),
    makeNote({ uuid: 'NC-B1', rfcEmisor: 'BBB010101BBB', total: 30 })
  ];
  const withdrawals = [
    makeWithdrawal({ _id: 'M-450', monto: 450, fecha: '03-SEP-2026', concepto: 'SPEI AAA010101AAA' }),
    makeWithdrawal({ _id: 'M-270', monto: 270, fecha: '05-SEP-2026', concepto: 'SPEI BBB010101BBB' })
  ];

  const run1 = matchPartialCreditNotes(invoices, notes, withdrawals);
  const run2 = matchPartialCreditNotes(invoices, notes, withdrawals);
  const run3Reversed = matchPartialCreditNotes(
    [...invoices].reverse(),
    [...notes].reverse(),
    [...withdrawals].reverse()
  );

  assert.deepEqual(run1, run2);
  assert.deepEqual(run1, run3Reversed);
  assert.equal(run1.length, 2);
});
