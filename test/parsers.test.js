const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyBBVAMovementIsRetiro } = require('../src/parsers/bbva/classify');
const cfdiReportParser = require('../src/parsers/sat/cfdiReport');
const bbvaStatementParser = require('../src/parsers/bbva/statement');
const bbvaDetalleWebParser = require('../src/parsers/bbva/detalleWeb');
const bbvaCreditCardParser = require('../src/parsers/bbva/creditCard');
const scotiabankStatementParser = require('../src/parsers/scotiabank/statement');
const scotiabankCreditCardParser = require('../src/parsers/scotiabank/creditCard');
const csvParser = require('../src/parsers/csv');
const registry = require('../src/parsers/registry');

test('classifyBBVAMovementIsRetiro distingue codigos de cargo, abono, N06 y conceptos sin codigo', () => {
  assert.equal(classifyBBVAMovementIsRetiro('T17 SPEI ENVIADO BANORTE', 'T17'), true);
  assert.equal(classifyBBVAMovementIsRetiro('T20 SPEI RECIBIDO SANTANDER', 'T20'), false);
  assert.equal(classifyBBVAMovementIsRetiro('C02 DEPOSITO EN VENTANILLA'), false);

  // N06: cliente (abono) vs pago a proveedor/factura/cotizacion (cargo)
  assert.equal(classifyBBVAMovementIsRetiro('N06 PAGO CUENTA DE TERCERO CLIENTE INTERNET', 'N06'), false);
  assert.equal(classifyBBVAMovementIsRetiro('N06 PAGO CUENTA DE TERCERO FACTURA 102', 'N06'), true);
  assert.equal(classifyBBVAMovementIsRetiro('N06 PAGO CUENTA DE TERCERO COT 554', 'N06'), true);

  // Sin codigo de 3 caracteres
  assert.equal(classifyBBVAMovementIsRetiro('VENTAS CREDITO TPV'), false);
  assert.equal(classifyBBVAMovementIsRetiro('SPEI RECIBIDO BANREGIO'), false);
  assert.equal(classifyBBVAMovementIsRetiro('DEPOSITO EN EFECTIVO'), false);
  assert.equal(classifyBBVAMovementIsRetiro('STARLINK MEXICO ******1234'), true);
});

test('parser SAT CFDI extrae facturas vigentes/canceladas, efectos y montos con comas sin confundir SubTotal', async () => {
  const sampleText = `
    Folio Fiscal: 11111111-2222-3333-4444-555555555555
    RFC Emisor: PLO010101AAA Nombre o Razón Social: PAPELERIA LOPEZ SA DE CV
    RFC Receptor: XAXX010101000 Nombre o Razón Social: PUBLICO EN GENERAL
    Fecha Emisión: 2026-09-10T12:00:00
    Fecha Certificación: 2026-09-10T12:01:00
    SubTotal: $10,000.00
    Total: $11,600.50
    PAC que Certificó: SAT970701NN3
    Estado del Comprobante: Vigente Efecto del Comprobante: Ingreso

    Folio Fiscal: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
    RFC Emisor: NWM9709244W4 Nombre o Razón Social: NUEVA WAL MART DE MEXICO
    Fecha Emisión: 2026-09-15T08:30:00
    Total: $ 1,250.00
    Estado del Comprobante: Cancelado
    Efecto del Comprobante: Egreso
  `;

  assert.equal(cfdiReportParser.canParse(sampleText), true);
  const res = await cfdiReportParser.parseCfdiReport(sampleText);
  assert.equal(res.detectedPeriod, '2026-09');
  assert.equal(res.invoices.length, 2);
  assert.equal(res.invoices[0].uuid, '11111111-2222-3333-4444-555555555555');
  assert.equal(res.invoices[0].total, 11600.5);
  assert.equal(res.invoices[0].estadoSat, 'Vigente');
  assert.equal(res.invoices[0].estadoPago, 'No Pagada');
  assert.equal(res.invoices[1].estadoSat, 'Cancelado');
  assert.equal(res.invoices[1].estadoPago, 'Cancelada');
  assert.equal(res.invoices[1].efecto, 'Egreso');
});

test('parser BBVA Estado de Cuenta Oficial soporta cargos/abonos, RFC en detalle y cruce de anio dic/ene', () => {
  const text = `
    BBVA MEXICO
    MAESTRA PYME
    Fecha de Corte 05/01/2027
    No. de Cuenta 0192837465
    28/DIC 28/DIC T17 SPEI ENVIADO PROVEEDOR 12,345.67 50,000.00
    RFC: PLO010101AAA PAGO DE FACTURA
    03/ENE 03/ENE T20 SPEI RECIBIDO CLIENTE 5,000.00 55,000.00
    Total de Movimientos
  `;

  assert.equal(bbvaStatementParser.canParse(text), true);
  const res = bbvaStatementParser.parse(text, '2027');
  assert.equal(res.banco, 'BBVA');
  assert.equal(res.cuenta, 'Cuenta 0192837465');
  assert.deepEqual(res.detectedPeriods.sort(), ['2026-12', '2027-01']);
  assert.equal(res.movements.length, 2);

  const [dicMov, eneMov] = res.movements;
  assert.equal(dicMov.fecha, '28-DIC-2026');
  assert.equal(dicMov.periodo, '2026-12');
  assert.equal(dicMov.tipo, 'Retiro');
  assert.equal(dicMov.monto, 12345.67);
  assert.equal(dicMov.rfcDetectado, 'PLO010101AAA');

  assert.equal(eneMov.fecha, '03-ENE-2027');
  assert.equal(eneMov.periodo, '2027-01');
  assert.equal(eneMov.tipo, 'Deposito');
  assert.equal(eneMov.monto, 5000);
});

