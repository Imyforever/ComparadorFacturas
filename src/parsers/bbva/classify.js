/**
 * Clasificador de movimientos BBVA (Retiro / Cargo vs Deposito / Abono).
 */

const knownBBVACargoCodes = new Set([
  'A15', 'I73', 'I74', 'K08', 'K64', 'K65', 'P14', 'P31',
  'R01', 'S39', 'S40', 'T17', 'V43', 'V44', 'V46', 'V47', 'X01'
]);

const knownBBVADepositoCodes = new Set([
  'T20', 'V42', 'V45', 'AA7', 'C02', 'G30'
]);

/**
 * Clasifica si un movimiento de BBVA (con o sin codigo de operacion de 3 caracteres)
 * corresponde a un Retiro (Cargo) o un Deposito (Abono).
 */
const classifyBBVAMovementIsRetiro = (concepto, codeParam = '') => {
  const fullConcept = (concepto || '').trim();
  const firstWord = fullConcept.split(/\s+/)[0].toUpperCase();
  const code = (codeParam || (/^[A-Z0-9]{3}$/.test(firstWord) ? firstWord : '')).toUpperCase();

  // 1. Codigo oficial de cargo BBVA
  if (knownBBVACargoCodes.has(code)) return true;

  // 2. Codigo oficial de abono/deposito BBVA
  if (knownBBVADepositoCodes.has(code)) return false;

  // 3. Codigo N06 (Pago Cuenta de Tercero): en cuentas receptoras ISP son abonos de clientes,
  //    pero si menciona cotizacion, mantenimiento, compra, contadora, factura, sueldo o proveedor es un cargo (Retiro).
  if (code === 'N06') {
    return /COT\s+\d+|MANTENIMIENTO|COMPRA|CONTADORA|FACTURA|PROVEEDOR|SUELDO|NOMINA/i.test(fullConcept);
  }

  // 4. Estados de cuenta BBVA sin columna de codigo de 3 caracteres:
  //    Identificar primero los Abonos/Depositos explicitos.
  if (
    /^(?:[A-Z0-9]{3}\s+)?(?:VENTAS?\s+(?:CREDITO|DEBITO|TDC)|VENTA\s+NAL\.\s+AMEX|DEPOSITO\s+(?:EN\s+)?EFECTIVO|SPEI\s+RECIBIDO|SPEI\s+DEVUELTO|TRASPASO\s+TARJETA\s+A\s+CUENTA|ABONO|BONIFICACION)/i.test(
      fullConcept
    )
  ) {
    return false;
  }

  // 5. Por defecto en BBVA (consumos con tarjeta, CIE, SPEI enviado, nomina, IMSS, comisiones) es Retiro.
  return true;
};

module.exports = {
  knownBBVACargoCodes,
  knownBBVADepositoCodes,
  classifyBBVAMovementIsRetiro
};
