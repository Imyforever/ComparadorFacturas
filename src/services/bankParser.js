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

/**
 * Parsea un estado de cuenta BBVA (Maestra Pyme y formatos empresariales BBVA)
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

  const headerRegex = /^(\d{2})\/([A-Z]{3})\s+(\d{2}\/[A-Z]{3})\s+(.*?)\s+([0-9,]+\.[0-9]{2})(?:\s+([0-9,]+\.[0-9]{2}))?(?:\s+([0-9,]+\.[0-9]{2}))?$/i;
  const abonoRegex = /^(?:DEPOSITO|VENTAS\s+(?:CREDITO|DEBITO|TDC)|SPEI\s+DEVUELTO|TRASPASO\s+TARJETA|ABONO)/i;

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
      const desc = match[4].trim();
      const isRetiro = !abonoRegex.test(desc);
      const amount = parseFloat(match[5].replace(/,/g, ''));
      const saldo = match[6] ? parseFloat(match[6].replace(/,/g, '')) : 0;
      const monthNum = MONTH_MAP[monthStr] || '09';

      currentTx = {
        banco: 'BBVA',
        cuenta,
        periodo: `${detectedYear}-${monthNum}`,
        fecha: `${day}-${monthStr}-${detectedYear}`,
        tipo: isRetiro ? 'Retiro' : 'Deposito',
        monto: amount,
        saldo,
        desc,
        details: [],
        conciliado: false
      };
    } else if (currentTx) {
      if (/^(?:Comportamiento|Rendimiento|Otros productos|Total de Movimientos|Cuadro resumen|Glosario de Abreviaturas|Folio Fiscal)/i.test(line)) {
        inSummary = true;
      }
      if (inSummary) continue;

      if (/^(?:BBVA MEXICO|PAGINA\s+\d+|Estado de Cuenta|MAESTRA PYME|No\.\s+de\s+Cuenta|No\.\s+de\s+Cliente|Av\.\s+Paseo|-- \d+ of \d+ --|FECHA SALDO|OPER LIQ)/i.test(line)) {
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
    const fullConcept = [tx.desc, ...tx.details].join(' ');
    const rfcMatch = fullConcept.match(/RFC:\s*([A-Z&Ñ]{3,4}\s*[0-9]{6}\s*[A-Z0-9]{3})/i);
    const rfc = rfcMatch ? rfcMatch[1].replace(/\s+/g, '').toUpperCase() : null;

    return {
      banco: tx.banco,
      cuenta: tx.cuenta,
      periodo: tx.periodo,
      fecha: tx.fecha,
      tipo: tx.tipo,
      monto: tx.monto,
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
 * Parsea un estado de cuenta Scotiabank
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
  // 1. Extraer numero de tarjeta y cuenta
  const cardMatch =
    text.match(/(?:No\.\s*Tarjeta|Número\s+de\s+tarjeta:?)\s*([0-9\s]{16,22})/i) ||
    text.match(/Tarjeta\s+titular\s+X+([0-9]{4})/i);

  let cuenta = 'Tarjeta Credito';
  if (cardMatch) {
    const rawCard = cardMatch[1].replace(/\s+/g, '');
    const last4 = rawCard.slice(-4);
    cuenta = `Tarjeta ${last4}`;
  }

  // 2. Extraer rango de fechas del periodo
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

  // 3. Procesar lineas de movimientos
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

    // Deteccion del RFC del comercio/proveedor
    const rfcMatch = desc.match(rfcRegex);
    const rfc = rfcMatch ? `${rfcMatch[1]}${rfcMatch[2]}${rfcMatch[3]}`.toUpperCase() : null;

    // En tarjetas de credito:
    // + = cargo / compra regular a un comercio (Retiro / Egreso de dinero para la empresa)
    // - = abono / pago a la tarjeta en linea (Deposito a favor de la tarjeta)
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
 * Parsea un estado de cuenta bancario detectando automaticamente la institucion bancaria
 * @param {Buffer} pdfBuffer - Buffer del archivo PDF
 * @param {string} defaultYear - Anio default (ej: "2026")
 * @returns {Promise<{movements: Array<Object>, detectedPeriods: Array<string>}>}
 */
const parseBankStatement = async (pdfBuffer, defaultYear = '2026') => {
  const parser = new PDFParse({ data: pdfBuffer });
  const result = await parser.getText();
  const text = result.text;

  // 1. Deteccion de BBVA (Maestra Pyme y formatos empresariales)
  const isBBVA =
    /BBVA/i.test(text.substring(0, 1500)) ||
    /MAESTRA PYME/i.test(text.substring(0, 1500)) ||
    /\b\d{2}\/[A-Z]{3}\s+\d{2}\/[A-Z]{3}\b/i.test(text);

  if (isBBVA) {
    return parseBBVAStatement(text, defaultYear);
  }

  // 2. Deteccion de Tarjeta de Credito Scotiabank (Scotia Travel, Scotia Rewards, etc.)
  const isScotiabankCreditCard =
    /(?:Scotia\s*(?:Travel|Rewards)|Tarjeta\s+de\s+Cr[eé]dito\s+Scotiabank|TU\s+PAGO\s+REQUERIDO\s+ESTE\s+PERIODO|CARGOS,\s*ABONOS\s*Y\s*COMPRAS\s*REGULARES)/i.test(text) ||
    (/\b\d{2}-[a-z]{3}-\d{4}\s+\d{2}-[a-z]{3}-\d{4}\b/i.test(text) && /[+-]\s*\$?[0-9,]+\.[0-9]{2}/.test(text));

  if (isScotiabankCreditCard) {
    return parseScotiabankCreditCardStatement(text, defaultYear);
  }

  // 3. Scotiabank tradicional (Cuenta de Cheques / Débito)
  return parseScotiabankStatement(text, defaultYear);
};

module.exports = {
  parseBankStatement
};
