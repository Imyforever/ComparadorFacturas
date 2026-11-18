/**
 * Servicio de conciliacion por periodo y obtencion de resumen/datos del panel.
 * Recibe repositorios por inyeccion de dependencias para permitir pruebas sin MongoDB.
 */

const defaultInvoiceRepo = require('../repositories/invoiceRepository');
const defaultBankMovementRepo = require('../repositories/bankMovementRepository');
const defaultBankStatementRepo = require('../repositories/bankStatementRepository');
const defaultAccountTabRepo = require('../repositories/accountTabRepository');
const { classifyBBVAMovementIsRetiro } = require('../parsers/bbva/classify');
const { reconcile } = require('./reconciler');
const {
  AUTO_NC_TIPO,
  isAutoCreditNoteInvoice,
  matchPartialCreditNotes,
  separateExistingAutoCreditNotes,
  buildAutoCreditNoteAssignments
} = require('./creditNoteMatcher');
const { parseFlexibleDate, PERIODO_REGEX } = require('../utils/dates');
const { toCents, fromCents, round2, sameAmount } = require('../utils/money');
const { normUuid } = require('../utils/text');
const { httpError } = require('../utils/errors');

const DEFAULT_PERIODO = '2026-09';
const DEFAULT_ENTIDAD = 'Personal';
const SMALL_AMOUNT_THRESHOLD = 100;

const readPeriodo = (value) => {
  if (value === undefined || value === null || value === '') return DEFAULT_PERIODO;
  const p = String(value).trim();
  if (!PERIODO_REGEX.test(p)) throw httpError(400, `Periodo invalido "${p}". Use el formato AAAA-MM.`);
  return p;
};

const readEntidad = (value, fallback = DEFAULT_ENTIDAD) => {
  if (value === undefined || value === null) return fallback;
  const e = String(value).trim();
  return e || fallback;
};

const movementTime = (m) => {
  const d = m.fechaNormalizada ? new Date(m.fechaNormalizada) : parseFlexibleDate(m.fecha);
  return d && !isNaN(d.getTime()) ? d.getTime() : 0;
};

/** Ordena movimientos del mas reciente al mas antiguo usando la fecha real */
const sortMovementsDesc = (movements) => movements.sort((a, b) => movementTime(b) - movementTime(a));

/**
 * Movimientos de retiro de un mes que no pertenecen a ninguna factura pagada del mismo mes
 * (ni estan reservados por una factura de otro mes).
 */
const filterUnmatchedMovements = (rawBankMovements = [], allInvoices = []) => {
  const paidMovementIdSet = new Set(
    allInvoices
      .filter((inv) => inv.estadoPago === 'Pagada' && inv.pagoAsociado?.movimientoId)
      .map((inv) => String(inv.pagoAsociado.movimientoId))
  );

  const paidInvoiceUuidSet = new Set(
    allInvoices.filter((inv) => inv.estadoPago === 'Pagada').map((inv) => inv.uuid)
  );

  return rawBankMovements.filter((m) => {
    if (paidMovementIdSet.has(String(m._id))) return false;
    if (m.facturaUuid && paidInvoiceUuidSet.has(m.facturaUuid)) return false;
    return !m.conciliado || !m.facturaUuid;
  });
};

const samePago = (a, b) => {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    String(a.movimientoId || '') === String(b.movimientoId || '') &&
    sameAmount(a.montoRetiro, b.montoRetiro) &&
    sameAmount(a.diferencia, b.diferencia) &&
    a.fechaPago === b.fechaPago
  );
};

