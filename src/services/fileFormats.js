/**
 * Re-exportaciones de compatibilidad hacia src/parsers/.
 */

const { parseCfdiReport } = require('../parsers/sat/cfdiReport');
const { classifyBBVAMovementIsRetiro } = require('../parsers/bbva/classify');
const { parseBBVAStatement } = require('../parsers/bbva/statement');
const { parseBBVADetalleMovimientos } = require('../parsers/bbva/detalleWeb');
const { parseBBVACreditOrCardStatement } = require('../parsers/bbva/creditCard');
const { parseScotiabankStatement } = require('../parsers/scotiabank/statement');
const { parseScotiabankCreditCardStatement } = require('../parsers/scotiabank/creditCard');
const { parseCsvOrExcelBankStatement } = require('../parsers/csv');
const { parseBankStatement, detectAndParseBankStatement, finalizeStatement } = require('../parsers/registry');

module.exports = {
  parseCfdiReport,
  parseBankStatement,
  detectAndParseBankStatement,
  finalizeStatement,
  parseCsvOrExcelBankStatement,
  parseBBVACreditOrCardStatement,
  parseBBVAStatement,
  parseBBVADetalleMovimientos,
  parseScotiabankStatement,
  parseScotiabankCreditCardStatement,
  classifyBBVAMovementIsRetiro
};
