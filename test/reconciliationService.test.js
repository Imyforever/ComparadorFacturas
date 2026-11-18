const test = require('node:test');
const assert = require('node:assert/strict');

const {
  filterUnmatchedMovements,
  createReconciliationService
} = require('../src/services/reconciliationService');
const { createManualLinkService } = require('../src/services/manualLinkService');
const { buildReconciliationCsv, createExportService } = require('../src/services/exportService');

/** Crea repositorios falsos en memoria para probar servicios sin MongoDB */
const createInMemoryRepos = ({ invoices = [], movements = [], externalInvoices = [] } = {}) => {
  const invStore = invoices.map((i) => ({ ...i }));
  const movStore = movements.map((m) => ({ ...m }));
  const extStore = externalInvoices.map((i) => ({ ...i }));

  const applyInvoiceUpdate = (inv, setFields) => {
    for (const [k, v] of Object.entries(setFields)) {
      inv[k] = v;
    }
  };

  const invoiceRepo = {
    getAllowedEstadosPago: () => ['Pagada', 'No Pagada', 'Cancelada', 'Pago Parcial', 'No Aplica', 'En Revision'],
    findByPeriodAndEntity: async (periodo, entidad) =>
      invStore.filter((i) => i.periodo === periodo && i.entidad === entidad).map((i) => ({ ...i })),
    findByUuid: async (uuid) => invStore.find((i) => i.uuid === uuid) || null,
    findExternalPaidByMovementIds: async (movementIds) => {
      const idSet = new Set(movementIds.map(String));
      return extStore.filter(
        (i) => i.estadoPago === 'Pagada' && i.pagoAsociado?.movimientoId && idSet.has(String(i.pagoAsociado.movimientoId))
      );
    },
    findAffectedByMovementIds: async (movementIds) => {
      const idSet = new Set(movementIds.map(String));
      return invStore.filter((i) => i.pagoAsociado?.movimientoId && idSet.has(String(i.pagoAsociado.movimientoId)));
    },
    releaseFromMovementIds: async (movementIds) => {
      const idSet = new Set(movementIds.map(String));
      for (const inv of invStore) {
        if (inv.pagoAsociado?.movimientoId && idSet.has(String(inv.pagoAsociado.movimientoId))) {
          if (inv.estadoPago === 'Pagada') {
            inv.estadoPago = 'No Pagada';
            inv.pagoAsociado = null;
            inv.editadoManualmente = false;
          } else {
            inv.pagoAsociado = null;
          }
        }
      }
    },
    releaseByUuidAndMovement: async (uuid, movementId) => {
      const inv = invStore.find(
        (i) => i.uuid === uuid && String(i.pagoAsociado?.movimientoId) === String(movementId)
      );
      if (inv) {
        inv.estadoPago = 'No Pagada';
        inv.pagoAsociado = null;
        inv.editadoManualmente = false;
      }
    },
    releaseOtherInvoicesFromMovement: async (movementId, keepUuid) => {
      for (const inv of invStore) {
        if (inv.uuid !== keepUuid && String(inv.pagoAsociado?.movimientoId) === String(movementId)) {
          inv.estadoPago = 'No Pagada';
          inv.pagoAsociado = null;
          inv.editadoManualmente = false;
        }
      }
    },
    bulkWrite: async (ops) => {
      for (const op of ops) {
        if (op.updateOne) {
          const target = invStore.find((i) => i.uuid === op.updateOne.filter.uuid);
          if (target && op.updateOne.update.$set) {
            applyInvoiceUpdate(target, op.updateOne.update.$set);
          }
        }
      }
    },
    save: async (doc) => {
      const idx = invStore.findIndex((i) => i.uuid === doc.uuid);
      if (idx !== -1) invStore[idx] = doc;
      else invStore.push(doc);
      return doc;
    }
  };

  const bankMovementRepo = {
    findRetirosInScope: async (periodo, entidad) =>
      movStore
        .filter((m) => m.entidad === entidad && (m.periodo === periodo || m.archivoPeriodo === periodo) && m.tipo === 'Retiro')
        .map((m) => ({ ...m })),
    findBBVAByFilesInScope: async () => [],
    findById: async (id) => movStore.find((m) => String(m._id) === String(id)) || null,
    releaseById: async (id) => {
      const mov = movStore.find((m) => String(m._id) === String(id));
      if (mov) {
        mov.conciliado = false;
        mov.facturaUuid = null;
      }
    },
    releaseByInvoiceUuids: async (uuids) => {
      const set = new Set(uuids);
      for (const mov of movStore) {
        if (set.has(mov.facturaUuid)) {
          mov.conciliado = false;
          mov.facturaUuid = null;
        }
      }
    },
    bulkWrite: async (ops) => {
      for (const op of ops) {
        if (op.updateOne) {
          const target = movStore.find((m) => String(m._id) === String(op.updateOne.filter._id));
          if (target && op.updateOne.update.$set) {
            Object.assign(target, op.updateOne.update.$set);
          }
        }
      }
    },
    save: async (doc) => {
      const idx = movStore.findIndex((m) => String(m._id) === String(doc._id));
      if (idx !== -1) movStore[idx] = doc;
      else movStore.push(doc);
      return doc;
    }
  };

  const bankStatementRepo = {
    distinctArchivosByBanco: async () => [],
    findByPeriodAndEntity: async () => [],
    bulkWrite: async () => {}
  };

  return { invStore, movStore, invoiceRepo, bankMovementRepo, bankStatementRepo };
};

