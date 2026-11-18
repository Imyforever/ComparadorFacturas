/**
 * Lector de Estado de Cuenta Scotiabank en formato CSV / Excel como texto (ScotiaWeb).
 */

const { NUM_TO_MONTH_MAP } = require('../utils/dates');
const { parseAmount } = require('../utils/money');
const { cleanBankConcept } = require('../utils/text');
const { splitCsvLine, detectCsvDelimiter } = require('../utils/csv');

const id = 'scotiabank-csv';

const looksLikeScotiaCsv = (text = '') => {
  const s = String(text);
  return (
    /Tipo\s*[,;\t]\s*Moneda\s*[,;\t]\s*Uso\s+futuro/i.test(s) ||
    /Tipo\s*\(\s*Cargo\s*\/\s*Abono\s*\)/i.test(s) ||
    /^"?CHQ"?\s*[,;\t]\s*"?MXN"?\s*[,;\t]/im.test(s)
  );
};

const canParse = (text = '') => looksLikeScotiaCsv(text);

const parseCsvOrExcelBankStatement = (text, defaultYear = '2026') => {
  const cleanText = String(text || '').replace(/^\uFEFF/, '');
  const lines = cleanText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  let headerIndex = -1;
  let cuentaHeader = '';

  const delimiter = detectCsvDelimiter(lines);
  const splitLine = (line) => splitCsvLine(line, delimiter);

  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const cols = splitLine(lines[i]);
    if (
      cols.some((c) => /^Tipo$/i.test(c)) &&
      cols.some((c) => /^Importe$/i.test(c)) &&
      cols.some((c) => /Cargo\/Abono/i.test(c))
    ) {
      headerIndex = i;
      break;
    }
  }

  if (headerIndex > 0) {
    const metaCols = splitLine(lines[0]);
    if (metaCols.length >= 2 && /^\d{7,20}$/.test(metaCols[1])) {
      cuentaHeader = metaCols[1].replace(/^0+/, '');
    }
  }

  const startRow = headerIndex !== -1 ? headerIndex + 1 : 0;
  const movements = [];
  const detectedPeriodsSet = new Set();
  let cuentaDetectada = cuentaHeader;

  const rfcRegex =
    /RFC[:\s]+([A-Z&Ñ]{3,4})\s*([0-9]{6})\s*([A-Z0-9]{3})\b|\b([A-Z&Ñ]{3,4})\s*([0-9]{6})\s*([A-Z0-9]{3})\b/i;

  for (let i = startRow; i < lines.length; i++) {
    const cols = splitLine(lines[i]);
    if (cols.length < 8) continue;

    const rawCuenta = (cols[3] || '').replace(/^0+/, '');
    const rawFecha = (cols[4] || '').trim();
    const rawReferencia = (cols[5] || '').replace(/^0+/, '') || cols[5] || '';
    const rawImporte = Math.abs(parseAmount(cols[6]));
    const rawTipoMov = cols[7] || '';
    const rawSaldo = parseAmount(cols[8]);
    const transaccion = cols[9] || '';
    const leyenda1 = cols[10] || '';
    const leyenda2 = cols[11] || '';
    const leyenda3 = cols[12] || '';
    const infoSpei = cols[13] || '';

    if (isNaN(rawImporte) || rawImporte <= 0) continue;

    if (!cuentaDetectada && rawCuenta) {
      cuentaDetectada = rawCuenta;
    }

    let year = String(defaultYear);
    let monthNum = '09';
    let day = '01';

    const ymdMatch = rawFecha.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})(?:\s.*)?$/);
    const dmyMatch = rawFecha.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:\s.*)?$/);

    if (ymdMatch) {
      year = ymdMatch[1];
      monthNum = ymdMatch[2].padStart(2, '0');
      day = ymdMatch[3].padStart(2, '0');
    } else if (dmyMatch) {
      day = dmyMatch[1].padStart(2, '0');
      monthNum = dmyMatch[2].padStart(2, '0');
      year = dmyMatch[3];
    } else {
      continue;
    }

    const monthStr = NUM_TO_MONTH_MAP[monthNum] || 'SEP';
    const periodo = `${year}-${monthNum}`;
    detectedPeriodsSet.add(periodo);

    const isCargo = /cargo|retiro/i.test(rawTipoMov);

    const conceptParts = [transaccion, leyenda1, leyenda2, leyenda3, infoSpei]
      .map((s) => s.trim())
      .filter(Boolean);
    const fullConcept = cleanBankConcept(conceptParts.join(' | '));

    let rfc = null;
    const rfcMatch = fullConcept.match(rfcRegex);
    if (rfcMatch) {
      if (rfcMatch[1] && rfcMatch[2] && rfcMatch[3]) {
        rfc = `${rfcMatch[1]}${rfcMatch[2]}${rfcMatch[3]}`.toUpperCase();
      } else if (rfcMatch[4] && rfcMatch[5] && rfcMatch[6]) {
        rfc = `${rfcMatch[4]}${rfcMatch[5]}${rfcMatch[6]}`.toUpperCase();
      }
    }

    movements.push({
      banco: 'Scotiabank (CSV/Excel)',
      cuenta: cuentaDetectada || rawCuenta,
      periodo,
      fecha: `${day}-${monthStr}-${year}`,
      fechaNormalizada: new Date(Number(year), Number(monthNum) - 1, Number(day)),
      tipo: isCargo ? 'Retiro' : 'Deposito',
      monto: rawImporte,
      saldo: isNaN(rawSaldo) ? 0 : rawSaldo,
      rfcDetectado: rfc,
      concepto: (fullConcept || 'Movimiento bancario').substring(0, 250),
      origenReferencia: rawReferencia,
      conciliado: false
    });
  }

  return {
    banco: 'Scotiabank (CSV/Excel)',
    cuenta: cuentaDetectada ? `Cuenta ${cuentaDetectada}` : 'Scotiabank',
    movements,
    detectedPeriods: Array.from(detectedPeriodsSet).sort()
  };
};

module.exports = {
  id,
  canParse,
  parse: parseCsvOrExcelBankStatement,
  parseCsvOrExcelBankStatement,
  looksLikeScotiaCsv
};
