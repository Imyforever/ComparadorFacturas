/**
 * Alias de proveedor aprendidos de pagos ya conciliados (modulo puro).
 *
 * Algunos proveedores cobran siempre con la misma referencia en el concepto del banco (una cuenta
 * "BANAMEX 10004378", un RFC distinto al de la factura...) aunque ni su nombre ni su RFC de emisor aparezcan.
 * Un token del concepto se considera alias de un RFC emisor cuando:
 *   - aparecio en 2 o mas pagos (movimientos distintos) de ESE RFC con diferencia 0, y
 *   - nunca aparecio en pagos de otro RFC (asi se descartan referencias de la propia empresa).
 */

const { normUuid, isBankFeeConcept } = require('../utils/text');

const MIN_PAYMENTS = 2;
const GENERIC_RFCS = new Set(['XAXX010101000', 'XEXX010101000']);

// Secuencias de 8 a 18 digitos (cuentas, CLABE, referencias) que no son parte de una secuencia mayor
const DIGITS_REGEX = /(?<!\d)\d{8,18}(?!\d)/g;
// RFC con o sin espacio entre la clave y la fecha ("PLA 120807BK0" o "PLA120807BK0")
const RFC_REGEX = /(?<![A-Z0-9&Ñ])[A-ZÑ&]{3,4}\s?\d{6}\s?[A-Z0-9]{3}(?![A-Z0-9])/g;

/** Tokens candidatos de un concepto bancario: digitos largos y RFCs (sin espacios, en mayusculas) */
const extractConceptTokens = (concepto) => {
  const text = String(concepto || '').toUpperCase();
  const tokens = new Set();
  for (const m of text.matchAll(DIGITS_REGEX)) tokens.add(m[0]);
  for (const m of text.matchAll(RFC_REGEX)) tokens.add(m[0].replace(/\s+/g, ''));
  return tokens;
};

const isLearnablePayment = (inv) => {
  if (!inv || inv.estadoPago !== 'Pagada') return false;
  const pago = inv.pagoAsociado;
  if (!pago || !pago.movimientoId || !pago.conceptoBanco) return false;
  // Las comisiones del banco no identifican a ningun proveedor
  if (isBankFeeConcept(pago.conceptoBanco)) return false;
  if (Number(pago.diferencia || 0) !== 0) return false;
  // Los pagos conjuntos no sirven: el retiro cubre varias facturas
  if (inv.pagoConjunto && Array.isArray(inv.pagoConjunto.uuids) && inv.pagoConjunto.uuids.length > 0) return false;
  const rfc = String(inv.rfcEmisor || '').trim().toUpperCase();
  return Boolean(rfc) && !GENERIC_RFCS.has(rfc);
};

/**
 * Aprende alias a partir de facturas pagadas.
 * @param {Array<Object>} paidInvoices - Facturas (de todos los meses de la entidad)
 * @returns {Map<string, Set<string>>} rfcEmisor -> tokens aceptados
 */
const learnVendorAliases = (paidInvoices = []) => {
  // token -> rfc -> ids de movimiento distintos
  const seen = new Map();
  for (const inv of Array.isArray(paidInvoices) ? paidInvoices : []) {
    if (!isLearnablePayment(inv)) continue;
    const rfc = String(inv.rfcEmisor).trim().toUpperCase();
    const movId = String(inv.pagoAsociado.movimientoId);
    for (const token of extractConceptTokens(inv.pagoAsociado.conceptoBanco)) {
      if (!seen.has(token)) seen.set(token, new Map());
      const byRfc = seen.get(token);
      if (!byRfc.has(rfc)) byRfc.set(rfc, new Set());
      byRfc.get(rfc).add(movId);
    }
  }

  const aliases = new Map();
  for (const [token, byRfc] of seen) {
    if (byRfc.size !== 1) continue;
    const [[rfc, movIds]] = byRfc;
    if (movIds.size < MIN_PAYMENTS) continue;
    if (!aliases.has(rfc)) aliases.set(rfc, new Set());
    aliases.get(rfc).add(token);
  }
  return aliases;
};

/** true si el concepto (o su conjunto de tokens ya extraido) contiene un alias aprendido del RFC */
const hasVendorAlias = (aliases, rfcEmisor, conceptoOrTokens) => {
  if (!aliases || typeof aliases.get !== 'function') return false;
  const set = aliases.get(normUuid(rfcEmisor));
  if (!set || set.size === 0) return false;
  const tokens = conceptoOrTokens instanceof Set ? conceptoOrTokens : extractConceptTokens(conceptoOrTokens);
  for (const t of tokens) if (set.has(t)) return true;
  return false;
};

module.exports = {
  MIN_PAYMENTS,
  extractConceptTokens,
  learnVendorAliases,
  hasVendorAlias
};