test('filterUnmatchedMovements oculta movimientos ya vinculados a facturas pagadas o reservados', () => {
  const movements = [
    { _id: 'M1', monto: 500, conciliado: true, facturaUuid: 'U1' },
    { _id: 'M2', monto: 800, conciliado: false, facturaUuid: null },
    { _id: 'M3', monto: 900, conciliado: true, facturaUuid: 'U_EXTERNA' },
    { _id: 'M4', monto: 300, conciliado: false, facturaUuid: 'U_CANCELADA' }
  ];
  const invoices = [
    { uuid: 'U1', estadoPago: 'Pagada', pagoAsociado: { movimientoId: 'M1' } },
    { uuid: 'U_CANCELADA', estadoPago: 'Cancelada', pagoAsociado: null }
  ];

  const unmatched = filterUnmatchedMovements(movements, invoices);
  assert.deepEqual(
    unmatched.map((m) => m._id),
    ['M2', 'M4']
  );
});

test('export CSV escapa comillas/comas y neutraliza inyeccion de formulas (=, +, -, @)', async () => {
  const invoices = [
    {
      uuid: 'UUID-1',
      rfcEmisor: 'PLO010101AAA',
      emisor: '=HYPERLINK("http://malicioso", "Proveedor, ""Especial""")',
      fechaEmision: '2026-09-10',
      total: 1234.5,
      estadoSat: 'Vigente',
      efecto: 'Ingreso',
      estadoPago: 'No Pagada',
      editadoManualmente: false,
      observaciones: '+cmd|calc'
    }
  ];
  const rawBankMovements = [
    {
      _id: 'MOV-1',
      fecha: '12-SEP-2026',
      banco: 'BBVA',
      cuenta: '1234',
      concepto: '-CARGO SOSPECHOSO, "TEST"',
      rfcDetectado: 'PLO010101AAA',
      monto: 500,
      categoria: '@SUM(1+1)',
      observaciones: '=1+1',
      conciliado: false,
      facturaUuid: null
    }
  ];

  const csv = buildReconciliationCsv({ invoices, rawBankMovements });
  assert.ok(csv.includes('"\'=HYPERLINK(""http://malicioso"", ""Proveedor, """"Especial"""""")"'));
  assert.ok(csv.includes('"\'+cmd|calc"'));
  assert.ok(csv.includes('"\'-CARGO SOSPECHOSO, ""TEST"""'));
  assert.ok(csv.includes('"\'@SUM(1+1)"'));
  assert.ok(csv.includes('"\'=1+1"'));
  assert.ok(csv.includes(',1234.50,'));

  const { invoiceRepo, bankMovementRepo } = createInMemoryRepos({
    invoices: [{ ...invoices[0], periodo: '2026-09', entidad: 'Personal' }],
    movements: [{ ...rawBankMovements[0], periodo: '2026-09', entidad: 'Personal', tipo: 'Retiro' }]
  });
  const exportService = createExportService({ invoiceRepo, bankMovementRepo });
  const exported = await exportService.exportPeriodCsv({ periodo: '2026-09', entidad: 'Personal' });
  assert.ok(exported.csvContent.startsWith('\uFEFF'));
  assert.equal(exported.asciiName, 'Conciliacion_Personal_2026-09.csv');
});

