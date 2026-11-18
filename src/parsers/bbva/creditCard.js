/**
 * Lector de Estado de Cuenta BBVA Tarjeta de Credito / Negocios / Linea Credito PyME (PDF).
 */

const { NUM_TO_MONTH_MAP } = require('../../utils/dates');
const { cleanBankConcept } = require('../../utils/text');

const id = 'bbva-credit-card';

const canParse = (text = '') => {
  const s = String(text);
  return (
    /L[ií]nea\s+Cr[eé]dito\s+Digital\s+PyME/i.test(s) ||
    /T\s*Negoc(?:\s*\/\s*LCDigital)?/i.test(s) ||
    /LCDigital/i.test(s) ||
    (/Movimientos\s+Efectuados\s+(?:Cr[eé]dito|Tarjeta\s+Titular)/i.test(s) && /BBVA/i.test(s))
  );
};

const parseBBVACreditOrCardStatement = (text, defaultYear = '2026') => {
  const detectedPeriodsSet = new Set();

  const periodoMatch =
    text.match(/Periodo\s+(?:Del\s+)?(\d{2})[\/\-](\d{2})[\/\-](\d{2,4})\s+al\s+(\d{2})[\/\-](\d{2})[\/\-](\d{2,4})/i) ||
    text.match(/Del\s+(\d{2})[\/\-](\d{2})[\/\-](\d{2,4})\s+al\s+(\d{2})[\/\-](\d{2})[\/\-](\d{2,4})/i);

  if (periodoMatch) {
    const yStart = periodoMatch[3].length === 2 ? '20' + periodoMatch[3] : periodoMatch[3];
    const mStart = periodoMatch[2];
    const yEnd = periodoMatch[6].length === 2 ? '20' + periodoMatch[6] : periodoMatch[6];
    const mEnd = periodoMatch[5];

    detectedPeriodsSet.add(`${yStart}-${mStart}`);
    detectedPeriodsSet.add(`${yEnd}-${mEnd}`);
  }

  const corteMatch = text.match(/Fecha\s+de\s+Corte\s+(\d{2})[\/\-](\d{2})[\/\-](\d{2,4})/i);
  if (corteMatch) {
    const corteYear = corteMatch[3].length === 2 ? '20' + corteMatch[3] : corteMatch[3];
    const corteMonth = corteMatch[2];
    detectedPeriodsSet.add(`${corteYear}-${corteMonth}`);
  }

  let banco = 'BBVA';
  let cuenta = '';

  const isLineaCreditoPyme = /L[ií]nea\s+Cr[eé]dito\s+Digital\s+PyME/i.test(text);
  const isTarjetaNegocios = /T\s*Negoc(?:\s*\/\s*LCDigital)?/i.test(text);

  if (isLineaCreditoPyme) {
    banco = 'BBVA (Línea Crédito PyME)';
    const creditoMatch =
      text.match(/No\.\s+de\s+Cr[eé]dito\s*([0-9\s]{16,22})/i) || text.match(/Cr[eé]dito\s*([0-9\s]{16,22})/i);
    if (creditoMatch) {
      const raw = creditoMatch[1].replace(/\s+/g, '');
      cuenta = `Crédito ${raw.slice(-4)}`;
    }
  } else if (isTarjetaNegocios) {
    banco = 'BBVA (Tarjeta Negocios)';
    const tarjetaMatch =
      text.match(/No\.\s+de\s+Tarjeta\s*([0-9\s]{16,22})/i) ||
      text.match(/Tarjeta\s+Titular\s*([0-9\s]{16,22})/i) ||
      text.match(/No\.\s+Tarjeta\s*([0-9\s]{16,22})/i);
    if (tarjetaMatch) {
      const raw = tarjetaMatch[1].replace(/\s+/g, '');
      cuenta = `Tarjeta ${raw.slice(-4)}`;
    }
  }

  if (!cuenta) {
    const clabeMatch = text.match(/Cuenta\s+CLABE\s*([0-9\s]{18,22})/i);
    if (clabeMatch) {
      const raw = clabeMatch[1].replace(/\s+/g, '');
      cuenta = `CLABE ${raw.slice(-4)}`;
    }
  }

  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const rowRegex = /^(\d{2}[\/\-]\d{2}[\/\-]\d{2,4})\s+(\d{2}[\/\-]\d{2}[\/\-]\d{2,4})\s+(.+)$/;
  const amountRegex =
    /(?:\$\s*)?([0-9]{1,3}(?:,[0-9]{3})*\.[0-9]{2})(?:\s+(?:\$\s*)?([0-9]{1,3}(?:,[0-9]{3})*\.[0-9]{2}))?\s*$/;

  const movements = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^FECHA\s+AUTORIZACION/i.test(line)) continue;
    if (/^TOTAL\s+IMPORTES/i.test(line)) continue;

    const rowMatch = line.match(rowRegex);
    if (!rowMatch) continue;

    const fechaAut = rowMatch[1];
    const rest = rowMatch[3].trim();

    const amtMatch = rest.match(amountRegex);
    if (!amtMatch) continue;

    const amt1 = parseFloat(amtMatch[1].replace(/,/g, ''));
    const amt2 = amtMatch[2] ? parseFloat(amtMatch[2].replace(/,/g, '')) : null;

    let remainder = rest.substring(0, amtMatch.index).trim();

    let referencia = '';
    const refMatch = remainder.match(/(?:\*{3,}[0-9A-Z]+|\b\d{6,12}\b)$/i);
    if (refMatch) {
      referencia = refMatch[0];
      remainder = remainder.substring(0, refMatch.index).trim();
    }

    let rfc = null;
    let concepto = remainder;

    const rfcEndMatch = remainder.match(/\b([A-Z&Ñ]{3,4})\s*([0-9]{6})\s*([A-Z0-9]{3})$/i);
    if (rfcEndMatch) {
      rfc = `${rfcEndMatch[1]}${rfcEndMatch[2]}${rfcEndMatch[3]}`.replace(/\s+/g, '').toUpperCase();
      concepto = remainder.substring(0, rfcEndMatch.index).trim();
    } else {
      const rfcAnyMatch = remainder.match(/\b([A-Z&Ñ]{3,4})\s*([0-9]{6})\s*([A-Z0-9]{3})\b/i);
      if (rfcAnyMatch) {
        rfc = `${rfcAnyMatch[1]}${rfcAnyMatch[2]}${rfcAnyMatch[3]}`.replace(/\s+/g, '').toUpperCase();
      }
    }

    const parts = fechaAut.split(/[\/\-]/);
    const dAut = parts[0];
    const mAut = parts[1];
    const yAutRaw = parts[2] || String(defaultYear);
    const yAut = yAutRaw.length === 2 ? '20' + yAutRaw : yAutRaw;
    const monthNum = mAut;
    const monthStr = NUM_TO_MONTH_MAP[monthNum] || 'SEP';
    const mvPeriodo = `${yAut}-${monthNum}`;

    detectedPeriodsSet.add(mvPeriodo);

    let isRetiro = true;
    let finalAmount = amt1;

    if (amt2 !== null) {
      if (amt1 > 0 && amt2 === 0) {
        isRetiro = true;
        finalAmount = amt1;
      } else if (amt1 === 0 && amt2 > 0) {
        isRetiro = false;
        finalAmount = amt2;
      } else {
        isRetiro = amt1 > 0;
        finalAmount = amt1 > 0 ? amt1 : amt2;
      }
    } else {
      const isAbono =
        /(?:^|\s)(?:PAGO|ABONO|DEPOSITO|DEVOLUCI[OÓ]N|REEMBOLSO|BONIFICACI[OÓ]N|TRASPASO\s+A\s+FAVOR|SU\s+PAGO\s+EN)(?:\s|$)/i.test(
          concepto
        );
      isRetiro = !isAbono;
      finalAmount = amt1;
    }

    movements.push({
      banco,
      cuenta,
      periodo: mvPeriodo,
      fecha: `${dAut}-${monthStr}-${yAut}`,
      fechaNormalizada: new Date(Number(yAut), Number(monthNum) - 1, Number(dAut)),
      tipo: isRetiro ? 'Retiro' : 'Deposito',
      monto: finalAmount,
      saldo: 0,
      rfcDetectado: rfc,
      concepto: cleanBankConcept(concepto || rest).substring(0, 250),
      origenReferencia: referencia,
      conciliado: false
    });
  }

  return {
    banco,
    cuenta,
    movements,
    detectedPeriods: Array.from(detectedPeriodsSet).sort()
  };
};

module.exports = {
  id,
  canParse,
  parse: parseBBVACreditOrCardStatement,
  parseBBVACreditOrCardStatement
};