test('parser BBVA Detalle Web clasifica cargos y abonos por progresion de saldo en centavos', () => {
  const text = `
    Detalle de movimientos
    Cuenta con / sin chequera
    Número de cuenta: 0112233445
    Fecha de consulta: 25/09/2026
    20-09 PAGO PROVEEDOR PLO010101AAA $ 1,500.25 $ 8,499.75
    18-09 DEPOSITO CLIENTE $ 2,000.00 $ 10,000.00
    15-09 SPEI ENVIADO INICIAL $ 500.00 $ 8,000.00
  `;

  assert.equal(bbvaDetalleWebParser.canParse(text), true);
  const res = bbvaDetalleWebParser.parse(text, '2026');
  assert.equal(res.banco, 'BBVA (Detalle Web)');
  assert.equal(res.movements.length, 3);
  assert.equal(res.movements[0].tipo, 'Retiro');
  assert.equal(res.movements[0].monto, 1500.25);
  assert.equal(res.movements[0].rfcDetectado, 'PLO010101AAA');
  assert.equal(res.movements[1].tipo, 'Deposito');
  assert.equal(res.movements[1].monto, 2000);
  assert.equal(res.movements[2].tipo, 'Retiro');
});

test('parser BBVA Tarjeta Negocios / LCDigital extrae consumos, abonos, RFC, referencia y cruce dic/ene', () => {
  const text = `
    BBVA T Negoc / LCDigital
    Periodo Del 15/12/26 al 14/01/27
    No. de Tarjeta 4555 1111 2222 9876
    FECHA AUTORIZACION
    29/12/26 30/12/26 FERRE ABAS MAX CHETUM AMA 0512139J5 ******9851 $ 2,177.99
    04/01/27 04/01/27 SU PAGO EN EFECTIVO GRACIAS ******1111 $ 5,000.00
  `;

  assert.equal(bbvaCreditCardParser.canParse(text), true);
  const res = bbvaCreditCardParser.parse(text, '2026');
  assert.equal(res.banco, 'BBVA (Tarjeta Negocios)');
  assert.equal(res.cuenta, 'Tarjeta 9876');
  assert.deepEqual(res.detectedPeriods, ['2026-12', '2027-01']);
  assert.equal(res.movements.length, 2);

  assert.equal(res.movements[0].fecha, '29-DIC-2026');
  assert.equal(res.movements[0].tipo, 'Retiro');
  assert.equal(res.movements[0].monto, 2177.99);
  assert.equal(res.movements[0].rfcDetectado, 'AMA0512139J5');
  assert.equal(res.movements[0].origenReferencia, '******9851');

  assert.equal(res.movements[1].fecha, '04-ENE-2027');
  assert.equal(res.movements[1].tipo, 'Deposito');
  assert.equal(res.movements[1].monto, 5000);
});

test('parser Scotiabank Estado de Cuenta Cheques detecta cargos/abonos por saldo inicial y cruza dic/ene', () => {
  const text = `
    SCOTIABANK INVERLAT
    Periodo 15-DIC-26
    Cuenta 00256010649
    Saldo inicial $10,000.00
    20 DIC SPEI ENVIADO PAPELERIA RFC PLO010101AAA $1,200.50 $8,799.50
    04 ENE DEPOSITO SPEI CLIENTE $3,000.00 $11,799.50
  `;

  assert.equal(scotiabankStatementParser.canParse(text), true);
  const res = scotiabankStatementParser.parse(text, '2026');
  assert.equal(res.banco, 'Scotiabank');
  assert.deepEqual(res.detectedPeriods.sort(), ['2026-12', '2027-01']);
  assert.equal(res.movements.length, 2);

  assert.equal(res.movements[0].fecha, '20-DIC-2026');
  assert.equal(res.movements[0].tipo, 'Retiro');
  assert.equal(res.movements[0].monto, 1200.5);
  assert.equal(res.movements[0].rfcDetectado, 'PLO010101AAA');

  assert.equal(res.movements[1].fecha, '04-ENE-2027');
  assert.equal(res.movements[1].tipo, 'Deposito');
  assert.equal(res.movements[1].monto, 3000);
});

