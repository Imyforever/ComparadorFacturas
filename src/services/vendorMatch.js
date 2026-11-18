/**
 * Identificacion del proveedor en un retiro bancario (rfcMatch / nameMatch / aliasMatch).
 * Compartido por el conciliador uno a uno y por el emparejador de pagos conjuntos.
 */

const { normalizeText, matchVendorName, isBankFeeConcept } = require('../utils/text');
const { extractConceptTokens, hasVendorAlias } = require('./vendorAliases');

/** Datos del concepto de un retiro que se calculan una sola vez */
const buildConceptInfo = (tx) => {
  const normConcept = normalizeText(tx.concepto);
  return {
    rfc: (tx.rfcDetectado || '').toUpperCase(),
    normConcept,
    compactConcept: normConcept.replace(/\s+/g, ''),
    isBankFee: isBankFeeConcept(tx.concepto),
    tokens: extractConceptTokens(tx.concepto)
  };
};

/**
 * @param {Object} inv - factura
 * @param {Object} info - resultado de buildConceptInfo
 * @param {Map<string, Set<string>>} [aliases] - alias aprendidos por RFC emisor
 * @returns {{ rfcMatch: boolean, nameMatch: boolean, aliasMatch: boolean, vendorMatch: boolean }}
 */
const matchVendor = (inv, info, aliases) => {
  const invRfc = (inv.rfcEmisor || '').toUpperCase();
  const normRfc = normalizeText(invRfc).replace(/\s+/g, '');

  const rfcMatch = Boolean(
    (invRfc && info.rfc && info.rfc === invRfc) || (normRfc.length >= 12 && info.compactConcept.includes(normRfc))
  );
  const nameMatch = !rfcMatch && matchVendorName(inv.emisor, info.normConcept, true);
  const aliasMatch = !rfcMatch && !nameMatch && hasVendorAlias(aliases, invRfc, info.tokens);

  return { rfcMatch, nameMatch, aliasMatch, vendorMatch: rfcMatch || nameMatch || aliasMatch };
};

module.exports = { buildConceptInfo, matchVendor };
