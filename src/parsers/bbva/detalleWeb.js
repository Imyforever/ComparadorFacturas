/**
 * Lector de Detalle de Movimientos Portal Web BBVA (PDF).
 */

const { toCents } = require('../../utils/money');
const { classifyBBVAMovementIsRetiro } = require('./classify');

const id = 'bbva-detalle-web';

const canParse = (text = '') => {
  const head = String(text).substring(0, 800);
  return /Detalle\s+de\s+movimientos/i.test(head) && /Cuenta\s+con\s*\/\s*sin\s+chequera/i.test(head);
};

const parseBBVADetalleMovimientos = (text, defaultYear = '2026') => {
  let detectedYear = String(defaultYear);
  const yearMatch = text.match(/\b\d{2}\/\d{2}\/(\d{4})\b/);
  if (yearMatch) detectedYear = yearMatch[1];

  const cuentaMatch = text.match(/N[uú]mero\s+de\s+cuenta:\s*(\d+)/i);
  const cuenta = cuentaMatch ? cuentaMatch[1] : '';

  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const blocks = [];
  let currentBlock = null;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const dateMatch = l.match(/^(\d{2})-(\d{2})\b/);

    if (dateMatch) {
      if (currentBlock) blocks.push(currentBlock);
      currentBlock = {
        dia: dateMatch[1],
        mes: dateMatch[2],
        lines: [l.substring(5).trim()]
      };
    } else if (currentBlock) {
      if (
        /^(?:Fecha|N[uú]mero de cuenta|Saldo disponible|Detalle de movimientos|Cuenta con \/ sin|INNOVACIONES Y TECNOLOGIA|-- \d+ of \d+ --|\d{2}\/\d{2}\/\d{4}|En cumplimiento a la Ley|Cerrar Imprimir)/i.test(
          l
        )
      ) {
        continue;
      }
      currentBlock.lines.push(l);
    }
  }
  if (currentBlock) blocks.push(currentBlock);

  const movements = [];
  const detectedPeriodsSet = new Set();
  const rfcRegex = /\b([A-Z&Ñ]{3,4})\s*([0-9]{6})\s*([A-Z0-9]{3})\b/i;

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const fullConcept = b.lines.join(' ');
    const amountMatches = [...fullConcept.matchAll(/\$\s*([0-9,]+\.[0-9]{2})/g)].map((x) =>
      parseFloat(x[1].replace(/,/g, ''))
    );

    if (amountMatches.length >= 2) {
      const amount = amountMatches[0];
      const saldo = amountMatches[amountMatches.length - 1];

      // Progresion del saldo en centavos enteros (el PDF viene de mas reciente a mas antiguo)
      let isCargo = false;
      if (i + 1 < blocks.length) {
        const nextFull = blocks[i + 1].lines.join(' ');
        const nextAmounts = [...nextFull.matchAll(/\$\s*([0-9,]+\.[0-9]{2})/g)].map((x) =>
          parseFloat(x[1].replace(/,/g, ''))
        );
        if (nextAmounts.length >= 2) {
          const prevSaldo = nextAmounts[nextAmounts.length - 1];
          const prevCents = toCents(prevSaldo);
          const amtCents = toCents(amount);
          const saldoCents = toCents(saldo);
          if (Math.abs(prevCents - amtCents - saldoCents) < 2) isCargo = true;
          else if (Math.abs(prevCents + amtCents - saldoCents) < 2) isCargo = false;
          else isCargo = saldoCents < prevCents;
        } else {
          isCargo = classifyBBVAMovementIsRetiro(fullConcept);
        }
      } else {
        isCargo = /^(?:IVA|APLI\s+TASA|SICONT|SPEI\s+ENVIADO|IMSS|PAGO\s+SUA|COM\.|FULLGAS)/i.test(fullConcept);
      }

      const periodo = `${detectedYear}-${b.mes}`;
      detectedPeriodsSet.add(periodo);

      const rfcM = fullConcept.match(rfcRegex);
      const rfc = rfcM ? `${rfcM[1]}${rfcM[2]}${rfcM[3]}`.toUpperCase() : null;

      const cleanConcept = fullConcept
        .replace(/\$\s*[0-9,]+\.[0-9]{2}/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      movements.push({
        banco: 'BBVA',
        cuenta,
        periodo,
        fecha: `${b.dia}-${b.mes}-${detectedYear}`,
        tipo: isCargo ? 'Retiro' : 'Deposito',
        monto: amount,
        saldo,
        rfcDetectado: rfc,
        concepto: cleanConcept.substring(0, 250),
        conciliado: false
      });
    }
  }

  return {
    banco: 'BBVA (Detalle Web)',
    cuenta: cuenta ? `Cuenta ${cuenta}` : 'BBVA',
    movements,
    detectedPeriods: Array.from(detectedPeriodsSet).sort()
  };
};

module.exports = {
  id,
  canParse,
  parse: parseBBVADetalleMovimientos,
  parseBBVADetalleMovimientos
};
