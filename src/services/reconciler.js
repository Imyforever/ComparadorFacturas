/**
 * Motor de Conciliacion entre Facturas del SAT y Movimientos Bancarios
 *
 * Estrategia:
 *  1. Se generan los pares (factura, retiro) cuyo importe coincide al centavo. Con "proveedor identificado"
 *     (vendorMatch = RFC, nombre o alias aprendido del proveedor en el retiro) tambien se aceptan:
 *       - hasta MAX_DIFF_CENTS de diferencia (redondeos/comisiones del banco), y
 *       - redondeo a peso: retiro en pesos cerrados (centavos = 0) con diferencia menor a 1 peso.
 *     Asi no se liga una factura a un pago ajeno por centavos.
 *  2. Cada par recibe un puntaje: RFC coincidente > nombre/alias de proveedor > monto (exacto > hasta 4
 *     centavos > redondeo a peso), con desempate por cercania entre la fecha de emision y la del retiro.
 *  3. Los retiros marcados con mesAnterior (libres del mes anterior) solo casan con vendorMatch y con
 *     una penalizacion de puntaje, para que siempre gane un retiro del propio mes.
 *     Los cargos propios del banco (comisiones de terminal, IVA de comisiones) tambien exigen vendorMatch.
 *  4. Se asignan los pares de mayor a menor puntaje sin reutilizar facturas ni retiros.
 */

const { parseFlexibleDate } = require('../utils/dates');
const { toCents, fromCents, round2 } = require('../utils/money');
const { normalizeText, matchVendorName } = require('../utils/text');
const { buildConceptInfo, matchVendor } = require('./vendorMatch');

// Diferencia maxima (en centavos) aceptada cuando el retiro identifica al proveedor.
const MAX_DIFF_CENTS = 4;
// Redondeo a peso: el retiro es en pesos cerrados y la diferencia es menor a 100 centavos.
const ROUND_PESO_LIMIT_CENTS = 100;
const ROUND_PESO_SCORE = 5;
// Penalizacion de puntaje para retiros libres del mes anterior.
const MES_ANTERIOR_PENALTY = 150;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Ejecuta la conciliacion entre una lista de facturas y retiros bancarios
 * @param {Array<Object>} invoices - Lista de facturas (CFDI)
 * @param {Array<Object>} bankTransactions - Lista de movimientos bancarios (Retiros)
 * @param {Object} [options]
 * @param {number} [options.maxDiffCents] - Diferencia maxima en centavos con proveedor identificado
 * @param {Map<string, Set<string>>} [options.aliases] - Alias aprendidos (vendorAliases.learnVendorAliases)
 * @returns {Object} Resultado de la conciliacion con facturas actualizadas y resumen
 */