test('conciliacion por periodo: respeta enlaces manuales y no reutiliza reservas de otros meses', async () => {
  const movManual = {
    _id: '507f1f77bcf86cd799439011',
    periodo: '2026-09',
    entidad: 'Personal',
    tipo: 'Retiro',
    monto: 1000,
    fecha: '05-SEP-2026',
    concepto: 'PAGO MANUAL',
    banco: 'BBVA',
    conciliado: true,
    facturaUuid: 'INV-MANUAL'
  };
  const movReservedOtherMonth = {
    _id: '507f1f77bcf86cd799439012',
    periodo: '2026-09',
    entidad: 'Personal',
    tipo: 'Retiro',
    monto: 1000,
    fecha: '06-SEP-2026',
    concepto: 'PAGO RESERVADO AGOSTO',
    banco: 'BBVA',
    conciliado: true,
    facturaUuid: 'INV-AGOSTO'
  };
  const movFree = {
    _id: '507f1f77bcf86cd799439013',
    periodo: '2026-09',
    entidad: 'Personal',
    tipo: 'Retiro',
    monto: 2500,
    fecha: '10-SEP-2026',
    concepto: 'SPEI PROVEEDOR LIBRE',
    banco: 'BBVA',
    conciliado: false,
    facturaUuid: null
  };

  const invoices = [
    {
      uuid: 'INV-MANUAL',
      periodo: '2026-09',
      entidad: 'Personal',
      emisor: 'Proveedor Manual',
      rfcEmisor: 'PMN010101AAA',
      fechaEmision: '2026-09-01',
      total: 950,
      estadoSat: 'Vigente',
      efecto: 'Ingreso',
      estadoPago: 'Pagada',
      editadoManualmente: true,
      pagoAsociado: {
        movimientoId: movManual._id,
        montoRetiro: 1000,
        diferencia: 50,
        fechaPago: '05-SEP-2026'
      }
    },
    {
      // Tiene monto 1000 igual que movManual y movReservedOtherMonth, pero ambos estan ocupados
      uuid: 'INV-AUTO-1000',
      periodo: '2026-09',
      entidad: 'Personal',
      emisor: 'Proveedor Mil',
      rfcEmisor: 'PMI010101AAA',
      fechaEmision: '2026-09-05',
      total: 1000,
      estadoSat: 'Vigente',
      efecto: 'Ingreso',
      estadoPago: 'No Pagada',
      editadoManualmente: false,
      pagoAsociado: null
    },
    {
      uuid: 'INV-AUTO-2500',
      periodo: '2026-09',
      entidad: 'Personal',
      emisor: 'Proveedor Libre',
      rfcEmisor: 'PLI010101AAA',
      fechaEmision: '2026-09-09',
      total: 2500,
      estadoSat: 'Vigente',
      efecto: 'Ingreso',
      estadoPago: 'No Pagada',
      editadoManualmente: false,
      pagoAsociado: null
    }
  ];

  const externalInvoices = [
    {
      uuid: 'INV-AGOSTO',
      periodo: '2026-08',
      entidad: 'Personal',
      estadoPago: 'Pagada',
      pagoAsociado: { movimientoId: movReservedOtherMonth._id }
    }
  ];

  const { invStore, movStore, invoiceRepo, bankMovementRepo, bankStatementRepo } = createInMemoryRepos({
    invoices,
    movements: [movManual, movReservedOtherMonth, movFree],
    externalInvoices
  });

  const reconService = createReconciliationService({ invoiceRepo, bankMovementRepo, bankStatementRepo });
  await reconService.runReconciliationForPeriod('2026-09', 'Personal');

  const invManualAfter = invStore.find((i) => i.uuid === 'INV-MANUAL');
  const inv1000After = invStore.find((i) => i.uuid === 'INV-AUTO-1000');
  const inv2500After = invStore.find((i) => i.uuid === 'INV-AUTO-2500');

  // 1. La factura manual conserva su movimiento intacto
  assert.equal(invManualAfter.estadoPago, 'Pagada');
  assert.equal(invManualAfter.pagoAsociado.movimientoId, movManual._id);

  // 2. La factura automatica de $1000 NO roba el movimiento manual ni el reservado por otro mes
  assert.equal(inv1000After.estadoPago, 'No Pagada');
  assert.equal(inv1000After.pagoAsociado, null);

  // 3. La factura automatica de $2500 concilia con el movimiento libre
  assert.equal(inv2500After.estadoPago, 'Pagada');
  assert.equal(inv2500After.pagoAsociado.movimientoId, movFree._id);

  // 4. El movimiento reservado de otro mes sigue marcado como conciliado con INV-AGOSTO
  const reservedMovAfter = movStore.find((m) => m._id === movReservedOtherMonth._id);
  assert.equal(reservedMovAfter.conciliado, true);
  assert.equal(reservedMovAfter.facturaUuid, 'INV-AGOSTO');
});

