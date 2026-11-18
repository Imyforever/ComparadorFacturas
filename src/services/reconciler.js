/**
 * Motor de Conciliacion entre Facturas del SAT y Movimientos Bancarios
 *
 * Estrategia:
 *  1. Se generan los pares (factura, retiro) cuyo importe coincide al centavo, o difiere hasta
 *     MAX_DIFF_CENTS (redondeos/comisiones del banco) SOLO si el RFC o el nombre del proveedor
 *     aparece en el retiro. Asi no se liga una factura a un pago ajeno por centavos.
 *  2. Cada par recibe un puntaje: RFC coincidente > nombre de proveedor coincidente > monto exacto,
 *     con desempate por cercania entre la fecha de emision y la fecha del retiro.
 *  3. Se asignan los pares de mayor a menor puntaje sin reutilizar facturas ni retiros.
 */

const { parseFlexibleDate } = require('../utils/dates');
const { toCents, fromCents, round2 } = require('../utils/money');
const { normalizeText, matchVendorName } = require('../utils/text');

// Diferencia maxima (en centavos) aceptada cuando el retiro identifica al proveedor.
const MAX_DIFF_CENTS = 4;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Ejecuta la conciliacion entre una lista de facturas y retiros bancarios
 * @param {Array<Object>} invoices - Lista de facturas (CFDI)
 * @param {Array<Object>} bankTransactions - Lista de movimientos bancarios (Retiros)
 * @returns {Object} Resultado de la conciliacion con facturas actualizadas y resumen
 */
const reconcile = (invoices = [], bankTransactions = [], { maxDiffCents = MAX_DIFF_CENTS } = {}) => {
  const safeInvoices = Array.isArray(invoices) ? invoices : [];
  const withdrawals = (Array.isArray(bankTransactions) ? bankTransactions : []).filter(
    (tx) => tx && tx.tipo === 'Retiro' && Number.isFinite(Number(tx.monto))
  );

  const txInfo = withdrawals.map((tx) => ({
    monto: Number(tx.monto),
    montoCents: toCents(tx.monto),
    rfc: (tx.rfcDetectado || '').toUpperCase(),
    normConcept: normalizeText(tx.concepto),
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

    const invRfc = (inv.rfcEmisor || '').toUpperCase();
    const normRfc = normalizeText(invRfc).replace(/\s+/g, '');
    const invDate = parseFlexibleDate(inv.fechaEmision);

    for (let c = totalCents - maxDiffCents; c <= totalCents + maxDiffCents; c++) {
      const idxs = byCents.get(c);
      if (!idxs) continue;

      for (const txIdx of idxs) {
        const info = txInfo[txIdx];
        const diffCents = Math.abs(info.montoCents - totalCents);
        const diff = fromCents(diffCents);

        const rfcMatch =
          (invRfc && info.rfc && info.rfc === invRfc) ||
          (normRfc.length >= 12 && info.normConcept.replace(/\s+/g, '').includes(normRfc));
        const nameMatch = !rfcMatch && matchVendorName(inv.emisor, info.normConcept, true);

        // Con diferencia de centavos solo se acepta si el retiro identifica al proveedor
        if (diffCents > 0 && !rfcMatch && !nameMatch) continue;

        let score = 0;
        if (rfcMatch) score += 1000;
        else if (nameMatch) score += 500;
        if (diffCents === 0) score += 100;
        else score += Math.max(0, 50 - diffCents * 10);

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

  const unmatchedWithdrawals = withdrawals.filter((_, idx) => !usedTx.has(idx));

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
      movimientosBancariosCount: withdrawals.length,
      movimientosNoAsociadosCount: unmatchedWithdrawals.length
    },
    reconciledInvoices,
    unmatchedWithdrawals
  };
};

module.exports = {
  MAX_DIFF_CENTS,
  reconcile,
  normalizeText,
  matchVendorName
};
