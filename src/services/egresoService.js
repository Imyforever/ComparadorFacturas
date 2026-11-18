/**
 * Servicio de vinculacion de facturas con Notas de Credito (Egresos).
 */

const defaultInvoiceRepo = require('../repositories/invoiceRepository');
const defaultBankMovementRepo = require('../repositories/bankMovementRepository');
const { readPeriodo } = require('./reconciliationService');
const { dateOnly } = require('../utils/dates');
const { toCents, diffAmount } = require('../utils/money');
const { normUuid } = require('../utils/text');
const { httpError } = require('../utils/errors');

const AUTO_EGRESO_OBS_REGEX = /^Aplicada a Factura /;

const createEgresoService = ({
  invoiceRepo = defaultInvoiceRepo,
  bankMovementRepo = defaultBankMovementRepo,
  clock = () => new Date()
} = {}) => {
  const releaseEgreso = async (egresoUuid) => {
    if (!egresoUuid) return;
    const egreso = await invoiceRepo.findByUuid(egresoUuid);
    if (!egreso) return;
    egreso.ingresoAsociado = null;
    egreso.editadoManualmente = false;
    if (AUTO_EGRESO_OBS_REGEX.test(egreso.observaciones || '')) egreso.observaciones = '';
    await invoiceRepo.save(egreso);
  };

  const releaseIngresoFromEgreso = async (ingresoUuid, egresoUuid) => {
    if (!ingresoUuid) return;
    const ingreso = await invoiceRepo.findByUuid(ingresoUuid);
    if (!ingreso) return;
    if (egresoUuid && ingreso.egresoAsociado?.uuid && ingreso.egresoAsociado.uuid !== egresoUuid) return;
    ingreso.egresoAsociado = null;
    if (!ingreso.pagoAsociado?.movimientoId && ingreso.pagoAsociado?.referencia === egresoUuid) {
      ingreso.pagoAsociado = null;
      ingreso.estadoPago = 'No Pagada';
      ingreso.editadoManualmente = false;
    }
    await invoiceRepo.save(ingreso);
  };

  const linkEgreso = async ({ ingresoUuid: rawIngresoUuid, egresoUuid: rawEgresoUuid, observaciones }) => {
    const cleanIngresoUuid = normUuid(rawIngresoUuid);
    const cleanEgresoUuid = normUuid(rawEgresoUuid);
    if (!cleanIngresoUuid || !cleanEgresoUuid) {
      throw httpError(400, 'Debe especificar ingresoUuid y egresoUuid.');
    }
    if (cleanIngresoUuid === cleanEgresoUuid) {
      throw httpError(400, 'La factura y la nota de crédito deben ser comprobantes distintos.');
    }

    const [ingreso, egreso] = await Promise.all([
      invoiceRepo.findByUuid(cleanIngresoUuid),
      invoiceRepo.findByUuid(cleanEgresoUuid)
    ]);
    if (!ingreso) {
      throw httpError(404, 'Factura de ingreso no encontrada.');
    }
    if (!egreso) {
      throw httpError(404, 'Nota de crédito (Egreso) no encontrada.');
    }
    if (egreso.efecto !== 'Egreso') {
      throw httpError(400, 'El comprobante a vincular debe ser de tipo "Egreso" (Nota de Crédito).');
    }
    if (ingreso.efecto === 'Egreso') {
      throw httpError(400, 'Una Nota de Crédito no puede amortizarse con otra Nota de Crédito.');
    }

    if (ingreso.pagoAsociado?.movimientoId) {
      await bankMovementRepo.releaseById(ingreso.pagoAsociado.movimientoId);
    }

    if (ingreso.egresoAsociado?.uuid && ingreso.egresoAsociado.uuid !== egreso.uuid) {
      await releaseEgreso(ingreso.egresoAsociado.uuid);
    }

    if (egreso.ingresoAsociado?.uuid && egreso.ingresoAsociado.uuid !== ingreso.uuid) {
      await invoiceRepo.clearEgresoFromIngreso(egreso.ingresoAsociado.uuid);
    }

    const now = clock();
    ingreso.estadoPago = 'Pagada';
    ingreso.editadoManualmente = true;
    ingreso.fechaEdicionManual = now;
    ingreso.asignacionAutomatica = null;
    ingreso.egresoAsociado = {
      uuid: egreso.uuid,
      total: egreso.total,
      fechaEmision: egreso.fechaEmision,
      emisor: egreso.emisor
    };
    ingreso.pagoAsociado = {
      movimientoId: null,
      banco: 'Nota de Crédito (Egreso)',
      fechaPago: dateOnly(egreso.fechaEmision) || dateOnly(ingreso.fechaEmision),
      montoRetiro: egreso.total,
      diferencia: diffAmount(egreso.total, ingreso.total),
      conceptoBanco: `Nota de Crédito SAT: ${egreso.uuid}`,
      referencia: egreso.uuid
    };
    if (typeof observaciones === 'string' && observaciones.trim()) {
      ingreso.observaciones = observaciones.trim();
    } else if (!ingreso.observaciones || ingreso.observaciones === 'Sin observaciones') {
      ingreso.observaciones = `Amortizada con Nota de Crédito ${egreso.uuid.substring(0, 8)}...`;
    }
    await invoiceRepo.save(ingreso);

    egreso.ingresoAsociado = {
      uuid: ingreso.uuid,
      total: ingreso.total,
      fechaEmision: ingreso.fechaEmision,
      emisor: ingreso.emisor
    };
    egreso.editadoManualmente = true;
    egreso.fechaEdicionManual = now;
    if (
      !egreso.observaciones ||
      egreso.observaciones === 'Sin observaciones' ||
      AUTO_EGRESO_OBS_REGEX.test(egreso.observaciones)
    ) {
      egreso.observaciones = `Aplicada a Factura ${ingreso.uuid.substring(0, 8)}... (${ingreso.emisor})`;
    }
    await invoiceRepo.save(egreso);

    return { ingreso, egreso };
  };

  const unlinkEgreso = async ({ ingresoUuid: rawIngresoUuid, egresoUuid: rawEgresoUuid }) => {
    const ingresoUuid = normUuid(rawIngresoUuid);
    const egresoUuid = normUuid(rawEgresoUuid);
    if (!ingresoUuid && !egresoUuid) {
      throw httpError(400, 'Debe especificar ingresoUuid o egresoUuid.');
    }

    let targetIngreso = null;
    let targetEgreso = null;

    if (ingresoUuid) {
      targetIngreso = await invoiceRepo.findByUuid(ingresoUuid);
      if (targetIngreso && targetIngreso.egresoAsociado?.uuid) {
        targetEgreso = await invoiceRepo.findByUuid(targetIngreso.egresoAsociado.uuid);
      }
    } else {
      targetEgreso = await invoiceRepo.findByUuid(egresoUuid);
      if (targetEgreso && targetEgreso.ingresoAsociado?.uuid) {
        targetIngreso = await invoiceRepo.findByUuid(targetEgreso.ingresoAsociado.uuid);
      }
    }

    if (targetIngreso) {
      const linkedEgresoUuid = targetEgreso?.uuid || targetIngreso.egresoAsociado?.uuid;
      const wasAutoPartialNc = targetIngreso.asignacionAutomatica?.tipo === 'nota-credito-parcial';
      targetIngreso.egresoAsociado = null;
      targetIngreso.asignacionAutomatica = null;
      if (wasAutoPartialNc && targetIngreso.pagoAsociado?.movimientoId) {
        await bankMovementRepo.releaseById(targetIngreso.pagoAsociado.movimientoId);
        targetIngreso.pagoAsociado = null;
        targetIngreso.estadoPago = 'No Pagada';
        targetIngreso.editadoManualmente = false;
      } else if (
        !targetIngreso.pagoAsociado?.movimientoId &&
        (targetIngreso.pagoAsociado?.banco?.includes('Nota de Crédito') ||
          (linkedEgresoUuid && targetIngreso.pagoAsociado?.referencia === linkedEgresoUuid))
      ) {
        targetIngreso.pagoAsociado = null;
        targetIngreso.estadoPago = 'No Pagada';
        targetIngreso.editadoManualmente = false;
      }
      await invoiceRepo.save(targetIngreso);
    }

    if (targetEgreso) {
      targetEgreso.ingresoAsociado = null;
      targetEgreso.editadoManualmente = false;
      if (AUTO_EGRESO_OBS_REGEX.test(targetEgreso.observaciones || '')) targetEgreso.observaciones = '';
      await invoiceRepo.save(targetEgreso);
    }
  };

  const autoLinkEgresos = async ({ periodo: rawPeriodo, entidad }) => {
    if (!rawPeriodo || !entidad) {
      throw httpError(400, 'Debe especificar periodo y entidad.');
    }
    const periodo = readPeriodo(rawPeriodo);

    const [ingresos, egresos] = await Promise.all([
      invoiceRepo.findVigentesByEfecto(periodo, entidad, 'Ingreso'),
      invoiceRepo.findVigentesByEfecto(periodo, entidad, 'Egreso')
    ]);

    const usedEgresoUuids = new Set(ingresos.map((i) => i.egresoAsociado?.uuid).filter(Boolean));

    const availableByKey = new Map();
    for (const e of egresos) {
      if (usedEgresoUuids.has(e.uuid) || e.ingresoAsociado?.uuid) continue;
      const key = `${e.rfcEmisor}|${toCents(e.total)}`;
      if (!availableByKey.has(key)) availableByKey.set(key, []);
      availableByKey.get(key).push(e);
    }

    const unlinkedIngresos = ingresos.filter(
      (i) => !i.egresoAsociado?.uuid && !i.pagoAsociado?.movimientoId && i.estadoPago !== 'Pagada'
    );

    let linkedCount = 0;
    const bulkOps = [];
    const now = clock();

    for (const ing of unlinkedIngresos) {
      const key = `${ing.rfcEmisor}|${toCents(ing.total)}`;
      const bucket = availableByKey.get(key);
      if (!bucket || bucket.length === 0) continue;

      const eg = bucket.shift();
      linkedCount++;

      bulkOps.push({
        updateOne: {
          filter: { uuid: ing.uuid },
          update: {
            $set: {
              estadoPago: 'Pagada',
              editadoManualmente: true,
              fechaEdicionManual: now,
              egresoAsociado: {
                uuid: eg.uuid,
                total: eg.total,
                fechaEmision: eg.fechaEmision,
                emisor: eg.emisor
              },
              pagoAsociado: {
                movimientoId: null,
                banco: 'Nota de Crédito (Egreso)',
                fechaPago: dateOnly(eg.fechaEmision),
                montoRetiro: eg.total,
                diferencia: 0.0,
                conceptoBanco: `Nota de Crédito SAT: ${eg.uuid}`,
                referencia: eg.uuid
              },
              ...(ing.observaciones && ing.observaciones !== 'Sin observaciones'
                ? {}
                : { observaciones: `Amortizada automáticamente con Nota de Crédito ${eg.uuid.substring(0, 8)}...` })
            }
          }
        }
      });

      bulkOps.push({
        updateOne: {
          filter: { uuid: eg.uuid },
          update: {
            $set: {
              ingresoAsociado: {
                uuid: ing.uuid,
                total: ing.total,
                fechaEmision: ing.fechaEmision,
                emisor: ing.emisor
              },
              editadoManualmente: true,
              fechaEdicionManual: now,
              ...(eg.observaciones && !AUTO_EGRESO_OBS_REGEX.test(eg.observaciones) && eg.observaciones !== 'Sin observaciones'
                ? {}
                : { observaciones: `Aplicada a Factura ${ing.uuid.substring(0, 8)}... (${ing.emisor})` })
            }
          }
        }
      });
    }

    if (bulkOps.length > 0) {
      await invoiceRepo.bulkWrite(bulkOps);
    }

    return { linkedCount };
  };

  return {
    releaseEgreso,
    releaseIngresoFromEgreso,
    linkEgreso,
    unlinkEgreso,
    autoLinkEgresos
  };
};

const defaultService = createEgresoService();

module.exports = {
  AUTO_EGRESO_OBS_REGEX,
  createEgresoService,
  ...defaultService
};