const reconcile = (invoices = [], bankTransactions = [], { maxDiffCents = MAX_DIFF_CENTS, aliases = null } = {}) => {
  const safeInvoices = Array.isArray(invoices) ? invoices : [];
  const withdrawals = (Array.isArray(bankTransactions) ? bankTransactions : []).filter(
    (tx) => tx && tx.tipo === 'Retiro' && Number.isFinite(Number(tx.monto))
  );

  const txInfo = withdrawals.map((tx) => ({
    ...buildConceptInfo(tx),
    monto: Number(tx.monto),
    montoCents: toCents(tx.monto),
    mesAnterior: Boolean(tx.mesAnterior),
    date: tx.fechaNormalizada ? parseFlexibleDate(tx.fechaNormalizada) : parseFlexibleDate(tx.fecha)
  }));

  const byCents = new Map();
  txInfo.forEach((info, idx) => {
    const cents = info.montoCents;
    if (!byCents.has(cents)) byCents.set(cents, []);
    byCents.get(cents).push(idx);
  });

  const results = new Array(safeInvoices.length);
  const pairs = [];

  safeInvoices.forEach((inv, invIdx) => {
    if (inv.estadoSat === 'Cancelado') {
      results[invIdx] = { ...inv, estadoPago: 'Cancelada', pagoAsociado: null };
      return;
    }

    const total = Number(inv.total || 0);
    const totalCents = toCents(total);

    if (inv.efecto === 'Egreso' || inv.efecto === 'Traslado' || totalCents === 0) {
      results[invIdx] = { ...inv, estadoPago: 'No Aplica', pagoAsociado: null };
      return;
    }

    const invDate = parseFlexibleDate(inv.fechaEmision);
    const searchRadius = Math.max(maxDiffCents, ROUND_PESO_LIMIT_CENTS - 1);

    for (let c = totalCents - searchRadius; c <= totalCents + searchRadius; c++) {
      const idxs = byCents.get(c);
      if (!idxs) continue;

      for (const txIdx of idxs) {
        const info = txInfo[txIdx];
        const diffCents = Math.abs(info.montoCents - totalCents);
        const diff = fromCents(diffCents);

        const withinCents = diffCents <= maxDiffCents;
        const roundToPeso = !withinCents && info.montoCents % 100 === 0 && diffCents < ROUND_PESO_LIMIT_CENTS;
        if (!withinCents && !roundToPeso) continue;

        const { rfcMatch, vendorMatch } = matchVendor(inv, info, aliases);

        // Los retiros del mes anterior y cualquier diferencia de centavos/redondeo exigen proveedor identificado
        // Comisiones del banco tampoco: sin proveedor identificado coinciden con facturas chicas por casualidad
        if ((info.mesAnterior || info.isBankFee || diffCents > 0) && !vendorMatch) continue;

        let score = 0;
        if (rfcMatch) score += 1000;
        else if (vendorMatch) score += 500;
        if (diffCents === 0) score += 100;
        else if (withinCents) score += Math.max(0, 50 - diffCents * 10);
        else score += ROUND_PESO_SCORE - diffCents / ROUND_PESO_LIMIT_CENTS;
        if (info.mesAnterior) score -= MES_ANTERIOR_PENALTY;

        if (invDate && info.date) {
          const days = Math.abs(info.date.getTime() - invDate.getTime()) / DAY_MS;
          score -= Math.min(days, 90) * 0.5;
        }

        pairs.push({ invIdx, txIdx, score, diff });
      }
    }
  });

  pairs.sort((a, b) => b.score - a.score || a.invIdx - b.invIdx || a.txIdx - b.txIdx);

  const usedTx = new Set();
  const matchedInv = new Map();
  for (const p of pairs) {
    if (matchedInv.has(p.invIdx) || usedTx.has(p.txIdx)) continue;
    matchedInv.set(p.invIdx, p);
    usedTx.add(p.txIdx);
  }

  let pagadasCount = 0;
  let montoPagadoCents = 0;
  let noPagadasCount = 0;
  let montoNoPagadoCents = 0;
  let canceladasCount = 0;
  let montoCanceladoCents = 0;
  let montoTotalCents = 0;

  const reconciledInvoices = safeInvoices.map((inv, invIdx) => {
    const invCents = toCents(inv.total);
    montoTotalCents += invCents;

    if (results[invIdx]) {
      if (results[invIdx].estadoPago === 'Cancelada') {
        canceladasCount++;
        montoCanceladoCents += invCents;
      }
      return results[invIdx];
    }

    const match = matchedInv.get(invIdx);
    if (match) {
      const tx = withdrawals[match.txIdx];
      pagadasCount++;
      montoPagadoCents += invCents;
      return {
        ...inv,
        estadoPago: 'Pagada',
        pagoAsociado: {
          movimientoId: tx._id || null,
          banco: tx.banco || 'Banco',
          fechaPago: tx.fecha,
          montoRetiro: tx.monto,
          diferencia: round2(match.diff),
          conceptoBanco: tx.concepto,
          referencia: tx.origenReferencia || ''
        }
      };
    }

    noPagadasCount++;
    montoNoPagadoCents += invCents;
    return { ...inv, estadoPago: 'No Pagada', pagoAsociado: null };
  });

  // Los retiros del mes anterior no cuentan en el resumen del mes ni se devuelven como "sin asociar"
  const unmatchedWithdrawals = withdrawals.filter((tx, idx) => !usedTx.has(idx) && !tx.mesAnterior);
  const ownWithdrawalsCount = withdrawals.filter((tx) => !tx.mesAnterior).length;

  return {
    summary: {
      totalFacturas: safeInvoices.length,
      montoTotalFacturas: fromCents(montoTotalCents),
      pagadasCount,
      montoPagado: fromCents(montoPagadoCents),
      noPagadasCount,
      montoNoPagado: fromCents(montoNoPagadoCents),
      canceladasCount,
      montoCancelado: fromCents(montoCanceladoCents),
      movimientosBancariosCount: ownWithdrawalsCount,
      movimientosNoAsociadosCount: unmatchedWithdrawals.length
    },
    reconciledInvoices,
    unmatchedWithdrawals
  };
};

module.exports = {
  MAX_DIFF_CENTS,
  ROUND_PESO_LIMIT_CENTS,
  MES_ANTERIOR_PENALTY,
  reconcile,
  normalizeText,
  matchVendorName
};
