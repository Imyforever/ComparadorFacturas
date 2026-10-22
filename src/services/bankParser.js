const { PDFParse } = require('pdf-parse');

const MONTH_MAP = {
  ENE: '01',
  FEB: '02',
  MAR: '03',
  ABR: '04',
  MAY: '05',
  JUN: '06',
  JUL: '07',
  AGO: '08',
  SEP: '09',
  OCT: '10',
  NOV: '11',
  DIC: '12'
};

const knownBBVACargoCodes = new Set([
  'A15', 'I73', 'I74', 'K08', 'K64', 'K65', 'P14', 'P31',
  'R01', 'S39', 'S40', 'T17', 'V43', 'V44', 'V46', 'V47', 'X01'
]);

/**
 * Parsea un estado de cuenta BBVA Oficial (Centralizadora Debito Empr, Maestra Pyme, etc.)
 */
const parseBBVAStatement = (text, defaultYear = '2026') => {
  let detectedYear = defaultYear;
  const corteMatch = text.match(/Fecha\s+de\s+Corte\s+\d{2}\/(\d{2})\/(\d{4})/i);
  if (corteMatch) {
    detectedYear = corteMatch[2];
  } else {
    const periodoMatch = text.match(/Periodo\s+DEL\s+\d{2}\/\d{2}\/(\d{4})/i);
    if (periodoMatch) detectedYear = periodoMatch[1];
  }

  const cuentaMatch = text.match(/No\.\s+de\s+Cuenta\s+(\d+)/i);
  const cuenta = cuentaMatch ? cuentaMatch[1] : '';

  // Soporta con o sin codigo de 3 caracteres (ej: "01/SEP 01/SEP N06 PAGO CUENTA DE TERCERO 300.00")
  const headerRegex = /^(\d{2})\/([A-Z]{3})\s+(\d{2}\/[A-Z]{3})\s+(?:([A-Z0-9]{3})\s+)?(.*?)\s+([0-9,]+\.[0-9]{2})(?:\s+([0-9,]+\.[0-9]{2}))?(?:\s+([0-9,]+\.[0-9]{2}))?$/i;

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

      currentTx = {
        banco: 'BBVA',
        cuenta,
        periodo: `${detectedYear}-${monthNum}`,
        fecha: `${day}-${monthStr}-${detectedYear}`,
        code,
        desc,
        amount,
        saldo,
        details: [],
        conciliado: false
      };
    } else if (currentTx) {
      if (/^(?:Comportamiento|Rendimiento|Otros productos|Total de Movimientos|Cuadro resumen|Glosario de Abreviaturas|Folio Fiscal|BBVA MEXICO|PAGINA\s+\d+|Estado de Cuenta|CENTRALIZADORA|MAESTRA PYME|No\.\s+de\s+Cuenta|FECHA SALDO|OPER LIQ)/i.test(line)) {
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

    let isRetiro = false;
    if (knownBBVACargoCodes.has(tx.code)) {
      isRetiro = true;
    } else if (tx.code === 'N06') {
      // En BBVA Empresarial N06 es Pago a Terceros. Si es pago de cliente de internet es Abono.
      // Si contiene compras, mantenimiento o cotizacion de la empresa, es Retiro (Cargo)
      isRetiro = /COT\s+\d+|MANTENIMIENTO|COMPRA\s+ALUMINIO/i.test(fullConcept);
    } else if (/^SPEI\s+ENVIADO|^PAGO\s+DE\s+NOMINA|^IMSS|^COM\.|^IVA\s+TASA|^APLI\s+TASA/i.test(tx.desc)) {
      isRetiro = true;
    } else {
      isRetiro = false;
    }

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
    movements: transactions,
    detectedPeriods: Array.from(detectedPeriodsSet)
  };
};

/**
 * Parsea el reporte web BBVA de "Detalle de movimientos" (Cuenta con / sin chequera)
 */
