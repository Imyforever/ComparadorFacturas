/**
 * Emparejador puro de pagos conjuntos: un retiro libre que liquida 2 o 3 facturas del MISMO proveedor.
 *
 * Reglas:
 *   - Solo facturas Ingreso, Vigentes, No Pagadas y sin nota de credito aplicada.
 *   - La suma (en centavos) de las facturas debe ser EXACTAMENTE el monto del retiro.
 *   - El retiro debe identificar al proveedor (rfc, nombre o alias aprendido) de cada factura del grupo.
 *   - Solo se asigna si la combinacion es UNICA para ese retiro (no hay otro grupo posible con ese retiro)
 *     y ninguna de sus facturas aparece tambien en la combinacion unica de otro retiro.
 *   - Determinista: facturas ordenadas por uuid, retiros por monto e id.
 */

const { toCents, fromCents } = require('../utils/money');
const { buildConceptInfo, matchVendor } = require('./vendorMatch');

const MAX_GROUP_SIZE = 3;

const isCandidateInvoice = (inv) =>
  inv &&
  inv.uuid &&
  (inv.efecto || 'Ingreso') === 'Ingreso' &&
  (inv.estadoSat || 'Vigente') === 'Vigente' &&
  (inv.estadoPago || 'No Pagada') === 'No Pagada' &&
  !inv.egresoAsociado?.uuid &&
  toCents(inv.total) > 0 &&
  Boolean((inv.rfcEmisor || '').trim());

/** Combinaciones de 2 y 3 elementos (ordenados ascendente por centavos) que suman target; corta al llegar a `limit` */
const findCombinations = (items, target, limit) => {
  const found = [];
  for (let i = 0; i < items.length && found.length < limit; i++) {
    for (let j = i + 1; j < items.length && found.length < limit; j++) {
      const s2 = items[i].cents + items[j].cents;
      if (s2 > target) break;
      if (s2 === target) {
        found.push([items[i], items[j]]);
        continue;
      }
      for (let k = j + 1; k < items.length && found.length < limit; k++) {
        const s3 = s2 + items[k].cents;
        if (s3 > target) break;
        if (s3 === target) found.push([items[i], items[j], items[k]]);
      }
    }
  }
  return found;
};

/**
 * @param {Object} params
 * @param {Array<Object>} params.invoices - Facturas candidatas (se filtran de nuevo por seguridad)
 * @param {Array<Object>} params.withdrawals - Retiros libres (sin mesAnterior)
 * @param {Map<string, Set<string>>} [params.aliases]
 * @returns {Array<{ movement: Object, invoices: Array<Object>, uuids: string[], totalCents: number, total: number }>}
 */
const matchJointPayments = ({ invoices = [], withdrawals = [], aliases = null } = {}) => {
  const byRfc = new Map();
  for (const inv of Array.isArray(invoices) ? invoices : []) {
    if (!isCandidateInvoice(inv)) continue;
    const rfc = inv.rfcEmisor.trim().toUpperCase();
    if (!byRfc.has(rfc)) byRfc.set(rfc, []);
    byRfc.get(rfc).push({ inv, uuid: inv.uuid, cents: toCents(inv.total) });
  }
  if (byRfc.size === 0) return [];

  for (const list of byRfc.values()) {
    list.sort((a, b) => a.cents - b.cents || String(a.uuid).localeCompare(String(b.uuid)));
  }

  const freeWithdrawals = (Array.isArray(withdrawals) ? withdrawals : [])
    .filter((tx) => tx && (!tx.tipo || tx.tipo === 'Retiro') && !tx.mesAnterior && toCents(tx.monto) > 0)
    .map((tx) => ({ tx, cents: toCents(tx.monto) }))
    .sort((a, b) => a.cents - b.cents || String(a.tx._id || '').localeCompare(String(b.tx._id || '')));

  const candidates = [];
  for (const { tx, cents } of freeWithdrawals) {
    const info = buildConceptInfo(tx);
    const combos = [];
    for (const list of byRfc.values()) {
      if (combos.length > 1) break;
      const eligible = list.filter((e) => e.cents < cents && matchVendor(e.inv, info, aliases).vendorMatch);
      if (eligible.length < 2) continue;
      combos.push(...findCombinations(eligible, cents, 2 - combos.length));
    }
    if (combos.length === 1) candidates.push({ tx, cents, group: combos[0] });
  }

  // Una factura no puede pertenecer a dos grupos candidatos: en ese caso ninguno se asigna
  const uses = new Map();
  for (const c of candidates) {
    for (const e of c.group) uses.set(e.uuid, (uses.get(e.uuid) || 0) + 1);
  }

  const assignments = [];
  for (const c of candidates) {
    if (c.group.some((e) => uses.get(e.uuid) > 1)) continue;
    const sorted = [...c.group].sort((a, b) => String(a.uuid).localeCompare(String(b.uuid)));
    assignments.push({
      movement: c.tx,
      invoices: sorted.map((e) => e.inv),
      uuids: sorted.map((e) => e.uuid),
      totalCents: c.cents,
      total: fromCents(c.cents)
    });
  }
  return assignments;
};

/**
 * Aplica asignaciones de pago conjunto sobre las facturas conciliadas (muta los objetos de `reconciledInvoices`
 * y el `summary` de la conciliacion). Devuelve los uuids de facturas pagadas por conjunto.
 */
const applyJointAssignments = (reconciledInvoices, assignments, summary) => {
  const byUuid = new Map(reconciledInvoices.map((i) => [i.uuid, i]));
  const applied = [];
  for (const a of assignments) {
    const tx = a.movement;
    for (const uuid of a.uuids) {
      const inv = byUuid.get(uuid);
      if (!inv) continue;
      const invCents = toCents(inv.total);
      inv.estadoPago = 'Pagada';
      inv.pagoAsociado = {
        movimientoId: tx._id || null,
        banco: tx.banco || 'Banco',
        fechaPago: tx.fecha,
        montoRetiro: tx.monto,
        diferencia: 0,
        conceptoBanco: tx.concepto,
        referencia: tx.origenReferencia || ''
      };
      inv.pagoConjunto = { uuids: [...a.uuids], total: a.total };
      if (summary) {
        summary.pagadasCount++;
        summary.noPagadasCount = Math.max(0, summary.noPagadasCount - 1);
        summary.montoPagado = fromCents(toCents(summary.montoPagado) + invCents);
        summary.montoNoPagado = fromCents(Math.max(0, toCents(summary.montoNoPagado) - invCents));
      }
      applied.push(uuid);
    }
    if (summary) summary.movimientosNoAsociadosCount = Math.max(0, summary.movimientosNoAsociadosCount - 1);
  }
  return applied;
};

module.exports = { MAX_GROUP_SIZE, matchJointPayments, applyJointAssignments };
