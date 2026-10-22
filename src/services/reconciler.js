/**
 * Motor de Conciliacion entre Facturas del SAT y Movimientos Bancarios
 */

const normalizeText = (text) => {
  if (!text) return '';
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, ' ')
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
  'tiendas'
]);

/**
 * Evalua coincidencia de nombre de proveedor en el concepto bancario
 */
const matchVendorName = (emisor, concepto) => {
  if (!emisor || !concepto) return false;
  const normEmisor = normalizeText(emisor);
  const normConcepto = normalizeText(concepto);

  const keywords = normEmisor
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !stopWords.has(w));

  if (keywords.length === 0) {
    // Si todas son palabras cortas o stop words, comparar texto directo
    return normConcepto.includes(normEmisor.substring(0, 8));
  }

  return keywords.some((kw) => normConcepto.includes(kw));
};

/**
 * Ejecuta la conciliacion entre una lista de facturas y retiros bancarios
 * @param {Array<Object>} invoices - Lista de facturas (CFDI)
 * @param {Array<Object>} bankTransactions - Lista de movimientos bancarios (Retiros)
 * @returns {Object} Resultado de la conciliacion con facturas actualizadas y resumen
 */
const reconcile = (invoices, bankTransactions) => {
  // Filtrar solo retiros bancarios
  const withdrawals = bankTransactions.filter((tx) => tx.tipo === 'Retiro');
  const usedWithdrawalIds = new Set();

  // Precalcular concepto normalizado de cada retiro (se usa en desempates)
  const normConcepts = withdrawals.map((tx) => normalizeText(tx.concepto));

  let pagadasCount = 0;
  let montoPagado = 0;
  let noPagadasCount = 0;
  let montoNoPagado = 0;
  let canceladasCount = 0;
  let montoCancelado = 0;

  const reconciledInvoices = invoices.map((inv) => {
    // 1. Si la factura esta cancelada por el SAT
    if (inv.estadoSat === 'Cancelado') {
      canceladasCount++;
      montoCancelado += inv.total || 0;
      return {
        ...inv,
        estadoPago: 'Cancelada',
        pagoAsociado: null
      };
    }

    // 2. Si es efecto Egreso (nota de credito) o Pago de complemento
    if (inv.efecto === 'Egreso' || inv.total === 0) {
      return {
        ...inv,
        estadoPago: 'No Aplica',
        pagoAsociado: null
      };
    }

    // 3. Buscar movimientos bancarios con monto identico (tolerancia de 5 centavos)
    const candidateIdxs = [];
    for (let idx = 0; idx < withdrawals.length; idx++) {
      if (usedWithdrawalIds.has(idx)) continue;
      const tx = withdrawals[idx];
      const diff = Math.abs(tx.monto - inv.total);
      if (diff >= 0.05) continue;

      // Si no es monto exacto, y el RFC y nombre del proveedor discrepan totalmente, no asociar
      if (
        diff > 0.005 &&
        tx.rfcDetectado &&
        inv.rfcEmisor &&
        tx.rfcDetectado !== inv.rfcEmisor &&
        !matchVendorName(inv.emisor, tx.concepto)
      ) {
        continue;
      }

      candidateIdxs.push(idx);
    }

    let bestMatchIndex = -1;

    if (candidateIdxs.length === 1) {
      // Coincidencia unica por monto
      bestMatchIndex = candidateIdxs[0];
    } else if (candidateIdxs.length > 1) {
      // Si hay varios retiros con el mismo monto, desempatar por RFC o nombre
      const normRfc = normalizeText(inv.rfcEmisor);
      for (const idx of candidateIdxs) {
        const candidate = withdrawals[idx];

        // A. Coincidencia por RFC
        if (
          (candidate.rfcDetectado && candidate.rfcDetectado === inv.rfcEmisor) ||
          normConcepts[idx].includes(normRfc)
        ) {
          bestMatchIndex = idx;
          break;
        }

        // B. Coincidencia por nombre de proveedor
        if (matchVendorName(inv.emisor, candidate.concepto)) {
          bestMatchIndex = idx;
          break;
        }
      }

      // Si ninguno coincide por nombre, tomar el primero disponible
      if (bestMatchIndex === -1) {
        bestMatchIndex = candidateIdxs[0];
      }
    }

    if (bestMatchIndex !== -1) {
      const bestMatch = withdrawals[bestMatchIndex];
      usedWithdrawalIds.add(bestMatchIndex);
      pagadasCount++;
      montoPagado += inv.total;

      return {
        ...inv,
        estadoPago: 'Pagada',
        pagoAsociado: {
          movimientoId: bestMatch._id || null,
          banco: bestMatch.banco || 'Banco',
          fechaPago: bestMatch.fecha,
          montoRetiro: bestMatch.monto,
          diferencia: 0.0,
          conceptoBanco: bestMatch.concepto,
          referencia: bestMatch.origenReferencia || ''
        }
      };
    }

    // Factura pendiente de pago
    noPagadasCount++;
    montoNoPagado += inv.total;

    return {
      ...inv,
      estadoPago: 'No Pagada',
      pagoAsociado: null
    };
  });

  // Movimientos bancarios que no se asociaron a ninguna factura
  const unmatchedWithdrawals = withdrawals.filter((_, idx) => !usedWithdrawalIds.has(idx));

  return {
    summary: {
      totalFacturas: invoices.length,
      montoTotalFacturas: invoices.reduce((acc, i) => acc + (i.total || 0), 0),
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
  reconcile
};
