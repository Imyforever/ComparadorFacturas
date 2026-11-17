/**
 * Utilidades para manejo seguro de importes monetarios en centavos enteros.
 * Evita errores de precision de punto flotante IEEE 754 al comparar o sumar montos.
 */

/** Convierte un importe en pesos (numero o cadena) a centavos enteros redondeados */
const toCents = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100);
};

/** Convierte centavos enteros a importe decimal con dos decimales exactos */
const fromCents = (cents) => {
  const num = Number(cents);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num) / 100;
};

/** Redondea un importe a 2 decimales pasando por centavos enteros */
const round2 = (value) => fromCents(toCents(value));

/**
 * Compara si dos importes son equivalentes en centavos enteros.
 * @param {number|string} a
 * @param {number|string} b
 * @param {number} [toleranceCents=0] Tolerancia maxima permitida en centavos (inclusiva)
 */
const sameAmount = (a, b, toleranceCents = 0) => {
  const numA = Number(a);
  const numB = Number(b);
  if (!Number.isFinite(numA) || !Number.isFinite(numB)) return false;
  return Math.abs(Math.round(numA * 100) - Math.round(numB * 100)) <= toleranceCents;
};

/** Diferencia absoluta entre dos importes expresada en pesos (2 decimales) */
const diffAmount = (a, b) => fromCents(Math.abs(toCents(a) - toCents(b)));

/** Suma una lista de importes en centavos enteros y devuelve el total en pesos */
const sumAmounts = (values = []) => {
  let totalCents = 0;
  for (const val of values) {
    totalCents += toCents(val);
  }
  return fromCents(totalCents);
};

/** Convierte un importe textual ("1,234.56", "$ 1,234.56", "-50.00") a numero; NaN si no es valido */
const parseAmount = (raw) => {
  if (raw === undefined || raw === null) return NaN;
  const cleaned = String(raw).replace(/[$\s,]/g, '');
  if (!cleaned) return NaN;
  return parseFloat(cleaned);
};

module.exports = {
  toCents,
  fromCents,
  round2,
  sameAmount,
  diffAmount,
  sumAmounts,
  parseAmount
};
