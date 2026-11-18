/**
 * Emparejador puro de Notas de Credito parciales (Egreso) con Facturas (Ingreso) y Retiros Bancarios.
 *
 * Regla de negocio:
 *   factura (Ingreso, No Pagada) - nota de credito (Egreso, Vigente, mismo RFC, menor al total) = retiro bancario libre
 *   Coincidencia EXACTA: toCents(factura) - toCents(nota) === toCents(retiro).
 */

const { parseFlexibleDate } = require('../utils/dates');
const { toCents, fromCents, round2 } = require('../utils/money');
const { normalizeText, matchVendorName, isBankFeeConcept } = require('../utils/text');

const AUTO_NC_TIPO = 'nota-credito-parcial';
// Coincidencia exacta al centavo (diferencia < 1 centavo)
const TOLERANCE_CENTS = 1;
const EXACT_TOLERANCE = 0.005;
const DAY_MS = 24 * 60 * 60 * 1000;

const isAutoCreditNoteInvoice = (inv) => Boolean(inv && inv.asignacionAutomatica?.tipo === AUTO_NC_TIPO);

/**
 * Empareja facturas pendientes con notas de credito parciales disponibles y retiros bancarios libres.
 * Funcion pura y determinista: cada factura, nota de credito y retiro se usa a lo sumo una vez.
 *
 * @param {Array<Object>} unpaidInvoices - Facturas candidatas (Ingreso, No Pagada)
 * @param {Array<Object>} availableCreditNotes - Notas de credito candidatas (Egreso, Vigente, sin ingresoAsociado)
 * @param {Array<Object>} freeWithdrawals - Retiros bancarios libres
 * @returns {Array<{invoiceUuid: string, creditNoteUuid: string, movementId: any, montoNota: number, montoRetiro: number, diferencia: number}>}
 */
