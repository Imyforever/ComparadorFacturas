/**
 * Lector de Estado de Cuenta Tarjeta de Credito Scotiabank (Scotia Travel / Rewards) (PDF).
 */

const { MONTH_MAP } = require('../../utils/dates');
const { cleanBankConcept } = require('../../utils/text');

const id = 'scotiabank-credit-card';

const canParse = (text = '') => {
  const s = String(text);
  return (
    /(?:Scotia\s*(?:Travel|Rewards)|Tarjeta\s+de\s+Cr[eé]dito\s+Scotiabank|TU\s+PAGO\s+REQUERIDO\s+ESTE\s+PERIODO|CARGOS,\s*ABONOS\s*Y\s*COMPRAS\s*REGULARES)/i.test(
      s
    ) ||
    (/\b\d{2}-[a-z]{3}-\d{4}\s+\d{2}-[a-z]{3}-\d{4}\b/i.test(s) && /[+-]\s*\$?[0-9,]+\.[0-9]{2}/.test(s))
  );
};

const parseScotiabankCreditCardStatement = (text, defaultYear = '2026') => {
  const cardMatch =
    text.match(/(?:No\.\s*Tarjeta|N[uú]mero\s+de\s+tarjeta:?)\s*([0-9\s]{16,22})/i) ||
    text.match(/Tarjeta\s+titular\s+X+([0-9]{4})/i);

  let cuenta = 'Tarjeta Credito';
  if (cardMatch) {
    const rawCard = cardMatch[1].replace(/\s+/g, '');
    const last4 = rawCard.slice(-4);
    cuenta = `Tarjeta ${last4}`;
  }

  let periodStart = null;
  let periodEnd = null;
  const periodMatch =
    text.match(/Periodo:\s*(\d{2}-[a-z]{3}-\d{4})\s+al\s+(\d{2}-[a-z]{3}-\d{4})/i) ||
    text.match(/(\d{2}-[a-z]{3}-\d{4})\s+al\s+(\d{2}-[a-z]{3}-\d{4})/i);

  if (periodMatch) {
    periodStart = periodMatch[1];
    periodEnd = periodMatch[2];
  }

  const detectedPeriodsSet = new Set();
  if (periodStart && periodEnd) {
    const mStart = periodStart.split('-')[1]?.toUpperCase();
    const yStart = periodStart.split('-')[2];
    const mEnd = periodEnd.split('-')[1]?.toUpperCase();
    const yEnd = periodEnd.split('-')[2];
    if (mStart && MONTH_MAP[mStart]) detectedPeriodsSet.add(`${yStart}-${MONTH_MAP[mStart]}`);
    if (mEnd && MONTH_MAP[mEnd]) detectedPeriodsSet.add(`${yEnd}-${MONTH_MAP[mEnd]}`);
  }

  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const rowRegex =
    /^(\d{2}-[a-z]{3}-\d{4})\s+(\d{2}-[a-z]{3}-\d{4})\s+(.*?)\s+([+-])\s*\$?\s*([0-9,]+\.[0-9]{2})$/i;
  const rfcRegex = /\b([A-Z&Ñ]{3,4})\s*([0-9]{6})\s*([A-Z0-9]{3})\b/i;

  const movements = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(rowRegex);
    if (!match) continue;

    const fechaOp = match[1];
    const fechaCargo = match[2];
    const desc = match[3].trim();
    const sign = match[4];
    const amount = parseFloat(match[5].replace(/,/g, ''));

    const parts = fechaOp.split('-');
    const day = parts[0];
    const monthStr = parts[1].toUpperCase();
    const year = parts[2] || String(defaultYear);
    const monthNum = MONTH_MAP[monthStr] || '09';
    const mvPeriodo = `${year}-${monthNum}`;

    detectedPeriodsSet.add(mvPeriodo);

    const rfcMatch = desc.match(rfcRegex);
    const rfc = rfcMatch ? `${rfcMatch[1]}${rfcMatch[2]}${rfcMatch[3]}`.toUpperCase() : null;

    const isCargo = sign === '+';

    movements.push({
      banco: 'Scotiabank (TDC)',
      cuenta,
      periodo: mvPeriodo,
      fecha: `${day}-${monthStr}-${year}`,
      tipo: isCargo ? 'Retiro' : 'Deposito',
      monto: amount,
      saldo: 0,
      rfcDetectado: rfc,
      concepto: cleanBankConcept(`${desc} (Cargo: ${fechaCargo})`).substring(0, 250),
      conciliado: false
    });
  }

  return {
    banco: 'Scotiabank (TDC)',
    cuenta,
    movements,
    detectedPeriods: Array.from(detectedPeriodsSet).sort()
  };
};

module.exports = {
  id,
  canParse,
  parse: parseScotiabankCreditCardStatement,
  parseScotiabankCreditCardStatement
};
