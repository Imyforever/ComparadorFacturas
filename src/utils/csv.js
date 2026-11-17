/**
 * Utilidades puras para lectura y generacion segura de archivos CSV.
 */

const { round2 } = require('./money');

/** Celda CSV segura: escapa comillas y neutraliza formulas (=, +, -, @, tab, CR) que Excel ejecutaria */
const csvText = (value) => {
  let s = value === undefined || value === null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

/** Formatea un importe numerico para celda CSV con 2 decimales exactos */
const csvMoney = (value) =>
  Number.isFinite(Number(value)) && value !== null && value !== '' ? round2(value).toFixed(2) : '';

/** Divide una linea CSV respetando comillas dobles y comillas escapadas ("") */
const splitCsvLine = (line, delimiter = ',') => {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
};

/** Detecta el delimitador predominante (coma, punto y coma o tabulador) en las primeras lineas */
const detectCsvDelimiter = (lines = []) => {
  const sample = lines.slice(0, 15).join('\n');
  const delimiterCounts = [',', ';', '\t'].map((d) => ({ d, n: sample.split(d).length - 1 }));
  delimiterCounts.sort((a, b) => b.n - a.n);
  return delimiterCounts[0].n > 0 ? delimiterCounts[0].d : ',';
};

module.exports = {
  csvText,
  csvMoney,
  splitCsvLine,
  detectCsvDelimiter
};
