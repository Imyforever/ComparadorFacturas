/**
 * Lector de Estado de Cuenta Oficial BBVA Debito / Maestra PyME (PDF).
 */

const { MONTH_MAP, resolveYearForMonth } = require('../../utils/dates');
const { classifyBBVAMovementIsRetiro } = require('./classify');

const id = 'bbva-statement';

const canParse = (text = '') => {
  const s = String(text);
  const head = s.substring(0, 1500);
  return (
    /BBVA/i.test(head) ||
    /MAESTRA PYME/i.test(head) ||
    /CENTRALIZADORA/i.test(head) ||
    /\b\d{2}\/[A-Z]{3}\s+\d{2}\/[A-Z]{3}\b/i.test(s)
  );
};

const parseBBVAStatement = (text, defaultYear = '2026') => {
  let detectedYear = String(defaultYear);
  let refMonth = 0;
  let refKind = 'end';
  const corteMatch = text.match(/Fecha\s+de\s+Corte\s+\d{2}\/(\d{2})\/(\d{4})/i);
  if (corteMatch) {
    detectedYear = corteMatch[2];
    refMonth = Number(corteMatch[1]);
  } else {
    const periodoMatch = text.match(/Periodo\s+DEL\s+\d{2}\/(\d{2})\/(\d{4})/i);
    if (periodoMatch) {
      detectedYear = periodoMatch[2];
      refMonth = Number(periodoMatch[1]);
      refKind = 'start';
    }
  }

  const cuentaMatch = text.match(/No\.\s+de\s+Cuenta\s+(\d+)/i);
  const cuenta = cuentaMatch ? cuentaMatch[1] : '';

  const headerRegex =
    /^(\d{2})\/([A-Z]{3})\s+(\d{2}\/[A-Z]{3})\s+(?:([A-Z0-9]{3})\s+)?(.*?)\s+([0-9,]+\.[0-9]{2})(?:\s+([0-9,]+\.[0-9]{2}))?(?:\s+([0-9,]+\.[0-9]{2}))?$/i;

  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const rawTransactions = [];
  let currentTx = null;
  let inSummary = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(headerRegex);

    if (match) {
      inSummary = false;
      if (currentTx) {
        rawTransactions.push(currentTx);
      }

      const day = match[1];
      const monthStr = match[2].toUpperCase();
      const code = (match[4] || '').toUpperCase();
      const desc = match[5].trim();
      const amount = parseFloat(match[6].replace(/,/g, ''));
      const saldo = match[7] ? parseFloat(match[7].replace(/,/g, '')) : 0;
      const monthNum = MONTH_MAP[monthStr] || '09';
      const txYear = resolveYearForMonth(detectedYear, refMonth, Number(monthNum), refKind);

      currentTx = {
        banco: 'BBVA',
        cuenta,
        periodo: `${txYear}-${monthNum}`,
        fecha: `${day}-${monthStr}-${txYear}`,
        code,
        desc,
        amount,
        saldo,
        details: [],
        conciliado: false
      };
    } else if (currentTx) {
      if (
        /^(?:Comportamiento|Rendimiento|Otros productos|Total de Movimientos|Cuadro resumen|Glosario de Abreviaturas|Folio Fiscal|BBVA MEXICO|PAGINA\s+\d+|Estado de Cuenta|CENTRALIZADORA|MAESTRA PYME|No\.\s+de\s+Cuenta|FECHA SALDO|OPER LIQ)/i.test(
          line
        )
      ) {
        inSummary = true;
      }
      if (inSummary) continue;

      if (/^(?:Av\.\s+Paseo|-- \d+ of \d+ --)/i.test(line)) {
        continue;
      }

      currentTx.details.push(line);
    }
  }

  if (currentTx) {
    rawTransactions.push(currentTx);
  }

  const detectedPeriodsSet = new Set();
  const transactions = rawTransactions.map((tx) => {
    detectedPeriodsSet.add(tx.periodo);
    const fullConcept = [tx.code, tx.desc, ...tx.details].filter(Boolean).join(' ');

    const isRetiro = classifyBBVAMovementIsRetiro(fullConcept, tx.code);

    const rfcMatch =
      fullConcept.match(/RFC:\s*([A-Z&Ñ]{3,4}\s*[0-9]{6}\s*[A-Z0-9]{3})/i) ||
      fullConcept.match(/Ref\.\s*([A-Z&Ñ]{3,4}[0-9]{6}[A-Z0-9]{3})/i) ||
      fullConcept.match(/\b([A-Z&Ñ]{3,4})\s*([0-9]{6})\s*([A-Z0-9]{3})\b/i);

    const rfc = rfcMatch
      ? (rfcMatch[2] ? `${rfcMatch[1]}${rfcMatch[2]}${rfcMatch[3]}` : rfcMatch[1]).replace(/\s+/g, '').toUpperCase()
      : null;

    return {
      banco: 'BBVA',
      cuenta: tx.cuenta,
      periodo: tx.periodo,
      fecha: tx.fecha,
      tipo: isRetiro ? 'Retiro' : 'Deposito',
      monto: tx.amount,
      saldo: tx.saldo,
      rfcDetectado: rfc,
      concepto: fullConcept.substring(0, 250),
      conciliado: false
    };
  });

  return {
    banco: 'BBVA',
    cuenta: cuenta ? `Cuenta ${cuenta}` : 'BBVA',
    movements: transactions,
    detectedPeriods: Array.from(detectedPeriodsSet)
  };
};

module.exports = {
  id,
  canParse,
  parse: parseBBVAStatement,
  parseBBVAStatement
};