const parseBBVADetalleMovimientos = (text, defaultYear = '2026') => {
  let detectedYear = defaultYear;
  const yearMatch = text.match(/\b\d{2}\/\d{2}\/(\d{4})\b/);
  if (yearMatch) detectedYear = yearMatch[1];

  const cuentaMatch = text.match(/Número\s+de\s+cuenta:\s*(\d+)/i);
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
        /^(?:Fecha|Número de cuenta|Saldo disponible|Detalle de movimientos|Cuenta con \/ sin|INNOVACIONES Y TECNOLOGIA|-- \d+ of \d+ --|\d{2}\/\d{2}\/\d{4}|En cumplimiento a la Ley|Cerrar Imprimir)/i.test(
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

      // Determinar si es Cargo o Abono segun la progresion del saldo (el PDF esta ordenado de mas nuevo a mas antiguo)
      let isCargo = false;
      if (i + 1 < blocks.length) {
        const nextFull = blocks[i + 1].lines.join(' ');
        const nextAmounts = [...nextFull.matchAll(/\$\s*([0-9,]+\.[0-9]{2})/g)].map((x) =>
          parseFloat(x[1].replace(/,/g, ''))
        );
        if (nextAmounts.length >= 2) {
          const prevSaldo = nextAmounts[nextAmounts.length - 1];
          if (saldo < prevSaldo) isCargo = true;
          else isCargo = false;
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
    movements,
    detectedPeriods: Array.from(detectedPeriodsSet).sort()
  };
};

/**
 * Parsea un estado de cuenta Scotiabank (Cuenta de Cheques / Débito)
 */
const parseScotiabankStatement = (text, defaultYear = '2026') => {
  let detectedYear = defaultYear;
  const yearMatch = text.match(/Periodo\s+\d{2}-[A-Z]{3}-(\d{2})/i);
  if (yearMatch) {
    detectedYear = '20' + yearMatch[1];
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
  let prevSaldo = 0;

  for (const block of blocks) {
    const headerLine = block.trim().split('\n')[0];
    const dateMatch = headerLine.match(/^(\d{2})\s+(ENE|FEB|MAR|ABR|MAY|JUN|JUL|AGO|SEP|OCT|NOV|DIC)/i);
    if (!dateMatch) continue;

    const day = dateMatch[1];
    const monthStr = dateMatch[2].toUpperCase();
    const monthNum = MONTH_MAP[monthStr] || '09';
    const periodo = `${detectedYear}-${monthNum}`;
    detectedPeriodsSet.add(periodo);

    const amountMatches = [...block.matchAll(/\$([0-9,]+\.[0-9]{2})/g)].map((m) =>
      parseFloat(m[1].replace(/,/g, ''))
    );

    if (amountMatches.length < 2) continue;

    const amount = amountMatches[0];
    const saldo = amountMatches[amountMatches.length - 1];

    let isRetiro = true;
    if (prevSaldo > 0) {
      if (Math.abs(prevSaldo + amount - saldo) < 0.2) {
        isRetiro = false;
      } else if (Math.abs(prevSaldo - amount - saldo) < 0.2) {
        isRetiro = true;
      } else {
        isRetiro = saldo < prevSaldo;
      }
    }
    prevSaldo = saldo;

    const lines = block
      .trim()
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const conceptFull = lines.join(' ');

    const rfcMatch = conceptFull.match(/RFC\s+([A-Z&Ñ]{3,4}\s*[0-9]{6}\s*[A-Z0-9]{3})/i);
    const rfc = rfcMatch ? rfcMatch[1].replace(/\s+/g, '').toUpperCase() : null;

    transactions.push({
      banco: 'Scotiabank',
      cuenta,
      periodo,
      fecha: `${day}-${monthStr}-${detectedYear}`,
      tipo: isRetiro ? 'Retiro' : 'Deposito',
      monto: amount,
      saldo,
      rfcDetectado: rfc,
      concepto: conceptFull.substring(0, 250),
      conciliado: false
    });
  }

  return {
    movements: transactions,
    detectedPeriods: Array.from(detectedPeriodsSet)
  };
};

/**
 * Parsea un estado de cuenta de Tarjeta de Credito Scotiabank (Scotia Travel, Scotia Rewards, etc.)
 */
const parseScotiabankCreditCardStatement = (text, defaultYear = '2026') => {
  const cardMatch =
    text.match(/(?:No\.\s*Tarjeta|Número\s+de\s+tarjeta:?)\s*([0-9\s]{16,22})/i) ||
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

  const rowRegex = /^(\d{2}-[a-z]{3}-\d{4})\s+(\d{2}-[a-z]{3}-\d{4})\s+(.*?)\s+([+-])\s*\$?\s*([0-9,]+\.[0-9]{2})$/i;
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
    const year = parts[2] || defaultYear;
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
      concepto: `${desc} (Cargo: ${fechaCargo})`.substring(0, 250),
      conciliado: false
    });
  }

  return {
    movements,
    detectedPeriods: Array.from(detectedPeriodsSet).sort()
  };
};

/**
 * Parsea un estado de cuenta bancario detectando automaticamente la institucion bancaria y formato
 * @param {Buffer} pdfBuffer - Buffer del archivo PDF
 * @param {string} defaultYear - Anio default (ej: "2026")
 * @returns {Promise<{movements: Array<Object>, detectedPeriods: Array<string>}>}
 */
const parseBankStatement = async (pdfBuffer, defaultYear = '2026') => {
  const parser = new PDFParse({ data: pdfBuffer });
  const result = await parser.getText();
  const text = result.text;

  // 1. Deteccion de BBVA Detalle de Movimientos (Portal Web / Cash Management)
  const isBBVADetalle =
    /Detalle\s+de\s+movimientos/i.test(text.substring(0, 800)) &&
    /Cuenta\s+con\s*\/\s*sin\s+chequera/i.test(text.substring(0, 800));

  if (isBBVADetalle) {
    return parseBBVADetalleMovimientos(text, defaultYear);
  }

  // 2. Deteccion de BBVA Oficial (Centralizadora / Maestra Pyme / Estado de Cuenta)
  const isBBVA =
    /BBVA/i.test(text.substring(0, 1500)) ||
    /MAESTRA PYME/i.test(text.substring(0, 1500)) ||
    /CENTRALIZADORA/i.test(text.substring(0, 1500)) ||
    /\b\d{2}\/[A-Z]{3}\s+\d{2}\/[A-Z]{3}\b/i.test(text);

  if (isBBVA) {
    return parseBBVAStatement(text, defaultYear);
  }

  // 3. Deteccion de Tarjeta de Credito Scotiabank (Scotia Travel, Scotia Rewards, etc.)
  const isScotiabankCreditCard =
    /(?:Scotia\s*(?:Travel|Rewards)|Tarjeta\s+de\s+Cr[eé]dito\s+Scotiabank|TU\s+PAGO\s+REQUERIDO\s+ESTE\s+PERIODO|CARGOS,\s*ABONOS\s*Y\s*COMPRAS\s*REGULARES)/i.test(text) ||
    (/\b\d{2}-[a-z]{3}-\d{4}\s+\d{2}-[a-z]{3}-\d{4}\b/i.test(text) && /[+-]\s*\$?[0-9,]+\.[0-9]{2}/.test(text));

  if (isScotiabankCreditCard) {
    return parseScotiabankCreditCardStatement(text, defaultYear);
  }

  // 4. Scotiabank tradicional (Cuenta de Cheques / Débito)
  return parseScotiabankStatement(text, defaultYear);
};

module.exports = {
  parseBankStatement
};
