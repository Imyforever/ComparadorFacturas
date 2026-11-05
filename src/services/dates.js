/**
 * Utilidades de fechas compartidas entre lectores de formatos, conciliador y rutas.
 */

const MONTH_ABBR_TO_NUM = {
  ENE: 1, FEB: 2, MAR: 3, ABR: 4, MAY: 5, JUN: 6,
  JUL: 7, AGO: 8, SEP: 9, OCT: 10, NOV: 11, DIC: 12
};

const isValidYMD = (y, m, d) =>
  Number.isInteger(y) && Number.isInteger(m) && Number.isInteger(d) && y > 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31;

/**
 * Convierte una fecha de movimiento o factura a Date (hora local, 00:00).
 * Soporta: "DD-MES-YYYY" (formato interno de movimientos), "YYYY-MM-DD[THH:mm:ss]",
 * "YYYY/MM/DD", "DD/MM/YYYY" y "DD-MM-YYYY". Devuelve null si no se reconoce.
 */
const parseFlexibleDate = (value) => {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;

  const s = String(value).trim();
  let y;
  let m;
  let d;

  let match = s.match(/^(\d{1,2})[-\/\s]([A-Za-z]{3})[-\/\s](\d{2,4})/);
  if (match) {
    d = Number(match[1]);
    m = MONTH_ABBR_TO_NUM[match[2].toUpperCase()];
    y = Number(match[3].length === 2 ? `20${match[3]}` : match[3]);
  } else if ((match = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/))) {
    y = Number(match[1]);
    m = Number(match[2]);
    d = Number(match[3]);
  } else if ((match = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/))) {
    d = Number(match[1]);
    m = Number(match[2]);
    y = Number(match[3]);
  } else {
    return null;
  }

  if (!isValidYMD(y, m, d)) return null;
  return new Date(y, m - 1, d);
};

/**
 * Ajusta el anio de un movimiento cuando el estado de cuenta cruza de diciembre a enero.
 * @param {number} refYear  Anio de referencia del documento
 * @param {number} refMonth Mes de referencia (1-12)
 * @param {number} txMonth  Mes del movimiento (1-12)
 * @param {'start'|'end'} refKind 'start' si la referencia es el inicio del periodo, 'end' si es la fecha de corte
 */
const resolveYearForMonth = (refYear, refMonth, txMonth, refKind) => {
  const y = Number(refYear);
  if (!refMonth || !txMonth) return y;
  // Un estado de cuenta nunca abarca mas de ~2 meses; una diferencia grande indica cambio de anio
  if (refKind === 'end' && txMonth - refMonth > 6) return y - 1;
  if (refKind === 'start' && refMonth - txMonth > 6) return y + 1;
  return y;
};

const PERIODO_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

module.exports = {
  MONTH_ABBR_TO_NUM,
  parseFlexibleDate,
  resolveYearForMonth,
  PERIODO_REGEX
};