test('parser Scotiabank Tarjeta de Credito interpreta signo + como Retiro y signo - como Deposito', () => {
  const text = `
    Tarjeta de Crédito Scotiabank Scotia Travel
    No. Tarjeta 4000 1234 5678 4321
    Periodo: 15-dic-2026 al 14-ene-2027
    28-dic-2026 29-dic-2026 AMAZON MEXICO NWM9709244W4 + $ 1,899.90
    05-ene-2027 05-ene-2027 PAGO TARJETA EN LINEA - $ 4,000.00
  `;

  assert.equal(scotiabankCreditCardParser.canParse(text), true);
  const res = scotiabankCreditCardParser.parse(text, '2026');
  assert.equal(res.banco, 'Scotiabank (TDC)');
  assert.equal(res.cuenta, 'Tarjeta 4321');
  assert.deepEqual(res.detectedPeriods, ['2026-12', '2027-01']);
  assert.equal(res.movements.length, 2);
  assert.equal(res.movements[0].tipo, 'Retiro');
  assert.equal(res.movements[0].monto, 1899.9);
  assert.equal(res.movements[0].rfcDetectado, 'NWM9709244W4');
  assert.equal(res.movements[1].tipo, 'Deposito');
  assert.equal(res.movements[1].monto, 4000);
});

test('parser CSV ScotiaWeb soporta montos con comas, cargos, abonos y extraccion de RFC', () => {
  const csv = [
    '502424129,00025601064912,EMPRESA SA,MXN',
    'Tipo,Moneda,Uso futuro,Cuenta,Fecha,Referencia,Importe,Tipo(Cargo/Abono),Saldo,Transacción,Leyenda 1,Leyenda 2,Leyenda 3,Información adicional SPEI/SPID,Consecutivo',
    'CHQ,MXN,,00025601064912,2026/09/15,000991,"2,345.60",Cargo,"15,000.00",SPEI ENVIADO,PAGO FACTURA,PROVEEDOR,RFC NWM 9709244W4,SPEI,1',
    'CHQ,MXN,,00025601064912,2026/09/18,000992,"5,000.00",Abono,"20,000.00",SPEI RECIBIDO,COBRO,CLIENTE,,SPEI,2'
  ].join('\r\n');

  assert.equal(csvParser.canParse(csv), true);
  const res = csvParser.parse(csv, '2026');
  assert.equal(res.banco, 'Scotiabank (CSV/Excel)');
  assert.equal(res.cuenta, 'Cuenta 25601064912');
  assert.equal(res.movements.length, 2);
  assert.equal(res.movements[0].tipo, 'Retiro');
  assert.equal(res.movements[0].monto, 2345.6);
  assert.equal(res.movements[0].rfcDetectado, 'NWM9709244W4');
  assert.equal(res.movements[1].tipo, 'Deposito');
  assert.equal(res.movements[1].monto, 5000);
});

test('registry detecta cada formato en el orden correcto y lanza error 400 para formato desconocido', async () => {
  assert.equal(
    registry.detectParser('Tipo,Moneda,Uso futuro\nCHQ,MXN,,123,2026/09/01,1,100.00,Cargo,500.00,SPEI')?.id,
    'scotiabank-csv'
  );
  assert.equal(
    registry.detectParser('Detalle de movimientos\nCuenta con / sin chequera\n01-09 PAGO $ 100.00 $ 900.00')?.id,
    'bbva-detalle-web'
  );
  assert.equal(
    registry.detectParser('BBVA T Negoc / LCDigital\n01/09/26 02/09/26 COMPRA $ 100.00')?.id,
    'bbva-credit-card'
  );
  assert.equal(
    registry.detectParser('BBVA MEXICO MAESTRA PYME\n01/SEP 01/SEP T17 SPEI 100.00 900.00')?.id,
    'bbva-statement'
  );
  assert.equal(
    registry.detectParser('Tarjeta de Crédito Scotiabank\n01-sep-2026 02-sep-2026 COMPRA + $ 100.00')?.id,
    'scotiabank-credit-card'
  );
  assert.equal(
    registry.detectParser('SCOTIABANK\nPeriodo 01-SEP-26\n05 SEP PAGO $100.00 $900.00')?.id,
    'scotiabank-statement'
  );

  assert.equal(registry.detectParser('Este texto no corresponde a ningun banco conocido'), null);

  assert.throws(
    () => registry.parse('Texto arbitrario que no es un estado de cuenta', '2026', 'desconocido.txt'),
    (err) => err.status === 400 && /No se reconocio el formato/i.test(err.message)
  );

  await assert.rejects(
    () => registry.parseBankStatement(Buffer.from('Texto desconocido sin formato bancario'), '2026', 'raro.txt'),
    (err) => err.status === 400 && /No se reconocio el formato/i.test(err.message)
  );

  // Archivo Excel binario (.xlsx ZIP header PK\x03\x04) debe responder 400
  await assert.rejects(
    () => registry.parseBankStatement(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]), '2026', 'estado.xlsx'),
    (err) => err.status === 400 && /Excel binario/i.test(err.message)
  );
});