test('conciliacion por periodo: al desenlazar se libera el movimiento y queda disponible', async () => {
  const movId = '507f1f77bcf86cd799439099';
  const { invStore, movStore, invoiceRepo, bankMovementRepo, bankStatementRepo } = createInMemoryRepos({
    invoices: [
      {
        uuid: 'INV-1',
        periodo: '2026-09',
        entidad: 'Personal',
        emisor: 'Proveedor Uno',
        rfcEmisor: 'PUN010101AAA',
        fechaEmision: '2026-09-02',
        total: 800,
        estadoSat: 'Vigente',
        efecto: 'Ingreso',
        estadoPago: 'Pagada',
        editadoManualmente: true,
        pagoAsociado: {
          movimientoId: movId,
          montoRetiro: 800,
          diferencia: 0,
          fechaPago: '03-SEP-2026'
        }
      }
    ],
    movements: [
      {
        _id: movId,
        periodo: '2026-09',
        entidad: 'Personal',
        tipo: 'Retiro',
        monto: 800,
        fecha: '03-SEP-2026',
        concepto: 'PAGO PROVEEDOR UNO',
        banco: 'BBVA',
        conciliado: true,
        facturaUuid: 'INV-1'
      }
    ]
  });

  const reconService = createReconciliationService({ invoiceRepo, bankMovementRepo, bankStatementRepo });
  const manualService = createManualLinkService({
    invoiceRepo,
    bankMovementRepo,
    reconciliationService: reconService,
    egresoService: { releaseEgreso: async () => {}, releaseIngresoFromEgreso: async () => {} }
  });

  await manualService.unlinkManual({ invoiceUuid: 'INV-1' });

  assert.equal(invStore[0].estadoPago, 'No Pagada');
  assert.equal(invStore[0].pagoAsociado, null);
  assert.equal(invStore[0].editadoManualmente, false);
  assert.equal(movStore[0].conciliado, false);
  assert.equal(movStore[0].facturaUuid, null);
});

