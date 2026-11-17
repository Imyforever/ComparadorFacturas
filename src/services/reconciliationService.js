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
const { parseFlexibleDate, PERIODO_REGEX } = require('../utils/dates');
const { toCents, fromCents, round2, sameAmount } = require('../utils/money');
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
  accountTabRepo = defaultAccountTabRepo
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

    const availableMovements = bankMovements.filter(
      (m) => !manuallyUsedMovementIds.has(String(m._id)) && !externalReservations.has(String(m._id))
    );

    const autoInvoices = invoices.filter((i) => !i.editadoManualmente || i.estadoPago === 'No Pagada');
    const { summary, reconciledInvoices } = reconcile(autoInvoices, availableMovements);

    const originalByUuid = new Map(autoInvoices.map((i) => [i.uuid, i]));
    const bulkInvoiceOps = [];
    for (const inv of reconciledInvoices) {
      const before = originalByUuid.get(inv.uuid);
      const resetManual = inv.estadoPago === 'Pagada' && before?.editadoManualmente;
      if (before && before.estadoPago === inv.estadoPago && samePago(before.pagoAsociado, inv.pagoAsociado) && !resetManual) {
        continue;
      }
      bulkInvoiceOps.push({
        updateOne: {
          filter: { uuid: inv.uuid },
          update: {
            $set: {
              estadoPago: inv.estadoPago,
              pagoAsociado: inv.pagoAsociado,
              ...(inv.estadoPago === 'Pagada' ? { editadoManualmente: false } : {})
            }
          }
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
      unmatchedBankMovements
    };
  };

  return {
    releaseMovementsLinkedTo,
    releaseInvoicesLinkedToMovements,
    recomputeStatementStats,
    fixLegacyBBVAClassification,
    runReconciliationForPeriod,
    runReconciliationForScopes,
    getPeriodData
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
