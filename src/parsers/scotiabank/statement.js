/**
 * Lector de Estado de Cuenta Scotiabank Debito / Cheques (PDF).
 */

const { MONTH_MAP, resolveYearForMonth } = require('../../utils/dates');
const { parseAmount, toCents } = require('../../utils/money');
const { cleanBankConcept } = require('../../utils/text');

const id = 'scotiabank-statement';

const canParse = (text = '') => {
  const s = String(text);
  return (
    /SCOTIABANK/i.test(s) ||
    /Periodo\s+\d{2}-[A-Z]{3}-\d{2}/i.test(s) ||
    (/\b\d{2}\s+(?:ENE|FEB|MAR|ABR|MAY|JUN|JUL|AGO|SEP|OCT|NOV|DIC)\b/i.test(s) && /\$[0-9,]+\.[0-9]{2}/.test(s))
  );
};

const parseScotiabankStatement = (text, defaultYear = '2026') => {
  let detectedYear = String(defaultYear);
  let startMonth = 0;
  const yearMatch = text.match(/Periodo\s+\d{2}-([A-Z]{3})-(\d{2})/i);
  if (yearMatch) {
    detectedYear = '20' + yearMatch[2];
    startMonth = Number(MONTH_MAP[yearMatch[1].toUpperCase()] || 0);
  }

  const cuentaMatch = text.match(/Cuenta\s+(\d+)/i);
  const cuenta = cuentaMatch ? cuentaMatch[1] : '';

  const cleaned = text
    .replace(/PAGINA\s+\d+\s+DE\s+\d+/gi, '')
    .replace(/Cuenta\s+\d+/gi, '')
    .replace(/F\s*ec\s*ha\s+Con\s*ce\s*pto.*/gi, '');

  const dateRegex = /(?=\b\d{2}\s+(?:ENE|FEB|MAR|ABR|MAY|JUN|JUL|AGO|SEP|OCT|NOV|DIC)\b)/i;
  const blocks = cleaned.split(dateRegex).filter((b) => b.trim().length > 0);

  const transactions = [];
  const detectedPeriodsSet = new Set();

  const saldoInicialMatch = text.match(/Saldo\s+(?:inicial|anterior)[^$\n]*\$\s*([0-9,]+\.[0-9]{2})/i);
  let prevSaldo = saldoInicialMatch ? parseAmount(saldoInicialMatch[1]) : null;
  if (!Number.isFinite(prevSaldo)) prevSaldo = null;

  for (const block of blocks) {
    const headerLine = block.trim().split('\n')[0];
    const dateMatch = headerLine.match(/^(\d{2})\s+(ENE|FEB|MAR|ABR|MAY|JUN|JUL|AGO|SEP|OCT|NOV|DIC)/i);
    if (!dateMatch) continue;

    const day = dateMatch[1];
    const monthStr = dateMatch[2].toUpperCase();
    const monthNum = MONTH_MAP[monthStr] || '09';
    const txYear = resolveYearForMonth(detectedYear, startMonth, Number(monthNum), 'start');
    const periodo = `${txYear}-${monthNum}`;

    const amountMatches = [...block.matchAll(/\$([0-9,]+\.[0-9]{2})/g)].map((m) =>
      parseFloat(m[1].replace(/,/g, ''))
    );

    if (amountMatches.length < 2) continue;

    const amount = amountMatches[0];
    const saldo = amountMatches[amountMatches.length - 1];

    detectedPeriodsSet.add(periodo);

    let isRetiro = true;
    if (prevSaldo !== null) {
      const prevCents = toCents(prevSaldo);
      const amtCents = toCents(amount);
      const saldoCents = toCents(saldo);
      if (Math.abs(prevCents + amtCents - saldoCents) < 20) {
        isRetiro = false;
      } else if (Math.abs(prevCents - amtCents - saldoCents) < 20) {
        isRetiro = true;
      } else {
        isRetiro = saldoCents < prevCents;
      }
    }
    prevSaldo = saldo;

    const lines = block
      .trim()
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const conceptFull = cleanBankConcept(lines.join(' '));

    const rfcMatch = conceptFull.match(/RFC\s+([A-Z&Ñ]{3,4}\s*[0-9]{6}\s*[A-Z0-9]{3})/i);
    const rfc = rfcMatch ? rfcMatch[1].replace(/\s+/g, '').toUpperCase() : null;

    transactions.push({
      banco: 'Scotiabank',
      cuenta,
      periodo,
      fecha: `${day}-${monthStr}-${txYear}`,
      tipo: isRetiro ? 'Retiro' : 'Deposito',
      monto: amount,
      saldo,
      rfcDetectado: rfc,
      concepto: conceptFull.substring(0, 250),
      conciliado: false
    });
  }

  return {
    banco: 'Scotiabank',
    cuenta: cuenta ? `Cuenta ${cuenta}` : 'Scotiabank',
    movements: transactions,
    detectedPeriods: Array.from(detectedPeriodsSet)
  };
};

module.exports = {
  id,
  canParse,
  parse: parseScotiabankStatement,
  parseScotiabankStatement
};