test('reconciliationService con repos falsos: asigna nota de credito parcial y es estable en segunda corrida', async () => {
  const fixedDate = new Date('2026-09-15T12:00:00Z');
  const movId = '507f1f77bcf86cd799439055';

  const { invStore, movStore, invoiceRepo, bankMovementRepo, bankStatementRepo } = createInMemoryRepos({
    invoices: [
      {
        uuid: 'INV-100',
        periodo: '2026-09',
        entidad: 'Personal',
        emisor: 'Proveedor Parcial SA',
        rfcEmisor: 'PPA010101AAA',
        fechaEmision: '2026-09-05',
        total: 100,
        estadoSat: 'Vigente',
        efecto: 'Ingreso',
        estadoPago: 'No Pagada',
        editadoManualmente: false,
        pagoAsociado: null,
        egresoAsociado: null
      },
      {
        uuid: 'NC-10',
        periodo: '2026-09',
        entidad: 'Personal',
        emisor: 'Proveedor Parcial SA',
        rfcEmisor: 'PPA010101AAA',
        fechaEmision: '2026-09-06',
        total: 10,
        estadoSat: 'Vigente',
        efecto: 'Egreso',
        estadoPago: 'No Aplica',
        editadoManualmente: false,
        ingresoAsociado: null
      }
    ],
    movements: [
      {
        _id: movId,
        periodo: '2026-09',
        entidad: 'Personal',
        tipo: 'Retiro',
        monto: 90,
        fecha: '07-SEP-2026',
        concepto: 'SPEI PROVEEDOR PARCIAL PPA010101AAA',
        origenReferencia: 'REF-90',
        banco: 'BBVA',
        conciliado: false,
        facturaUuid: null
      }
    ]
  });

  const accountTabRepo = { findFirstByPeriodo: async () => ({ nombre: 'Personal' }) };
  const reconService = createReconciliationService({
    invoiceRepo,
    bankMovementRepo,
    bankStatementRepo,
    accountTabRepo,
    clock: () => fixedDate
  });

  // 1a corrida: debe asignar automaticamente INV-100 con NC-10 y MOV-90
  await reconService.runReconciliationForPeriod('2026-09', 'Personal');

  const invAfter1 = invStore.find((i) => i.uuid === 'INV-100');
  const ncAfter1 = invStore.find((i) => i.uuid === 'NC-10');
  const movAfter1 = movStore.find((m) => m._id === movId);

  assert.equal(invAfter1.estadoPago, 'Pagada');
  assert.equal(invAfter1.editadoManualmente, false);
  assert.equal(invAfter1.egresoAsociado.uuid, 'NC-10');
  assert.equal(invAfter1.egresoAsociado.total, 10);
  assert.equal(invAfter1.pagoAsociado.movimientoId, movId);
  assert.equal(invAfter1.pagoAsociado.montoRetiro, 90);
  assert.equal(invAfter1.pagoAsociado.diferencia, 0);
  assert.equal(invAfter1.pagoAsociado.conceptoBanco, 'SPEI PROVEEDOR PARCIAL PPA010101AAA');
  assert.equal(invAfter1.pagoAsociado.referencia, 'REF-90');
  assert.deepEqual(invAfter1.asignacionAutomatica, {
    tipo: 'nota-credito-parcial',
    fecha: fixedDate
  });

  assert.equal(ncAfter1.ingresoAsociado.uuid, 'INV-100');
  assert.equal(ncAfter1.ingresoAsociado.total, 100);
  assert.equal(movAfter1.conciliado, true);
  assert.equal(movAfter1.facturaUuid, 'INV-100');

  // 2a corrida: estable, no deshace ni duplica
  const laterDate = new Date('2026-09-20T12:00:00Z');
  const reconService2 = createReconciliationService({
    invoiceRepo,
    bankMovementRepo,
    bankStatementRepo,
    accountTabRepo,
    clock: () => laterDate
  });
  await reconService2.runReconciliationForPeriod('2026-09', 'Personal');

  const invAfter2 = invStore.find((i) => i.uuid === 'INV-100');
  assert.equal(invAfter2.estadoPago, 'Pagada');
  assert.equal(invAfter2.egresoAsociado.uuid, 'NC-10');
  assert.equal(invAfter2.pagoAsociado.movimientoId, movId);
  assert.equal(invAfter2.asignacionAutomatica.fecha, fixedDate);

  const periodData = await reconService2.getPeriodData({ periodo: '2026-09', entidad: 'Personal' });
  assert.equal(periodData.autoCreditNoteAssignments.length, 1);
  assert.equal(periodData.autoCreditNoteAssignments[0].invoiceUuid, 'INV-100');
  assert.equal(periodData.autoCreditNoteAssignments[0].creditNoteUuid, 'NC-10');
  assert.equal(periodData.autoCreditNoteAssignments[0].montoNota, 10);
  assert.equal(periodData.autoCreditNoteAssignments[0].montoRetiro, 90);
});