const createReconciliationService = ({
  invoiceRepo = defaultInvoiceRepo,
  bankMovementRepo = defaultBankMovementRepo,
  bankStatementRepo = defaultBankStatementRepo,
  accountTabRepo = defaultAccountTabRepo,
  clock = () => new Date()
} = {}) => {
  const releaseMovementsLinkedTo = async (uuids) => {
    if (!uuids || uuids.length === 0) return;
    await bankMovementRepo.releaseByInvoiceUuids(uuids);
  };

  const releaseInvoicesLinkedToMovements = async (movementIds) => {
    if (!movementIds || movementIds.length === 0) return [];
    const affected = await invoiceRepo.findAffectedByMovementIds(movementIds);
    if (affected.length === 0) return [];

    await invoiceRepo.releaseFromMovementIds(movementIds);

    const scopes = new Map();
    for (const inv of affected) {
      const entidad = inv.entidad || DEFAULT_ENTIDAD;
      scopes.set(`${inv.periodo}|${entidad}`, { periodo: inv.periodo, entidad });
    }
    return Array.from(scopes.values());
  };

  const recomputeStatementStats = async (entidad, nombresArchivo) => {
    if (!nombresArchivo || nombresArchivo.length === 0) return;
    const stats = await bankMovementRepo.aggregateStatsByFiles(entidad, nombresArchivo);
    if (stats.length === 0) return;
    await bankStatementRepo.bulkWrite(
      stats.map((s) => ({
        updateMany: {
          filter: { entidad, nombreArchivo: s._id },
          update: {
            $set: {
              totalMovimientos: s.total,
              cargosCount: s.cargosCount,
              abonosCount: s.abonosCount,
              montoCargos: round2(s.montoCargos),
              montoAbonos: round2(s.montoAbonos)
            }
          }
        }
      }))
    );
  };

  const fixLegacyBBVAClassification = async (periodo, entidad) => {
    const officialFiles = await bankStatementRepo.distinctArchivosByBanco(entidad, 'BBVA');
    if (officialFiles.length === 0) return;

    const bbvaMovs = await bankMovementRepo.findBBVAByFilesInScope(periodo, entidad, officialFiles);

    const fixOps = [];
    const touchedFiles = new Set();
    for (const m of bbvaMovs) {
      const expectedTipo = classifyBBVAMovementIsRetiro(m.concepto) ? 'Retiro' : 'Deposito';
      if (m.tipo !== expectedTipo) {
        fixOps.push({ updateOne: { filter: { _id: m._id }, update: { $set: { tipo: expectedTipo } } } });
        touchedFiles.add(m.archivoOrigen);
      }
    }

    if (fixOps.length > 0) {
      await bankMovementRepo.bulkWrite(fixOps);
      await recomputeStatementStats(entidad, Array.from(touchedFiles));
    }
  };

  const runReconciliationForPeriod = async (periodo, entidad = DEFAULT_ENTIDAD) => {
    await fixLegacyBBVAClassification(periodo, entidad);

    const [invoices, bankMovements] = await Promise.all([
      invoiceRepo.findByPeriodAndEntity(periodo, entidad),
      bankMovementRepo.findRetirosInScope(periodo, entidad)
    ]);

    const externalReservations = new Map();
    if (bankMovements.length > 0) {
      const externalInvoices = await invoiceRepo.findExternalPaidByMovementIds(
        bankMovements.map((m) => m._id),
        periodo,
        entidad
      );
      for (const inv of externalInvoices) {
        externalReservations.set(String(inv.pagoAsociado.movimientoId), inv.uuid);
      }
    }

    const manualInvoices = invoices.filter((i) => i.editadoManualmente && i.estadoPago !== 'No Pagada');
    const manuallyUsedMovementIds = new Set(
      manualInvoices
        .map((i) => i.pagoAsociado?.movimientoId)
        .filter(Boolean)
        .map((id) => String(id))
    );

    const {
      workingInvoices,
      manuallyUsedEgresoUuids,
      preservedInvoices,
      preservedInvoiceUuids,
      preservedCreditNoteUuids,
      preservedMovementIds,
      releasedCreditNotesByUuid,
      repairedCreditNotesByUuid
    } = separateExistingAutoCreditNotes({
      invoices,
      bankMovements,
      manualInvoices,
      manuallyUsedMovementIds,
      externalReservations
    });

    const availableMovements = bankMovements.filter(
      (m) =>
        !manuallyUsedMovementIds.has(String(m._id)) &&
        !externalReservations.has(String(m._id)) &&
        !preservedMovementIds.has(String(m._id))
    );

    const autoInvoices = workingInvoices.filter(
      (i) => (!i.editadoManualmente || i.estadoPago === 'No Pagada') && !preservedInvoiceUuids.has(i.uuid)
    );
    const { summary, reconciledInvoices, unmatchedWithdrawals } = reconcile(autoInvoices, availableMovements);

    const unpaidAfterReconcile = reconciledInvoices.filter(
      (i) =>
        i.estadoPago === 'No Pagada' &&
        (i.efecto || 'Ingreso') === 'Ingreso' &&
        (i.estadoSat || 'Vigente') === 'Vigente' &&
        !i.egresoAsociado?.uuid &&
        !i.rechazoAsignacionAutomatica
    );
    const availableCreditNotes = workingInvoices.filter(
      (i) =>
        i.efecto === 'Egreso' &&
        (i.estadoSat || 'Vigente') === 'Vigente' &&
        !i.ingresoAsociado?.uuid &&
        !preservedCreditNoteUuids.has(i.uuid) &&
        !manuallyUsedEgresoUuids.has(i.uuid)
    );
    const partialAssignments = matchPartialCreditNotes(
      unpaidAfterReconcile,
      availableCreditNotes,
      unmatchedWithdrawals
    );

    const now = clock();
    const reconciledByUuid = new Map(reconciledInvoices.map((i) => [i.uuid, i]));
    const notesByUuid = new Map(availableCreditNotes.map((n) => [n.uuid, n]));
    const withdrawalsById = new Map(unmatchedWithdrawals.map((w) => [String(w._id), w]));
    const newlyMatchedCreditNotes = new Map();

    for (const match of partialAssignments) {
      const inv = reconciledByUuid.get(match.invoiceUuid);
      const nc = notesByUuid.get(match.creditNoteUuid);
      const tx = withdrawalsById.get(String(match.movementId));
      if (!inv || !nc || !tx) continue;

      inv.estadoPago = 'Pagada';
      inv.editadoManualmente = false;
      inv.egresoAsociado = {
        uuid: nc.uuid,
        total: nc.total,
        fechaEmision: nc.fechaEmision,
        emisor: nc.emisor
      };
      inv.pagoAsociado = {
        movimientoId: tx._id || null,
        banco: tx.banco || 'Banco',
        fechaPago: tx.fecha,
        montoRetiro: match.montoRetiro,
        diferencia: round2(match.diferencia),
        conceptoBanco: tx.concepto,
        referencia: tx.origenReferencia || ''
      };
      inv.asignacionAutomatica = {
        tipo: AUTO_NC_TIPO,
        fecha: now
      };

      const ingresoLink = {
        uuid: inv.uuid,
        total: inv.total,
        fechaEmision: inv.fechaEmision,
        emisor: inv.emisor
      };
      newlyMatchedCreditNotes.set(nc.uuid, ingresoLink);
      const ncInReconciled = reconciledByUuid.get(nc.uuid);
      if (ncInReconciled) {
        ncInReconciled.ingresoAsociado = ingresoLink;
      }

      summary.pagadasCount++;
      summary.noPagadasCount = Math.max(0, summary.noPagadasCount - 1);
      summary.montoPagado = fromCents(toCents(summary.montoPagado) + toCents(inv.total));
      summary.montoNoPagado = fromCents(Math.max(0, toCents(summary.montoNoPagado) - toCents(inv.total)));
      summary.movimientosNoAsociadosCount = Math.max(0, summary.movimientosNoAsociadosCount - 1);
    }

    for (const pInv of preservedInvoices) {
      summary.totalFacturas++;
      summary.pagadasCount++;
      summary.montoTotalFacturas = fromCents(toCents(summary.montoTotalFacturas) + toCents(pInv.total));
      summary.montoPagado = fromCents(toCents(summary.montoPagado) + toCents(pInv.total));
      summary.movimientosBancariosCount++;
    }

    const dbOriginalByUuid = new Map(invoices.map((i) => [i.uuid, i]));
    const handledUuids = new Set();
    const bulkInvoiceOps = [];

    for (const inv of reconciledInvoices) {
      const before = dbOriginalByUuid.get(inv.uuid);
      const resetManual = inv.estadoPago === 'Pagada' && before?.editadoManualmente;
      const egresoChanged = (before?.egresoAsociado?.uuid || null) !== (inv.egresoAsociado?.uuid || null);
      const ingresoChanged = (before?.ingresoAsociado?.uuid || null) !== (inv.ingresoAsociado?.uuid || null);
      const autoNcChanged = (before?.asignacionAutomatica?.tipo || null) !== (inv.asignacionAutomatica?.tipo || null);

      if (
        before &&
        before.estadoPago === inv.estadoPago &&
        samePago(before.pagoAsociado, inv.pagoAsociado) &&
        !resetManual &&
        !egresoChanged &&
        !ingresoChanged &&
        !autoNcChanged
      ) {
        handledUuids.add(inv.uuid);
        continue;
      }

      const setFields = {
        estadoPago: inv.estadoPago,
        pagoAsociado: inv.pagoAsociado,
        ...(inv.estadoPago === 'Pagada' ? { editadoManualmente: false } : {})
      };
      if (egresoChanged || inv.egresoAsociado) {
        setFields.egresoAsociado = inv.egresoAsociado || null;
      }
      if (autoNcChanged || inv.asignacionAutomatica) {
        setFields.asignacionAutomatica = inv.asignacionAutomatica || null;
        setFields.editadoManualmente = false;
      }
      if (ingresoChanged || newlyMatchedCreditNotes.has(inv.uuid) || releasedCreditNotesByUuid.has(inv.uuid)) {
        setFields.ingresoAsociado = inv.ingresoAsociado || null;
        setFields.editadoManualmente = false;
      }

      handledUuids.add(inv.uuid);
      bulkInvoiceOps.push({
        updateOne: {
          filter: { uuid: inv.uuid },
          update: { $set: setFields }
        }
      });
    }

    for (const [ncUuid, ingresoLink] of newlyMatchedCreditNotes.entries()) {
      if (handledUuids.has(ncUuid)) continue;
      bulkInvoiceOps.push({
        updateOne: {
          filter: { uuid: ncUuid },
          update: { $set: { ingresoAsociado: ingresoLink, editadoManualmente: false } }
        }
      });
    }
    for (const ncUuid of releasedCreditNotesByUuid.keys()) {
      if (handledUuids.has(ncUuid)) continue;
      bulkInvoiceOps.push({
        updateOne: {
          filter: { uuid: ncUuid },
          update: { $set: { ingresoAsociado: null, editadoManualmente: false } }
        }
      });
    }
    for (const [ncUuid, repNc] of repairedCreditNotesByUuid.entries()) {
      if (handledUuids.has(ncUuid)) continue;
      bulkInvoiceOps.push({
        updateOne: {
          filter: { uuid: ncUuid },
          update: { $set: { ingresoAsociado: repNc.ingresoAsociado, editadoManualmente: false } }
        }
      });
    }

    if (bulkInvoiceOps.length > 0) {
      await invoiceRepo.bulkWrite(bulkInvoiceOps);
    }

    const matchedMovementMap = new Map(externalReservations);
    for (const inv of manualInvoices) {
      if (inv.estadoPago === 'Pagada' && inv.pagoAsociado?.movimientoId) {
        matchedMovementMap.set(String(inv.pagoAsociado.movimientoId), inv.uuid);
      }
    }
    for (const inv of preservedInvoices) {
      if (inv.estadoPago === 'Pagada' && inv.pagoAsociado?.movimientoId) {
        matchedMovementMap.set(String(inv.pagoAsociado.movimientoId), inv.uuid);
      }
    }
    for (const inv of reconciledInvoices) {
      if (inv.estadoPago === 'Pagada' && inv.pagoAsociado?.movimientoId) {
        matchedMovementMap.set(String(inv.pagoAsociado.movimientoId), inv.uuid);
      }
    }

    const bulkBankOps = [];
    for (const bm of bankMovements) {
      const matchedUuid = matchedMovementMap.get(String(bm._id)) || null;
      if (!!bm.conciliado === !!matchedUuid && (bm.facturaUuid || null) === matchedUuid) continue;
      bulkBankOps.push({
        updateOne: {
          filter: { _id: bm._id },
          update: { $set: { conciliado: !!matchedUuid, facturaUuid: matchedUuid } }
        }
      });
    }

    if (bulkBankOps.length > 0) {
      await bankMovementRepo.bulkWrite(bulkBankOps);
    }

    return { summary: invoices.length === 0 ? null : summary };
  };

  const runReconciliationForScopes = async (scopes, skip = []) => {
    const skipKeys = new Set(skip.map((s) => `${s.periodo}|${s.entidad}`));
    for (const s of scopes) {
      const key = `${s.periodo}|${s.entidad}`;
      if (skipKeys.has(key)) continue;
      skipKeys.add(key);
      await runReconciliationForPeriod(s.periodo, s.entidad);
    }
  };

  const getPeriodData = async ({ periodo: rawPeriodo, entidad: rawEntidad, filter = 'all', ensureDefaultTabs }) => {
    const periodo = readPeriodo(rawPeriodo);
    if (ensureDefaultTabs) await ensureDefaultTabs(periodo);

    let entidad = rawEntidad;
    if (!entidad) {
      const firstTab = await accountTabRepo.findFirstByPeriodo(periodo);
      entidad = firstTab ? firstTab.nombre : DEFAULT_ENTIDAD;
    }

    const [allInvoices, rawBankMovements, bankStatements] = await Promise.all([
      invoiceRepo.findByPeriodAndEntity(periodo, entidad, { sortByFecha: true }),
      bankMovementRepo.findRetirosInScope(periodo, entidad),
      bankStatementRepo.findByPeriodAndEntity(periodo, entidad)
    ]);

    sortMovementsDesc(rawBankMovements);
    const bankMovementsCount = rawBankMovements.length;
    const allUnmatchedBankMovements = filterUnmatchedMovements(rawBankMovements, allInvoices);

    const thresholdCents = toCents(SMALL_AMOUNT_THRESHOLD);
    let pagadasCount = 0;
    let montoPagadoCents = 0;
    let noPagadasCount = 0;
    let montoNoPagadoCents = 0;
    let egresosCount = 0;
    let montoEgresosCents = 0;
    let canceladasCount = 0;
    let montoCanceladoCents = 0;
    let montoTotalCents = 0;
    let menores50Count = 0;
    let montoMenores50Cents = 0;

    const invoices = [];

    for (const inv of allInvoices) {
      const totCents = toCents(inv.total);
      montoTotalCents += totCents;

      if (totCents < thresholdCents) {
        menores50Count++;
        montoMenores50Cents += totCents;
      }

      if (inv.estadoPago === 'Pagada') {
        pagadasCount++;
        montoPagadoCents += totCents;
      } else if (inv.estadoPago === 'No Pagada') {
        noPagadasCount++;
        montoNoPagadoCents += totCents;
      } else if (inv.estadoPago === 'Cancelada') {
        canceladasCount++;
        montoCanceladoCents += totCents;
      }

      if (inv.efecto === 'Egreso') {
        egresosCount++;
        montoEgresosCents += totCents;
      }

      if (totCents < thresholdCents) continue;

      if (
        filter === 'all' ||
        (filter === 'pagadas' && inv.estadoPago === 'Pagada') ||
        (filter === 'no_pagadas' && inv.estadoPago === 'No Pagada') ||
        (filter === 'egresos' && inv.efecto === 'Egreso') ||
        (filter === 'canceladas' && inv.estadoPago === 'Cancelada')
      ) {
        invoices.push(inv);
      }
    }

    let unmatchedMenores50Count = 0;
    let unmatchedMontoMenores50Cents = 0;
    let unmatchedBankMontoCents = 0;
    const unmatchedBankMovements = [];

    for (const m of allUnmatchedBankMovements) {
      const mvCents = toCents(m.monto);
      if (mvCents < thresholdCents) {
        unmatchedMenores50Count++;
        unmatchedMontoMenores50Cents += mvCents;
        menores50Count++;
        montoMenores50Cents += mvCents;
        continue;
      }
      unmatchedBankMovements.push(m);
      unmatchedBankMontoCents += mvCents;
    }

    const totalFacturas = allInvoices.length;
    const autoCreditNoteAssignments = buildAutoCreditNoteAssignments(allInvoices, rawBankMovements);

    return {
      success: true,
      periodo,
      entidad,
      hasCfdiFile: totalFacturas > 0,
      summary: {
        totalFacturas,
        montoTotal: fromCents(montoTotalCents),
        pagadasCount,
        montoPagado: fromCents(montoPagadoCents),
        noPagadasCount,
        montoNoPagado: fromCents(montoNoPagadoCents),
        egresosCount,
        montoEgresos: fromCents(montoEgresosCents),
        canceladasCount,
        montoCancelado: fromCents(montoCanceladoCents),
        menores50Count,
        montoMenores50: fromCents(montoMenores50Cents),
        unmatchedMenores50Count,
        unmatchedMontoMenores50: fromCents(unmatchedMontoMenores50Cents),
        bankMovementsCount,
        unmatchedBankCount: unmatchedBankMovements.length,
        unmatchedBankMonto: fromCents(unmatchedBankMontoCents)
      },
      bankStatements,
      invoices,
      unmatchedBankMovements,
      autoCreditNoteAssignments
    };
  };

  const undoAutoCreditNote = async (arg) => {
    const rawUuid = typeof arg === 'string' ? arg : arg?.uuid || arg?.invoiceUuid;
    const cleanUuid = normUuid(rawUuid);
    if (!cleanUuid) {
      throw httpError(400, 'Debe especificar el UUID de la factura.');
    }

    const invoice = await invoiceRepo.findByUuid(cleanUuid);
    if (!invoice) {
      throw httpError(404, 'Factura no encontrada.');
    }
    if (invoice.efecto === 'Egreso') {
      throw httpError(400, 'Debe especificar el UUID de la factura de ingreso, no el de la nota de crédito.');
    }
    if (!isAutoCreditNoteInvoice(invoice) && !invoice.egresoAsociado?.uuid && !invoice.pagoAsociado?.movimientoId) {
      throw httpError(400, 'La factura no tiene una asignación automática con nota de crédito para deshacer.');
    }

    const egresoUuid = invoice.egresoAsociado?.uuid || null;
    const movId = invoice.pagoAsociado?.movimientoId || null;

    if (movId) {
      if (typeof bankMovementRepo.releaseById === 'function') {
        await bankMovementRepo.releaseById(movId);
      } else if (typeof bankMovementRepo.bulkWrite === 'function') {
        await bankMovementRepo.bulkWrite([
          { updateOne: { filter: { _id: movId }, update: { $set: { conciliado: false, facturaUuid: null } } } }
        ]);
      }
    }

    let creditNote = null;
    if (egresoUuid) {
      creditNote = await invoiceRepo.findByUuid(egresoUuid);
      if (creditNote) {
        creditNote.ingresoAsociado = null;
        creditNote.editadoManualmente = false;
        if (typeof creditNote.save === 'function') {
          await invoiceRepo.save(creditNote);
        } else {
          if (typeof invoiceRepo.save === 'function') await invoiceRepo.save(creditNote);
          if (typeof invoiceRepo.bulkWrite === 'function') {
            await invoiceRepo.bulkWrite([
              { updateOne: { filter: { uuid: egresoUuid }, update: { $set: { ingresoAsociado: null, editadoManualmente: false } } } }
            ]);
          }
        }
      } else if (typeof invoiceRepo.bulkWrite === 'function') {
        await invoiceRepo.bulkWrite([
          { updateOne: { filter: { uuid: egresoUuid }, update: { $set: { ingresoAsociado: null, editadoManualmente: false } } } }
        ]);
      }
    }

    const resetFields = {
      estadoPago: 'No Pagada',
      egresoAsociado: null,
      pagoAsociado: null,
      asignacionAutomatica: null,
      editadoManualmente: false,
      rechazoAsignacionAutomatica: true
    };
    Object.assign(invoice, resetFields);
    if (typeof invoice.save === 'function') {
      await invoiceRepo.save(invoice);
    } else {
      if (typeof invoiceRepo.save === 'function') await invoiceRepo.save(invoice);
      if (typeof invoiceRepo.bulkWrite === 'function') {
        await invoiceRepo.bulkWrite([{ updateOne: { filter: { uuid: cleanUuid }, update: { $set: resetFields } } }]);
      }
    }

    return { invoice, creditNote, movementId: movId };
  };

  return {
    releaseMovementsLinkedTo,
    releaseInvoicesLinkedToMovements,
    recomputeStatementStats,
    fixLegacyBBVAClassification,
    runReconciliationForPeriod,
    runReconciliationForScopes,
    getPeriodData,
    undoAutoCreditNote
  };
};

const defaultService = createReconciliationService();

module.exports = {
  DEFAULT_PERIODO,
  DEFAULT_ENTIDAD,
  SMALL_AMOUNT_THRESHOLD,
  readPeriodo,
  readEntidad,
  movementTime,
  sortMovementsDesc,
  filterUnmatchedMovements,
  createReconciliationService,
  ...defaultService
};