const matchPartialCreditNotes = (unpaidInvoices = [], availableCreditNotes = [], freeWithdrawals = []) => {
  const safeInvoices = Array.isArray(unpaidInvoices) ? unpaidInvoices : [];
  const safeNotes = Array.isArray(availableCreditNotes) ? availableCreditNotes : [];
  const safeWithdrawals = Array.isArray(freeWithdrawals) ? freeWithdrawals : [];

  const txInfoList = [];
  const byCents = new Map();

  safeWithdrawals.forEach((tx, txIdx) => {
    if (!tx || typeof tx !== 'object') return;
    if (tx.tipo && tx.tipo !== 'Retiro') return;
    const monto = Number(tx.monto);
    const montoCents = toCents(monto);
    if (!Number.isFinite(monto) || montoCents <= 0) return;

    const info = {
      txIdx,
      tx,
      monto: round2(monto),
      montoCents,
      rfc: (tx.rfcDetectado || '').trim().toUpperCase(),
      concepto: tx.concepto,
      normConcept: normalizeText(tx.concepto),
      date: tx.fechaNormalizada ? parseFlexibleDate(tx.fechaNormalizada) : parseFlexibleDate(tx.fecha)
    };
    txInfoList.push(info);
    if (!byCents.has(montoCents)) byCents.set(montoCents, []);
    byCents.get(montoCents).push(info);
  });

  if (txInfoList.length === 0) return [];

  const notesByRfc = new Map();
  safeNotes.forEach((nc, ncIdx) => {
    if (!nc || typeof nc !== 'object') return;
    if ((nc.efecto || 'Egreso') !== 'Egreso') return;
    if ((nc.estadoSat || 'Vigente') !== 'Vigente') return;
    if (nc.ingresoAsociado?.uuid) return;

    const totalCents = toCents(nc.total);
    if (totalCents <= 0) return;

    const rfc = (nc.rfcEmisor || '').trim().toUpperCase();
    if (!rfc) return;

    if (!notesByRfc.has(rfc)) notesByRfc.set(rfc, []);
    notesByRfc.get(rfc).push({
      ncIdx,
      nc,
      total: round2(nc.total),
      totalCents,
      rfc,
      date: parseFlexibleDate(nc.fechaEmision)
    });
  });

  if (notesByRfc.size === 0) return [];

  const candidates = [];
  const maxDeltaCents = TOLERANCE_CENTS - 1;

  safeInvoices.forEach((inv, invIdx) => {
    if (!inv || typeof inv !== 'object') return;
    if ((inv.efecto || 'Ingreso') !== 'Ingreso') return;
    if ((inv.estadoSat || 'Vigente') !== 'Vigente') return;
    if ((inv.estadoPago || 'No Pagada') !== 'No Pagada') return;
    if (inv.egresoAsociado?.uuid) return;
    if (inv.rechazoAsignacionAutomatica) return;

    const invCents = toCents(inv.total);
    if (invCents <= 0) return;

    const invRfc = (inv.rfcEmisor || '').trim().toUpperCase();
    if (!invRfc) return;

    const matchingNotes = notesByRfc.get(invRfc);
    if (!matchingNotes || matchingNotes.length === 0) return;

    const normRfc = normalizeText(invRfc).replace(/\s+/g, '');
    const invDate = parseFlexibleDate(inv.fechaEmision);

    for (const noteInfo of matchingNotes) {
      if (inv.uuid && noteInfo.nc.uuid && inv.uuid === noteInfo.nc.uuid) continue;
      if (noteInfo.totalCents >= invCents) continue;

      const expectedWithdrawalCents = invCents - noteInfo.totalCents;
      if (expectedWithdrawalCents <= 0) continue;

      for (let c = expectedWithdrawalCents - maxDeltaCents; c <= expectedWithdrawalCents + maxDeltaCents; c++) {
        const txBucket = byCents.get(c);
        if (!txBucket) continue;

        for (const info of txBucket) {
          const diffCents = Math.abs(invCents - noteInfo.totalCents - info.montoCents);
          if (diffCents >= TOLERANCE_CENTS) continue;
          const diff = fromCents(diffCents);

          const rfcMatch =
            (invRfc && info.rfc && info.rfc === invRfc) ||
            (normRfc.length >= 12 && info.normConcept.replace(/\s+/g, '').includes(normRfc));
          const nameMatch = !rfcMatch && matchVendorName(inv.emisor, info.normConcept, true);

          // Una comision del banco no es pago a proveedor salvo que el retiro lo identifique
          if (isBankFeeConcept(info.concepto) && !rfcMatch && !nameMatch) continue;

          if (diff > EXACT_TOLERANCE && info.rfc && invRfc && info.rfc !== invRfc && !rfcMatch && !nameMatch) {
            continue;
          }

          let score = 0;
          if (rfcMatch) score += 1000;
          else if (nameMatch) score += 500;
          if (diff <= EXACT_TOLERANCE) score += 100;
          else score += Math.max(0, 50 - diff * 1000);

          if (invDate && info.date) {
            const days = Math.abs(info.date.getTime() - invDate.getTime()) / DAY_MS;
            score -= Math.min(days, 90) * 0.5;
          }

          const ncDateDiff =
            invDate && noteInfo.date ? Math.abs(noteInfo.date.getTime() - invDate.getTime()) : Number.MAX_SAFE_INTEGER;

          candidates.push({
            invIdx,
            ncIdx: noteInfo.ncIdx,
            txIdx: info.txIdx,
            score,
            diffCents,
            ncDateDiff,
            inv,
            nc: noteInfo.nc,
            tx: info.tx,
            montoNota: noteInfo.total,
            montoRetiro: info.monto,
            diferencia: diff
          });
        }
      }
    }
  });

  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      a.diffCents - b.diffCents ||
      a.ncDateDiff - b.ncDateDiff ||
      String(a.inv.uuid || '').localeCompare(String(b.inv.uuid || '')) ||
      String(a.nc.uuid || '').localeCompare(String(b.nc.uuid || '')) ||
      String(a.tx._id || '').localeCompare(String(b.tx._id || '')) ||
      a.invIdx - b.invIdx ||
      a.ncIdx - b.ncIdx ||
      a.txIdx - b.txIdx
  );

  const usedInvUuid = new Set();
  const usedNcUuid = new Set();
  const usedTxId = new Set();
  const usedInvIdx = new Set();
  const usedNcIdx = new Set();
  const usedTxIdx = new Set();
  const assignments = [];

  for (const c of candidates) {
    const invKey = c.inv.uuid || `idx:${c.invIdx}`;
    const ncKey = c.nc.uuid || `idx:${c.ncIdx}`;
    const txKey = c.tx._id !== undefined && c.tx._id !== null ? String(c.tx._id) : `idx:${c.txIdx}`;

    if (
      usedInvUuid.has(invKey) ||
      usedNcUuid.has(ncKey) ||
      usedTxId.has(txKey) ||
      usedInvIdx.has(c.invIdx) ||
      usedNcIdx.has(c.ncIdx) ||
      usedTxIdx.has(c.txIdx)
    ) {
      continue;
    }

    usedInvUuid.add(invKey);
    usedNcUuid.add(ncKey);
    usedTxId.add(txKey);
    usedInvIdx.add(c.invIdx);
    usedNcIdx.add(c.ncIdx);
    usedTxIdx.add(c.txIdx);

    assignments.push({
      invoiceUuid: c.inv.uuid,
      creditNoteUuid: c.nc.uuid,
      movementId: c.tx._id ?? null,
      montoNota: c.montoNota,
      montoRetiro: c.montoRetiro,
      diferencia: c.diferencia
    });
  }

  return assignments;
};

