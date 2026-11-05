/**
 * Motor de Conciliacion entre Facturas del SAT y Movimientos Bancarios
 *
 * Estrategia:
 *  1. Se generan todos los pares (factura, retiro) cuyo importe coincide (tolerancia de 5 centavos).
 *  2. Cada par recibe un puntaje: RFC coincidente > nombre de proveedor coincidente > monto exacto,
 *     con desempate por cercania entre la fecha de emision y la fecha del retiro.
 *  3. Se asignan los pares de mayor a menor puntaje sin reutilizar facturas ni retiros.
 *
 * Esto evita que una factura procesada primero "robe" un retiro que corresponde, por RFC o nombre,
 * a otra factura del mismo importe.
 */

const { parseFlexibleDate } = require('./dates');

const AMOUNT_TOLERANCE = 0.05;
const EXACT_TOLERANCE = 0.005;
const DAY_MS = 24 * 60 * 60 * 1000;

const normalizeText = (text) => {
  if (!text) return '';
  return String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

const stopWords = new Set([
  'sociedad',
  'anonima',
  'capital',
  'variable',
  'mexico',
  'corporativo',
  'grupo',
  'comercial',
  'nacional',
  'servicios',
  'distribuidora',
  'tiendas',
  'responsabilidad',
  'limitada'
]);

/**
 * Evalua coincidencia de nombre de proveedor en el concepto bancario.
 * Acepta el concepto ya normalizado para evitar recalcularlo en cada comparacion.
 */
const matchVendorName = (emisor, concepto, conceptoYaNormalizado = false) => {
  if (!emisor || !concepto) return false;
  const normEmisor = normalizeText(emisor);
  const normConcepto = conceptoYaNormalizado ? concepto : normalizeText(concepto);
  if (!normEmisor || !normConcepto) return false;

  const keywords = normEmisor.split(' ').filter((w) => w.length >= 4 && !stopWords.has(w));

  if (keywords.length === 0) {
    // Si todas son palabras cortas o stop words, comparar texto directo
    const prefix = normEmisor.substring(0, 8).trim();
    return prefix.length >= 3 && normConcepto.includes(prefix);
  }

  // Coincidencia por palabra completa para evitar falsos positivos (ej. "rosa" dentro de "barrosa")
  const conceptWords = new Set(normConcepto.split(' '));
  return keywords.some((kw) => conceptWords.has(kw) || (kw.length >= 6 && normConcepto.includes(kw)));
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Ejecuta la conciliacion entre una lista de facturas y retiros bancarios
 * @param {Array<Object>} invoices - Lista de facturas (CFDI)
 * @param {Array<Object>} bankTransactions - Lista de movimientos bancarios (Retiros)
 * @returns {Object} Resultado de la conciliacion con facturas actualizadas y resumen
 */
const reconcile = (invoices = [], bankTransactions = []) => {
  const safeInvoices = Array.isArray(invoices) ? invoices : [];
  const withdrawals = (Array.isArray(bankTransactions) ? bankTransactions : []).filter(
    (tx) => tx && tx.tipo === 'Retiro' && Number.isFinite(Number(tx.monto))
  );

  // Precalculos por retiro
  const txInfo = withdrawals.map((tx) => ({
    monto: Number(tx.monto),
    rfc: (tx.rfcDetectado || '').toUpperCase(),
    normConcept: normalizeText(tx.concepto),
    date: tx.fechaNormalizada ? parseFlexibleDate(tx.fechaNormalizada) : parseFlexibleDate(tx.fecha)
  }));

  // Indice de retiros por centavos para no comparar cada factura contra todos los retiros
  const byCents = new Map();
  txInfo.forEach((info, idx) => {
    const cents = Math.round(info.monto * 100);
    if (!byCents.has(cents)) byCents.set(cents, []);
    byCents.get(cents).push(idx);
  });
  const toleranceCents = Math.round(AMOUNT_TOLERANCE * 100);

  const results = new Array(safeInvoices.length);
  const pairs = [];

  safeInvoices.forEach((inv, invIdx) => {
    // 1. Si la factura esta cancelada por el SAT
    if (inv.estadoSat === 'Cancelado') {
      results[invIdx] = { ...inv, estadoPago: 'Cancelada', pagoAsociado: null };
      return;
    }

    const total = Number(inv.total || 0);

    // 2. Si es efecto Egreso (nota de credito) o complemento de pago / Traslado sin importe
    if (inv.efecto === 'Egreso' || inv.efecto === 'Traslado' || total === 0) {
      results[invIdx] = { ...inv, estadoPago: 'No Aplica', pagoAsociado: null };
      return;
    }

    // 3. Buscar retiros con monto equivalente
    const invRfc = (inv.rfcEmisor || '').toUpperCase();
    const normRfc = normalizeText(invRfc).replace(/\s+/g, '');
    const invDate = parseFlexibleDate(inv.fechaEmision);
    const totalCents = Math.round(total * 100);

    for (let c = totalCents - toleranceCents; c <= totalCents + toleranceCents; c++) {
      const idxs = byCents.get(c);
      if (!idxs) continue;

      for (const txIdx of idxs) {
        const info = txInfo[txIdx];
        const diff = Math.abs(info.monto - total);
        if (diff >= AMOUNT_TOLERANCE) continue;

        const rfcMatch =
          (invRfc && info.rfc && info.rfc === invRfc) ||
          (normRfc.length >= 12 && info.normConcept.replace(/\s+/g, '').includes(normRfc));
        const nameMatch = !rfcMatch && matchVendorName(inv.emisor, info.normConcept, true);

        // Si no es monto exacto y el RFC y nombre del proveedor discrepan totalmente, no asociar
        if (diff > EXACT_TOLERANCE && info.rfc && invRfc && info.rfc !== invRfc && !rfcMatch && !nameMatch) {
          continue;
        }

        let score = 0;
        if (rfcMatch) score += 1000;
        else if (nameMatch) score += 500;
        if (diff <= EXACT_TOLERANCE) score += 100;
        else score += Math.max(0, 50 - diff * 1000);

        // Desempate por cercania de fechas (hasta 90 dias de penalizacion)
        if (invDate && info.date) {
          const days = Math.abs(info.date.getTime() - invDate.getTime()) / DAY_MS;
          score -= Math.min(days, 90) * 0.5;
        }

        pairs.push({ invIdx, txIdx, score, diff });
      }
    }
  });

  // Asignacion voraz global: mejores pares primero, orden estable ante empates
  pairs.sort((a, b) => b.score - a.score || a.invIdx - b.invIdx || a.txIdx - b.txIdx);

  const usedTx = new Set();
  const matchedInv = new Map();
  for (const p of pairs) {
    if (matchedInv.has(p.invIdx) || usedTx.has(p.txIdx)) continue;
    matchedInv.set(p.invIdx, p);
    usedTx.add(p.txIdx);
  }

  let pagadasCount = 0;
  let montoPagado = 0;
  let noPagadasCount = 0;
  let montoNoPagado = 0;
  let canceladasCount = 0;
  let montoCancelado = 0;

  const reconciledInvoices = safeInvoices.map((inv, invIdx) => {
    const total = Number(inv.total || 0);

    if (results[invIdx]) {
      if (results[invIdx].estadoPago === 'Cancelada') {
        canceladasCount++;
        montoCancelado += total;
      }
      return results[invIdx];
    }

    const match = matchedInv.get(invIdx);
    if (match) {
      const tx = withdrawals[match.txIdx];
      pagadasCount++;
      montoPagado += total;
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
    montoNoPagado += total;
    return { ...inv, estadoPago: 'No Pagada', pagoAsociado: null };
  });

  // Movimientos bancarios que no se asociaron a ninguna factura
  const unmatchedWithdrawals = withdrawals.filter((_, idx) => !usedTx.has(idx));

  return {
    summary: {
      totalFacturas: safeInvoices.length,
      montoTotalFacturas: safeInvoices.reduce((acc, i) => acc + Number(i.total || 0), 0),
      pagadasCount,
      montoPagado,
      noPagadasCount,
      montoNoPagado,
      canceladasCount,
      montoCancelado,
      movimientosBancariosCount: withdrawals.length,
      movimientosNoAsociadosCount: unmatchedWithdrawals.length
    },
    reconciledInvoices,
    unmatchedWithdrawals
  };
};

module.exports = {
  reconcile,
  normalizeText,
  matchVendorName
};