test('reconciliationService con repos falsos: libera la asignacion si desaparece el retiro', async () => {
  const movId = '507f1f77bcf86cd799439066';
  const { invStore, movStore, invoiceRepo, bankMovementRepo, bankStatementRepo } = createInMemoryRepos({
    invoices: [
      {
        uuid: 'INV-100',
        periodo: '2026-09',
        entidad: 'Personal',
        emisor: 'Proveedor Parcial SA',
        rfcEmisor: 'PPA010101AAA',
        fechaEmision: '2026-09-05',
        total: 100,
        estadoSat: 'Vigente',
        efecto: 'Ingreso',
        estadoPago: 'No Pagada',
        editadoManualmente: false
      },
      {
        uuid: 'NC-10',
        periodo: '2026-09',
        entidad: 'Personal',
        emisor: 'Proveedor Parcial SA',
        rfcEmisor: 'PPA010101AAA',
        fechaEmision: '2026-09-06',
        total: 10,
        estadoSat: 'Vigente',
        efecto: 'Egreso',
        estadoPago: 'No Aplica',
        editadoManualmente: false
      }
    ],
    movements: [
      {
        _id: movId,
        periodo: '2026-09',
        entidad: 'Personal',
        tipo: 'Retiro',
        monto: 90,
        fecha: '07-SEP-2026',
        concepto: 'SPEI PPA010101AAA',
        banco: 'BBVA',
        conciliado: false,
        facturaUuid: null
      }
    ]
  });

  const reconService = createReconciliationService({ invoiceRepo, bankMovementRepo, bankStatementRepo });
  await reconService.runReconciliationForPeriod('2026-09', 'Personal');
  assert.equal(invStore.find((i) => i.uuid === 'INV-100').estadoPago, 'Pagada');

  // Simular que se borro el estado de cuenta (desaparece el retiro)
  movStore.length = 0;
  await reconService.runReconciliationForPeriod('2026-09', 'Personal');

  const invReleased = invStore.find((i) => i.uuid === 'INV-100');
  const ncReleased = invStore.find((i) => i.uuid === 'NC-10');
  assert.equal(invReleased.estadoPago, 'No Pagada');
  assert.equal(invReleased.pagoAsociado, null);
  assert.equal(invReleased.egresoAsociado, null);
  assert.equal(invReleased.asignacionAutomatica, null);
  assert.equal(ncReleased.ingresoAsociado, null);
});

test('undo-auto-nc: libera las tres partes, marca el rechazo y reconciliationService respeta rechazoAsignacionAutomatica', async () => {
  const movId = '507f1f77bcf86cd799439077';
  const { invStore, movStore, invoiceRepo, bankMovementRepo, bankStatementRepo } = createInMemoryRepos({
    invoices: [
      {
        uuid: 'INV-100',
        periodo: '2026-09',
        entidad: 'Personal',
        emisor: 'Proveedor Parcial SA',
        rfcEmisor: 'PPA010101AAA',
        fechaEmision: '2026-09-05',
        total: 100,
        estadoSat: 'Vigente',
        efecto: 'Ingreso',
        estadoPago: 'No Pagada',
        editadoManualmente: false
      },
      {
        uuid: 'NC-10',
        periodo: '2026-09',
        entidad: 'Personal',
        emisor: 'Proveedor Parcial SA',
        rfcEmisor: 'PPA010101AAA',
        fechaEmision: '2026-09-06',
        total: 10,
        estadoSat: 'Vigente',
        efecto: 'Egreso',
        estadoPago: 'No Aplica',
        editadoManualmente: false
      }
    ],
    movements: [
      {
        _id: movId,
        periodo: '2026-09',
        entidad: 'Personal',
        tipo: 'Retiro',
        monto: 90,
        fecha: '07-SEP-2026',
        concepto: 'SPEI PPA010101AAA',
        banco: 'BBVA',
        conciliado: false,
        facturaUuid: null
      }
    ]
  });

  const reconService = createReconciliationService({ invoiceRepo, bankMovementRepo, bankStatementRepo });
  await reconService.runReconciliationForPeriod('2026-09', 'Personal');

  // Deshacer la asignacion automatica
  await reconService.undoAutoCreditNote({ uuid: 'INV-100' });

  const invAfterUndo = invStore.find((i) => i.uuid === 'INV-100');
  const ncAfterUndo = invStore.find((i) => i.uuid === 'NC-10');
  const movAfterUndo = movStore.find((m) => m._id === movId);

  assert.equal(invAfterUndo.estadoPago, 'No Pagada');
  assert.equal(invAfterUndo.egresoAsociado, null);
  assert.equal(invAfterUndo.pagoAsociado, null);
  assert.equal(invAfterUndo.asignacionAutomatica, null);
  assert.equal(invAfterUndo.rechazoAsignacionAutomatica, true);
  assert.equal(ncAfterUndo.ingresoAsociado, null);
  assert.equal(movAfterUndo.conciliado, false);
  assert.equal(movAfterUndo.facturaUuid, null);

  // Al volver a correr la conciliacion, no se vuelve a asignar automaticamente porque fue rechazada
  await reconService.runReconciliationForPeriod('2026-09', 'Personal');
  assert.equal(invStore.find((i) => i.uuid === 'INV-100').estadoPago, 'No Pagada');
  assert.equal(invStore.find((i) => i.uuid === 'NC-10').ingresoAsociado, null);
  assert.equal(movStore.find((m) => m._id === movId).conciliado, false);
});