/**
 * Revisa las facturas que ya tenian asignacion automatica por nota de credito parcial.
 * Conserva aquellas cuya nota y retiro siguen existiendo y son validos; libera las que perdieron su nota o su retiro.
 */
const separateExistingAutoCreditNotes = ({
  invoices = [],
  bankMovements = [],
  manualInvoices = [],
  manuallyUsedMovementIds = new Set(),
  externalReservations = new Map()
}) => {
  const invoicesByUuid = new Map(invoices.map((i) => [i.uuid, i]));
  const movementsById = new Map(bankMovements.map((m) => [String(m._id), m]));
  const manuallyUsedEgresoUuids = new Set(manualInvoices.map((i) => i.egresoAsociado?.uuid).filter(Boolean));

  const preservedInvoices = [];
  const preservedInvoiceUuids = new Set();
  const preservedCreditNoteUuids = new Set();
  const preservedMovementIds = new Set();
  const releasedInvoicesByUuid = new Map();
  const releasedCreditNotesByUuid = new Map();
  const repairedCreditNotesByUuid = new Map();

  for (const inv of invoices) {
    if (!isAutoCreditNoteInvoice(inv)) continue;
    if (inv.editadoManualmente) continue;

    const ncUuid = inv.egresoAsociado?.uuid || null;
    const nc = ncUuid ? invoicesByUuid.get(ncUuid) : null;
    const movId = inv.pagoAsociado?.movimientoId ? String(inv.pagoAsociado.movimientoId) : null;
    const mov = movId ? movementsById.get(movId) : null;

    const invCents = toCents(inv.total);
    const ncCents = nc ? toCents(nc.total) : 0;
    const movCents = mov ? toCents(mov.monto) : 0;
    const invRfc = (inv.rfcEmisor || '').trim().toUpperCase();
    const ncRfc = nc ? (nc.rfcEmisor || '').trim().toUpperCase() : '';

    const isStillValid =
      inv.estadoPago === 'Pagada' &&
      !inv.rechazoAsignacionAutomatica &&
      (inv.estadoSat || 'Vigente') === 'Vigente' &&
      (inv.efecto || 'Ingreso') === 'Ingreso' &&
      Boolean(nc) &&
      (nc.efecto || 'Egreso') === 'Egreso' &&
      (nc.estadoSat || 'Vigente') === 'Vigente' &&
      !manuallyUsedEgresoUuids.has(ncUuid) &&
      !preservedCreditNoteUuids.has(ncUuid) &&
      (!nc.ingresoAsociado?.uuid || nc.ingresoAsociado.uuid === inv.uuid) &&
      Boolean(mov) &&
      // Asignaciones previas contra comisiones del banco se liberan (caso real: tasa de descuento de terminal)
      !isBankFeeConcept(mov.concepto) &&
      !manuallyUsedMovementIds.has(movId) &&
      !externalReservations.has(movId) &&
      !preservedMovementIds.has(movId) &&
      invRfc.length > 0 &&
      invRfc === ncRfc &&
      ncCents > 0 &&
      ncCents < invCents &&
      Math.abs(invCents - ncCents - movCents) < TOLERANCE_CENTS;

    if (isStillValid) {
      preservedInvoices.push(inv);
      preservedInvoiceUuids.add(inv.uuid);
      preservedCreditNoteUuids.add(ncUuid);
      preservedMovementIds.add(movId);
      if (nc.ingresoAsociado?.uuid !== inv.uuid) {
        repairedCreditNotesByUuid.set(ncUuid, {
          ...nc,
          ingresoAsociado: {
            uuid: inv.uuid,
            total: inv.total,
            fechaEmision: inv.fechaEmision,
            emisor: inv.emisor
          },
          editadoManualmente: false
        });
      }
    } else {
      releasedInvoicesByUuid.set(inv.uuid, {
        ...inv,
        estadoPago: inv.estadoSat === 'Cancelado' ? 'Cancelada' : 'No Pagada',
        pagoAsociado: null,
        egresoAsociado: null,
        asignacionAutomatica: null,
        editadoManualmente: false
      });
    }
  }

  for (const nc of invoices) {
    if (nc.efecto !== 'Egreso' || !nc.ingresoAsociado?.uuid || nc.editadoManualmente) continue;
    if (preservedCreditNoteUuids.has(nc.uuid)) continue;
    const targetIngreso = invoicesByUuid.get(nc.ingresoAsociado.uuid);
    const linkedManually = targetIngreso && targetIngreso.editadoManualmente && targetIngreso.egresoAsociado?.uuid === nc.uuid;
    if (!linkedManually) {
      releasedCreditNotesByUuid.set(nc.uuid, {
        ...nc,
        ingresoAsociado: null,
        editadoManualmente: false
      });
    }
  }

  const workingInvoices = invoices.map(
    (i) => releasedInvoicesByUuid.get(i.uuid) || releasedCreditNotesByUuid.get(i.uuid) || repairedCreditNotesByUuid.get(i.uuid) || i
  );

  return {
    workingInvoices,
    manuallyUsedEgresoUuids,
    preservedInvoices,
    preservedInvoiceUuids,
    preservedCreditNoteUuids,
    preservedMovementIds,
    releasedInvoicesByUuid,
    releasedCreditNotesByUuid,
    repairedCreditNotesByUuid
  };
};

