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
    const matchingCandidates = withdrawals.filter((tx, idx) => {
      if (usedWithdrawalIds.has(idx)) return false;
      return Math.abs(tx.monto - inv.total) < 0.05;
    });

    let bestMatch = null;
    let bestMatchIndex = -1;

    if (matchingCandidates.length === 1) {
      // Coincidencia unica por monto
      bestMatch = matchingCandidates[0];
      bestMatchIndex = withdrawals.indexOf(bestMatch);
    } else if (matchingCandidates.length > 1) {
      // Si hay varios retiros con el mismo monto, desempatar por RFC o nombre
      for (const candidate of matchingCandidates) {
        const candidateIdx = withdrawals.indexOf(candidate);
        const normConcept = normalizeText(candidate.concepto);

        // A. Coincidencia por RFC
        if (
          (candidate.rfcDetectado && candidate.rfcDetectado === inv.rfcEmisor) ||
          normConcept.includes(normalizeText(inv.rfcEmisor))
        ) {
          bestMatch = candidate;
          bestMatchIndex = candidateIdx;
          break;
        }

        // B. Coincidencia por nombre de proveedor
        if (matchVendorName(inv.emisor, candidate.concepto)) {
          bestMatch = candidate;
          bestMatchIndex = candidateIdx;
          break;
        }
      }

      // Si ninguno coincide por nombre, tomar el primero disponible
      if (!bestMatch) {
        bestMatch = matchingCandidates[0];
        bestMatchIndex = withdrawals.indexOf(bestMatch);
      }
    }

    if (bestMatch && bestMatchIndex !== -1) {
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
