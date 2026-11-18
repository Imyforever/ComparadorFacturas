/**
 * Seleccion pura de retiros LIBRES del mes anterior que pueden casar con facturas del mes en curso
 * (caso real: Walmart factura el 1-sep compras que se pagaron en agosto).
 */

const { toCents } = require('../utils/money');

/** Mes anterior en formato AAAA-MM */
const previousPeriodo = (periodo) => {
  const [year, month] = String(periodo).split('-').map(Number);
  if (!year || !month) return null;
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
};

/**
 * @param {Object} params
 * @param {Array<Object>} params.candidates - Retiros del alcance del mes anterior
 * @param {Set<string>} params.currentMovementIds - ids ya presentes en el mes en curso (no se duplican)
 * @param {Set<string>} params.excludedMovementIds - ids usados por enlaces manuales o reservados por otras facturas
 * @param {Set<string>} params.autoInvoiceUuids - facturas automaticas del mes en curso (si el retiro ya quedo
 *   ligado a una de ellas en una corrida anterior debe seguir disponible para que la asignacion sea estable)
 * @param {Array<Object>} params.previousInvoices - facturas del mes anterior (misma entidad)
 * @returns {Array<Object>} retiros marcados con mesAnterior: true
 */
const selectPreviousMonthMovements = ({
  candidates = [],
  currentMovementIds = new Set(),
  excludedMovementIds = new Set(),
  autoInvoiceUuids = new Set(),
  previousInvoices = []
} = {}) => {
  // Si el monto coincide con una factura del mes anterior, el retiro es de ese mes: no se le roba
  const previousTotals = new Set(
    previousInvoices.map((inv) => toCents(inv.total)).filter((cents) => cents > 0)
  );

  return candidates
    .filter((m) => {
      if (!m || (m.tipo && m.tipo !== 'Retiro')) return false;
      const id = String(m._id);
      if (currentMovementIds.has(id) || excludedMovementIds.has(id)) return false;
      const free = !m.conciliado && !m.facturaUuid;
      const ownAssignment = Boolean(m.facturaUuid) && autoInvoiceUuids.has(m.facturaUuid);
      if (!free && !ownAssignment) return false;
      return !previousTotals.has(toCents(m.monto));
    })
    .map((m) => ({ ...m, mesAnterior: true }));
};

module.exports = { previousPeriodo, selectPreviousMonthMovements };