/**
 * Construye la lista de asignaciones automaticas por nota de credito parcial del periodo.
 */
const buildAutoCreditNoteAssignments = (allInvoices = [], rawBankMovements = []) => {
  const movementsById = new Map((rawBankMovements || []).map((m) => [String(m._id), m]));
  const invoicesByUuid = new Map((allInvoices || []).map((i) => [i.uuid, i]));

  const list = [];
  for (const inv of allInvoices || []) {
    if (!isAutoCreditNoteInvoice(inv) || inv.estadoPago !== 'Pagada') continue;
    const eg = inv.egresoAsociado || {};
    const pg = inv.pagoAsociado || {};
    const ncDoc = eg.uuid ? invoicesByUuid.get(eg.uuid) : null;
    const movDoc = pg.movimientoId ? movementsById.get(String(pg.movimientoId)) : null;

    const montoNota = round2(eg.total ?? ncDoc?.total ?? 0);
    const montoRetiro = round2(pg.montoRetiro ?? movDoc?.monto ?? 0);
    const suma = fromCents(toCents(montoNota) + toCents(montoRetiro));
    const diferencia = round2(pg.diferencia ?? Math.abs(toCents(inv.total) - toCents(suma)) / 100);

    list.push({
      invoiceUuid: inv.uuid,
      emisor: inv.emisor,
      rfcEmisor: inv.rfcEmisor,
      facturaTotal: round2(inv.total),
      fechaEmision: inv.fechaEmision,
      creditNoteUuid: eg.uuid || '',
      montoNota,
      fechaNota: eg.fechaEmision || ncDoc?.fechaEmision || '',
      movementId: pg.movimientoId || null,
      banco: pg.banco || movDoc?.banco || 'Banco',
      fechaRetiro: pg.fechaPago || movDoc?.fecha || '',
      conceptoRetiro: pg.conceptoBanco || movDoc?.concepto || '',
      referenciaRetiro: pg.referencia || movDoc?.origenReferencia || '',
      montoRetiro,
      suma,
      diferencia,
      cuadra: Math.abs(toCents(inv.total) - toCents(montoNota) - toCents(montoRetiro)) < TOLERANCE_CENTS,
      fechaAsignacion: inv.asignacionAutomatica?.fecha || null
    });
  }
  return list;
};

module.exports = {
  AUTO_NC_TIPO,
  TOLERANCE_CENTS,
  isAutoCreditNoteInvoice,
  matchPartialCreditNotes,
  separateExistingAutoCreditNotes,
  buildAutoCreditNoteAssignments
};
