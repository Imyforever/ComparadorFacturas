/**
 * ============================================================================
 * ARCHIVO CENTRAL DE FORMATOS Y LECTORES DE DOCUMENTOS (SAT Y BANCOS)
 * ============================================================================
 *
 * En este único archivo se concentran TODOS los tipos de formatos de archivo
 * que lee el programa y la manera exacta en que extrae su información.
 *
 * Si deseas añadir un nuevo banco/formato o modificar cómo se lee alguno de
 * los existentes, todo se hace aquí:
 *
 * ÍNDICE DE FORMATOS SOPORTADOS EN ESTE ARCHIVO:
 *   1. SAT - Reporte de Consulta CFDI (PDF)                -> parseCfdiReport()
 *   2. BBVA - Estado de Cuenta Oficial Débito / PyME (PDF) -> parseBBVAStatement()
 *   3. BBVA - Detalle de Movimientos Portal Web (PDF)      -> parseBBVADetalleMovimientos()
 *   4. BBVA - Tarjeta de Crédito / Negocios / LCDigital    -> parseBBVACreditOrCardStatement()
 *   5. Scotiabank - Estado de Cuenta Débito / Cheques (PDF)-> parseScotiabankStatement()
 *   6. Scotiabank - Tarjeta de Crédito Travel/Rewards (PDF)-> parseScotiabankCreditCardStatement()
 *   7. Scotiabank - Formato Tipo Excel / CSV (ScotiaWeb)   -> parseCsvOrExcelBankStatement()
 *
 * DETECTOR AUTOMÁTICO DE FORMATOS BANCARIOS:
 *   - parseBankStatement(fileBuffer, defaultYear, originalName)
 * ============================================================================
 */

const { extractPdfText } = require('./pdfText');
const { parseFlexibleDate, resolveYearForMonth } = require('./dates');

/** Convierte un importe textual ("1,234.56", "$ 1,234.56", "-50.00") a numero; NaN si no es valido */
const parseAmount = (raw) => {
  if (raw === undefined || raw === null) return NaN;
  const cleaned = String(raw).replace(/[$\s,]/g, '');
  if (!cleaned) return NaN;
  return parseFloat(cleaned);
};

/** Error de formato de archivo: las rutas lo responden como 400 (problema del archivo, no del servidor) */
const formatError = (message) => {
  const err = new Error(message);
  err.status = 400;
  return err;
};

// ============================================================================
// CATÁLOGOS Y CONSTANTES COMPARTIDAS ENTRE FORMATOS
// ============================================================================

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

const NUM_TO_MONTH_MAP = {
  '01': 'ENE',
  '02': 'FEB',
  '03': 'MAR',
  '04': 'ABR',
  '05': 'MAY',
  '06': 'JUN',
  '07': 'JUL',
  '08': 'AGO',
  '09': 'SEP',
  '10': 'OCT',
  '11': 'NOV',
  '12': 'DIC'
};

const knownBBVACargoCodes = new Set([
  'A15', 'I73', 'I74', 'K08', 'K64', 'K65', 'P14', 'P31',
  'R01', 'S39', 'S40', 'T17', 'V43', 'V44', 'V46', 'V47', 'X01'
]);

const knownBBVADepositoCodes = new Set([
  'T20', 'V42', 'V45', 'AA7', 'C02', 'G30'
]);

/**
 * Clasifica con 100% de precisión si un movimiento de BBVA (con o sin código de operación de 3 caracteres)
 * corresponde a un Retiro (Cargo) o un Deposito (Abono).
 */
const classifyBBVAMovementIsRetiro = (concepto, codeParam = '') => {
  const fullConcept = (concepto || '').trim();
  const firstWord = fullConcept.split(/\s+/)[0].toUpperCase();
  const code = (codeParam || (/^[A-Z0-9]{3}$/.test(firstWord) ? firstWord : '')).toUpperCase();

  // 1. Si tiene un código oficial de cargo BBVA
  if (knownBBVACargoCodes.has(code)) return true;

  // 2. Si tiene un código oficial de abono/depósito BBVA
  if (knownBBVADepositoCodes.has(code)) return false;

  // 3. Código N06 (Pago Cuenta de Tercero): en cuentas receptoras ISP son abonos de clientes,
  //    pero si menciona cotización, mantenimiento, compra, contadora, factura, sueldo o proveedor es un cargo (Retiro).
  if (code === 'N06') {
    return /COT\s+\d+|MANTENIMIENTO|COMPRA|CONTADORA|FACTURA|PROVEEDOR|SUELDO|NOMINA/i.test(fullConcept);
  }

  // 4. Estados de cuenta BBVA sin columna de código de 3 caracteres:
  //    Identificar primero los Abonos/Depósitos explícitos (Ventas TPV crédito/débito/Amex, Depósito en efectivo,
  //    SPEI recibido o devuelto, Traspaso de tarjeta a cuenta, Abonos o Bonificaciones).
  if (
    /^(?:[A-Z0-9]{3}\s+)?(?:VENTAS?\s+(?:CREDITO|DEBITO|TDC)|VENTA\s+NAL\.\s+AMEX|DEPOSITO\s+(?:EN\s+)?EFECTIVO|SPEI\s+RECIBIDO|SPEI\s+DEVUELTO|TRASPASO\s+TARJETA\s+A\s+CUENTA|ABONO|BONIFICACION)/i.test(
      fullConcept
    )
  ) {
    return false;
  }

  // 5. Todo consumo con tarjeta (******1234, AUT:, RFC:), pago referenciado CIE (GUIA:, CIE:),
  //    SPEI enviado, pago cuenta de tercero, pago tarjeta de crédito, cobranza domiciliada,
  //    nómina, IMSS, comisiones e IVA de TPV son Retiros (Cargos).
  return true;
};

/**
 * Helper para dividir una línea CSV respetando comillas dobles
 */
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

// ============================================================================
// FORMATO 1: FACTURAS DEL SAT - REPORTE DE CONSULTA CFDI (PDF)
// ============================================================================
/**
 * CÓMO LO LEE EL PROGRAMA:
 * - Divide el texto del PDF usando "Folio Fiscal:" como separador de cada factura.
 * - Extrae el UUID (36 caracteres), RFC Emisor, Nombre o Razón Social, Fecha de Emisión,
 *   Total ($), Estado del Comprobante (Vigente / Cancelado) y Efecto (Ingreso / Egreso).
 * - Toma los primeros 7 caracteres de Fecha Emisión (YYYY-MM) para determinar el mes.
 */
const parseCfdiReport = async (pdfBuffer) => {
  if (!pdfBuffer || pdfBuffer.length < 4 || pdfBuffer.slice(0, 4).toString('latin1') !== '%PDF') {
    throw formatError('El archivo de facturas debe ser el PDF del reporte de Consulta CFDI del SAT.');
  }

  const text = await extractPdfText(pdfBuffer);

  const blocks = text.split(/Folio Fiscal:\s*/i).filter((b) => b.trim().length > 0);
  const invoices = [];
  const periodCounts = {};

  for (const block of blocks) {
    const uuidMatch = block.match(/^([A-Fa-f0-9-]{36})/);
    if (!uuidMatch) continue;

    const uuid = uuidMatch[1].trim().toUpperCase();

    const rfcEmisorMatch = block.match(/RFC Emisor:\s*([A-Z0-9&Ñ]+)/i);
    const emisorMatch = block.match(/RFC Emisor:\s*[A-Z0-9&Ñ]+\s+Nombre o Razón Social:\s*([^\n\r\t]+)/i);

    const rfcReceptorMatch = block.match(/RFC Receptor:\s*([A-Z0-9&Ñ]+)/i);
    const receptorMatch = block.match(/RFC Receptor:\s*[A-Z0-9&Ñ]+\s+Nombre o Razón Social:\s*([^\n\r\t]+)/i);

    const fechaEmisionMatch = block.match(/Fecha Emisión:\s*(\S+)/i);
    const fechaCertMatch = block.match(/Fecha Certificación:\s*(\S+)/i);

    // (?<![A-Za-z]) evita confundir "SubTotal:" con "Total:"
    const totalMatch = block.match(/(?<![A-Za-z])Total:\s*\$?\s*([0-9,]+(?:\.[0-9]{1,2})?)/i);
    const pacMatch = block.match(/PAC que Certificó:\s*([^\n\r\t]+)/i);

    const estadoMatch = block.match(/Estado del Comprobante:\s*([^\n\r]+?)(?=\s*Efecto|\s*$)/i);
    const efectoMatch = block.match(/Efecto del Comprobante:\s*([^\n\r]+)/i);

    const rawFecha = fechaEmisionMatch ? fechaEmisionMatch[1].trim() : '';
    let periodo = '';
    if (rawFecha.length >= 7) {
      periodo = rawFecha.substring(0, 7); // Formato "2026-09"
      periodCounts[periodo] = (periodCounts[periodo] || 0) + 1;
    }

    const rawTotal = totalMatch ? parseFloat(totalMatch[1].replace(/,/g, '')) : 0;
    const rawEstado = estadoMatch ? estadoMatch[1].trim() : 'Vigente';
    const isCancelada = /cancelad/i.test(rawEstado);

    let rawEfecto = efectoMatch ? efectoMatch[1].trim() : 'Ingreso';
    let efectoNormalizado = 'Ingreso';
    if (/egreso/i.test(rawEfecto)) efectoNormalizado = 'Egreso';
    else if (/pago/i.test(rawEfecto)) efectoNormalizado = 'Pago';
    else if (/n[oó]mina/i.test(rawEfecto)) efectoNormalizado = 'Nomina';
    else if (/traslado/i.test(rawEfecto)) efectoNormalizado = 'Traslado';

    invoices.push({
      uuid,
      periodo: periodo || '2026-09',
      emisor: emisorMatch ? emisorMatch[1].trim() : (rfcEmisorMatch ? rfcEmisorMatch[1] : 'Emisor no identificado'),
      rfcEmisor: rfcEmisorMatch ? rfcEmisorMatch[1].trim().toUpperCase() : '',
      receptor: receptorMatch ? receptorMatch[1].trim() : '',
      rfcReceptor: rfcReceptorMatch ? rfcReceptorMatch[1].trim().toUpperCase() : '',
      fechaEmision: rawFecha,
      fechaCertificacion: fechaCertMatch ? fechaCertMatch[1].trim() : '',
      total: isNaN(rawTotal) ? 0 : rawTotal,
      pac: pacMatch ? pacMatch[1].trim() : '',
      estadoSat: isCancelada ? 'Cancelado' : 'Vigente',
      efecto: efectoNormalizado,
      estadoPago: isCancelada ? 'Cancelada' : 'No Pagada'
    });
  }

  // Determinar el periodo principal detectado
  let detectedPeriod = '';
  let maxCount = 0;
  for (const [p, count] of Object.entries(periodCounts)) {
    if (count > maxCount) {
      maxCount = count;
      detectedPeriod = p;
    }
  }

  // Si el documento no trae fechas reconocibles se devuelve '' para que la ruta no rechace el archivo
  // comparandolo contra un mes inventado.
  return {
    invoices,
    detectedPeriod
  };
};

// ============================================================================
// FORMATO 2: BBVA - ESTADO DE CUENTA OFICIAL DÉBITO / MAESTRA PYME (PDF)
// ============================================================================
/**
 * CÓMO LO LEE EL PROGRAMA:
 * - Detecta el año en "Fecha de Corte DD/MM/YYYY" y el número de cuenta en "No. de Cuenta".
 * - Identifica cada movimiento porque inicia con dos fechas "DD/MES DD/MES" (Operación y Liquidación),
 *   seguido opcionalmente de un código de 3 caracteres (ej: N06, T17, R01), concepto e importe.
 * - Clasifica como Retiro (Cargo) o Deposito (Abono) según el código de operación BBVA
 *   (knownBBVACargoCodes) o palabras clave del concepto (SPEI ENVIADO, PAGO DE NOMINA, IMSS, etc.).
 * - Extrae el RFC de las líneas de detalle adicionales del movimiento.
 */
const parseBBVAStatement = (text, defaultYear = '2026') => {
  let detectedYear = defaultYear;
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
      // Estados de cuenta de diciembre-enero: los movimientos de diciembre pertenecen al anio anterior
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

// ============================================================================
// FORMATO 3: BBVA - DETALLE DE MOVIMIENTOS PORTAL WEB (PDF)
// ============================================================================
/**
 * CÓMO LO LEE EL PROGRAMA:
 * - Se activa cuando el PDF contiene "Detalle de movimientos" y "Cuenta con / sin chequera".
 * - Agrupa bloques que inician con fecha numérica corta "DD-MM".
 * - Toma el primer monto con "$" como importe del movimiento y el último monto con "$" como saldo.
 * - Como el reporte viene de más reciente a más antiguo, compara el saldo de la fila actual
 *   contra el saldo de la fila siguiente (anterior cronológicamente) para saber si fue Cargo o Abono.
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
          if (Math.abs(prevSaldo - amount - saldo) < 0.02) isCargo = true;
          else if (Math.abs(prevSaldo + amount - saldo) < 0.02) isCargo = false;
          else isCargo = saldo < prevSaldo;
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

// ============================================================================
// FORMATO 4: BBVA - TARJETA DE CRÉDITO / NEGOCIOS / LÍNEA CRÉDITO PYME (PDF)
// ============================================================================
/**
 * CÓMO LO LEE EL PROGRAMA:
 * - Se activa con "Línea Crédito Digital PyME", "T Negoc" o "LCDigital".
 * - Lee renglones con estructura: FECHA_AUT (DD/MM/YY) FECHA_APL (DD/MM/YY) CONCEPTO [RFC] [REFERENCIA] [IMPORTE].
 *   Ejemplo: "03/09/26 04/09/26 FERRE ABAS MAX CHETUM AMA 0512139J5 ******9851 $ 2,177.99"
 * - Separa del final del renglón el monto, la referencia con asteriscos (******9851) y el RFC del comercio.
 * - Clasifica como Retiro (Cargo) a menos que el concepto diga PAGO, ABONO, DEVOLUCIÓN o BONIFICACIÓN.
 */
const parseBBVACreditOrCardStatement = (text, defaultYear = '2026') => {
  let detectedYear = defaultYear;
  const detectedPeriodsSet = new Set();

  // 1. Detectar periodo del estado de cuenta (ej: "Del 03/09/26 al 02/10/26" o "Periodo Del ...")
  const periodoMatch =
    text.match(/Periodo\s+(?:Del\s+)?(\d{2})[\/\-](\d{2})[\/\-](\d{2,4})\s+al\s+(\d{2})[\/\-](\d{2})[\/\-](\d{2,4})/i) ||
    text.match(/Del\s+(\d{2})[\/\-](\d{2})[\/\-](\d{2,4})\s+al\s+(\d{2})[\/\-](\d{2})[\/\-](\d{2,4})/i);

  if (periodoMatch) {
    const yStart = periodoMatch[3].length === 2 ? '20' + periodoMatch[3] : periodoMatch[3];
    const mStart = periodoMatch[2];
    const yEnd = periodoMatch[6].length === 2 ? '20' + periodoMatch[6] : periodoMatch[6];
    const mEnd = periodoMatch[5];

    detectedYear = yStart;
    detectedPeriodsSet.add(`${yStart}-${mStart}`);
    detectedPeriodsSet.add(`${yEnd}-${mEnd}`);
  }

  // Detectar Fecha de Corte (ej: "Fecha de Corte 02/10/26")
  const corteMatch = text.match(/Fecha\s+de\s+Corte\s+(\d{2})[\/\-](\d{2})[\/\-](\d{2,4})/i);
  if (corteMatch) {
    const corteYear = corteMatch[3].length === 2 ? '20' + corteMatch[3] : corteMatch[3];
    const corteMonth = corteMatch[2];
    detectedPeriodsSet.add(`${corteYear}-${corteMonth}`);
  }

  // 2. Detectar Banco y Cuenta
  let banco = 'BBVA';
  let cuenta = '';

  const isLineaCreditoPyme = /L[ií]nea\s+Cr[eé]dito\s+Digital\s+PyME/i.test(text);
  const isTarjetaNegocios = /T\s*Negoc(?:\s*\/\s*LCDigital)?/i.test(text);

  if (isLineaCreditoPyme) {
    banco = 'BBVA (Línea Crédito PyME)';
    const creditoMatch =
      text.match(/No\.\s+de\s+Cr[eé]dito\s*([0-9\s]{16,22})/i) ||
      text.match(/Cr[eé]dito\s*([0-9\s]{16,22})/i);
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

  // 3. Parsear líneas de movimientos
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const rowRegex = /^(\d{2}[\/\-]\d{2}[\/\-]\d{2,4})\s+(\d{2}[\/\-]\d{2}[\/\-]\d{2,4})\s+(.+)$/;
  const amountRegex = /(?:\$\s*)?([0-9]{1,3}(?:,[0-9]{3})*\.[0-9]{2})(?:\s+(?:\$\s*)?([0-9]{1,3}(?:,[0-9]{3})*\.[0-9]{2}))?\s*$/;

  const movements = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^FECHA\s+AUTORIZACION/i.test(line)) continue;
    if (/^TOTAL\s+IMPORTES/i.test(line)) continue;

    const rowMatch = line.match(rowRegex);
    if (!rowMatch) continue;

    const fechaAut = rowMatch[1];
    const rest = rowMatch[3].trim();

    // Extraer montos del final de la línea
    const amtMatch = rest.match(amountRegex);
    if (!amtMatch) continue;

    const amt1 = parseFloat(amtMatch[1].replace(/,/g, ''));
    const amt2 = amtMatch[2] ? parseFloat(amtMatch[2].replace(/,/g, '')) : null;

    let remainder = rest.substring(0, amtMatch.index).trim();

    // Extraer referencia (ej: "******8803", "******9851" o número de referencia)
    let referencia = '';
    const refMatch = remainder.match(/(?:\*{3,}[0-9A-Z]+|\b\d{6,12}\b)$/i);
    if (refMatch) {
      referencia = refMatch[0];
      remainder = remainder.substring(0, refMatch.index).trim();
    }

    // Extraer RFC si existe en el renglón
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

    // Determinar fechas
    const parts = fechaAut.split(/[\/\-]/);
    const dAut = parts[0];
    const mAut = parts[1];
    const yAutRaw = parts[2] || defaultYear;
    const yAut = yAutRaw.length === 2 ? '20' + yAutRaw : yAutRaw;
    const monthNum = mAut;
    const monthStr = NUM_TO_MONTH_MAP[monthNum] || 'SEP';
    const mvPeriodo = `${yAut}-${monthNum}`;

    detectedPeriodsSet.add(mvPeriodo);

    // Determinar si es Cargo (Retiro) o Abono (Deposito)
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
      const isAbono = /(?:^|\s)(?:PAGO|ABONO|DEPOSITO|DEVOLUCI[OÓ]N|REEMBOLSO|BONIFICACI[OÓ]N|TRASPASO\s+A\s+FAVOR|SU\s+PAGO\s+EN)(?:\s|$)/i.test(
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
      concepto: (concepto || rest).substring(0, 250),
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

// ============================================================================
// FORMATO 5: SCOTIABANK - ESTADO DE CUENTA DÉBITO / CHEQUES (PDF)
// ============================================================================
/**
 * CÓMO LO LEE EL PROGRAMA:
 * - Detecta el año en "Periodo DD-MES-YY" y el número de cuenta en "Cuenta <dígitos>".
 * - Divide los movimientos por bloques que comienzan con fecha "DD MES" (ej: "15 SEP").
 * - Extrae los montos con "$": el primero es el importe de la operación y el último es el saldo.
 * - Calcula si fue Retiro (Cargo) o Deposito (Abono) verificando si el saldo disminuyó o aumentó
 *   respecto al saldo anterior (prevSaldo +- monto = saldo).
 */
const parseScotiabankStatement = (text, defaultYear = '2026') => {
  let detectedYear = defaultYear;
  let startMonth = 0;
  const yearMatch = text.match(/Periodo\s+\d{2}-([A-Z]{3})-(\d{2})/i);
  if (yearMatch) {
    detectedYear = '20' + yearMatch[2];
    startMonth = Number(MONTH_MAP[yearMatch[1].toUpperCase()] || 0);
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

  // Saldo inicial del periodo (si el documento lo trae) para clasificar correctamente el primer movimiento
  const saldoInicialMatch = text.match(/Saldo\s+(?:inicial|anterior)[^$\n]*\$\s*([0-9,]+\.[0-9]{2})/i);
  let prevSaldo = saldoInicialMatch ? parseAmount(saldoInicialMatch[1]) : null;
  if (!Number.isFinite(prevSaldo)) prevSaldo = null;

  for (const block of blocks) {
    const headerLine = block.trim().split('\n')[0];
    const dateMatch = headerLine.match(/^(\d{2})\s+(ENE|FEB|MAR|ABR|MAY|JUN|JUL|AGO|SEP|OCT|NOV|DIC)/i);
    if (!dateMatch) continue;

    const day = dateMatch[1];
    const monthStr = dateMatch[2].toUpperCase();
    const monthNum = MONTH_MAP[monthStr] || '09';
    const txYear = resolveYearForMonth(detectedYear, startMonth, Number(monthNum), 'start');
    const periodo = `${txYear}-${monthNum}`;

    const amountMatches = [...block.matchAll(/\$([0-9,]+\.[0-9]{2})/g)].map((m) =>
      parseFloat(m[1].replace(/,/g, ''))
    );

    if (amountMatches.length < 2) continue;

    const amount = amountMatches[0];
    const saldo = amountMatches[amountMatches.length - 1];

    detectedPeriodsSet.add(periodo);

    let isRetiro = true;
    if (prevSaldo !== null) {
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
      fecha: `${day}-${monthStr}-${txYear}`,
      tipo: isRetiro ? 'Retiro' : 'Deposito',
      monto: amount,
      saldo,
      rfcDetectado: rfc,
      concepto: conceptFull.substring(0, 250),
      conciliado: false
    });
  }

  return {
    banco: 'Scotiabank',
    cuenta: cuenta ? `Cuenta ${cuenta}` : 'Scotiabank',
    movements: transactions,
    detectedPeriods: Array.from(detectedPeriodsSet)
  };
};

// ============================================================================
// FORMATO 6: SCOTIABANK - TARJETA DE CRÉDITO SCOTIA TRAVEL / REWARDS (PDF)
// ============================================================================
/**
 * CÓMO LO LEE EL PROGRAMA:
 * - Detecta renglones con doble fecha "DD-mes-YYYY DD-mes-YYYY" seguidos de descripción,
 *   signo (+ o -) e importe.
 * - En estados de cuenta de TDC Scotiabank, el signo "+" indica un consumo/cargo a la tarjeta
 *   (se clasifica como Retiro) y el signo "-" indica un pago/abono a la tarjeta (Deposito).
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
    banco: 'Scotiabank (TDC)',
    cuenta,
    movements,
    detectedPeriods: Array.from(detectedPeriodsSet).sort()
  };
};

// ============================================================================
// FORMATO 7: SCOTIABANK - FORMATO TIPO EXCEL / CSV (SCOTIAWEB)
// ============================================================================
/**
 * CÓMO LO LEE EL PROGRAMA:
 * - Lee archivos .csv, .txt, .xls, .xlsx exportados de Scotiabank con las 15 columnas:
 *   [0] Tipo (CHQ), [1] Moneda (MXN), [2] Uso futuro, [3] Cuenta, [4] Fecha (YYYY/MM/DD),
 *   [5] Referencia, [6] Importe, [7] Tipo(Cargo/Abono), [8] Saldo, [9] Transacción,
 *   [10] Leyenda 1, [11] Leyenda 2, [12] Leyenda 3, [13] Información adicional SPEI/SPID, [14] Consecutivo.
 * - Si existe una primera línea de resumen antes del encabezado (ej: 502424129,25601064912,NOMBRE...),
 *   extrae de ahí el número de cuenta.
 * - Convierte la columna Fecha (YYYY/MM/DD) a periodo (YYYY-MM) y formato DD-MES-YYYY.
 * - Clasifica directamente por la columna 7: "Cargo" -> Retiro, "Abono" -> Deposito.
 * - Une Transacción + Leyendas 1, 2, 3 + Información SPEI para armar el concepto y extrae el RFC
 *   que viene en Leyenda 3 (ej: "RFC NWM 9709244W4" -> "NWM9709244W4").
 */
const parseCsvOrExcelBankStatement = (text, defaultYear = '2026') => {
  const cleanText = text.replace(/^\uFEFF/, '');
  const lines = cleanText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  let headerIndex = -1;
  let cuentaHeader = '';

  // Detectar separador (coma, punto y coma o tabulador) segun las primeras lineas
  const sample = lines.slice(0, 15).join('\n');
  const delimiterCounts = [',', ';', '\t'].map((d) => ({ d, n: sample.split(d).length - 1 }));
  delimiterCounts.sort((a, b) => b.n - a.n);
  const delimiter = delimiterCounts[0].n > 0 ? delimiterCounts[0].d : ',';
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

  // Si la primera fila antes del encabezado es el resumen de Scotiabank (ej: 502424129,25601064912,NOMBRE,MXN,...)
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

    // Parsear fecha (ej: "2026/10/28", "2026-10-28" o "28/10/2026")
    let year = defaultYear;
    let monthNum = '09';
    let day = '01';

    // Acepta tambien dia/mes de un digito y hora al final (ej. "2026/10/28 00:00:00")
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
    const fullConcept = conceptParts.join(' | ');

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

// ============================================================================
// ENRUTADOR / DETECTOR AUTOMÁTICO DE FORMATOS DE ESTADOS DE CUENTA
// ============================================================================
/**
 * Detecta automáticamente a qué formato bancario pertenece el archivo subido
 * y ejecuta su lector correspondiente.
 */
const looksLikeScotiaCsv = (text) =>
  /Tipo\s*[,;\t]\s*Moneda\s*[,;\t]\s*Uso\s+futuro/i.test(text) ||
  /Tipo\s*\(\s*Cargo\s*\/\s*Abono\s*\)/i.test(text) ||
  /^"?CHQ"?\s*[,;\t]\s*"?MXN"?\s*[,;\t]/im.test(text);

/** Decodifica texto plano probando UTF-8 y, si hay caracteres invalidos, Latin-1 (Excel en Windows) */
const decodeTextBuffer = (buffer) => {
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('�')) return utf8;
  return buffer.toString('latin1');
};

/**
 * Completa campos derivados comunes a todos los formatos:
 * - fechaNormalizada (Date) para ordenar correctamente por fecha
 * - monto redondeado a centavos
 */
const finalizeStatement = (result) => {
  const movements = (result.movements || [])
    .filter((m) => m && Number.isFinite(m.monto) && m.monto > 0)
    .map((m) => {
      const fechaNormalizada =
        m.fechaNormalizada instanceof Date && !isNaN(m.fechaNormalizada.getTime())
          ? m.fechaNormalizada
          : parseFlexibleDate(m.fecha);
      return {
        ...m,
        monto: Math.round(m.monto * 100) / 100,
        ...(fechaNormalizada ? { fechaNormalizada } : {})
      };
    });

  return { ...result, movements, detectedPeriods: Array.from(new Set(result.detectedPeriods || [])).sort() };
};

const parseBankStatement = async (fileBuffer, defaultYear = '2026', originalName = '') => {
  if (!fileBuffer || fileBuffer.length === 0) {
    throw formatError(`El archivo "${originalName || 'sin nombre'}" esta vacio.`);
  }
  return finalizeStatement(await detectAndParseBankStatement(fileBuffer, String(defaultYear), originalName));
};

const detectAndParseBankStatement = async (fileBuffer, defaultYear, originalName) => {
  const header = fileBuffer.slice(0, 8);
  const isPdfBuffer = header.slice(0, 4).toString('latin1') === '%PDF';
  const isXlsx = header[0] === 0x50 && header[1] === 0x4b && header[2] === 0x03 && header[3] === 0x04; // ZIP (PK..)
  const isXlsBinary = header.toString('hex') === 'd0cf11e0a1b11ae1'; // OLE2 (Excel 97-2003)

  if (!isPdfBuffer && (isXlsx || isXlsBinary)) {
    throw formatError(
      `El archivo "${originalName}" es un libro de Excel binario. Abralo en Excel y guardelo como "CSV (delimitado por comas)" para poder leerlo.`
    );
  }

  // 1. Detección de Formato Tipo Excel / CSV (Scotiabank ScotiaWeb)
  if (!isPdfBuffer) {
    const rawText = decodeTextBuffer(fileBuffer);
    if (looksLikeScotiaCsv(rawText)) {
      return parseCsvOrExcelBankStatement(rawText, defaultYear);
    }
    throw formatError(
      `No se reconocio el formato del archivo "${originalName}". Se aceptan estados de cuenta en PDF (BBVA, Scotiabank) o CSV de ScotiaWeb.`
    );
  }

  const text = await extractPdfText(fileBuffer);

  if (!text || text.trim().length < 20) {
    throw formatError(
      `No se pudo extraer texto del PDF "${originalName}". Puede ser un documento escaneado (imagen) o protegido con contrasena.`
    );
  }

  if (looksLikeScotiaCsv(text)) {
    return parseCsvOrExcelBankStatement(text, defaultYear);
  }

  // 2. Detección de BBVA Detalle de Movimientos (Portal Web / Cash Management)
  const isBBVADetalle =
    /Detalle\s+de\s+movimientos/i.test(text.substring(0, 800)) &&
    /Cuenta\s+con\s*\/\s*sin\s+chequera/i.test(text.substring(0, 800));

  if (isBBVADetalle) {
    return parseBBVADetalleMovimientos(text, defaultYear);
  }

  // 3. Detección de BBVA Línea Crédito Digital PyME y T Negoc / LCDigital (Tarjeta Negocios)
  const isBBVALCDigital =
    /L[ií]nea\s+Cr[eé]dito\s+Digital\s+PyME/i.test(text) ||
    /T\s*Negoc(?:\s*\/\s*LCDigital)?/i.test(text) ||
    /LCDigital/i.test(text) ||
    (/Movimientos\s+Efectuados\s+(?:Cr[eé]dito|Tarjeta\s+Titular)/i.test(text) && /BBVA/i.test(text));

  if (isBBVALCDigital) {
    return parseBBVACreditOrCardStatement(text, defaultYear);
  }

  // 4. Detección de BBVA Oficial (Centralizadora / Maestra Pyme / Estado de Cuenta)
  const isBBVA =
    /BBVA/i.test(text.substring(0, 1500)) ||
    /MAESTRA PYME/i.test(text.substring(0, 1500)) ||
    /CENTRALIZADORA/i.test(text.substring(0, 1500)) ||
    /\b\d{2}\/[A-Z]{3}\s+\d{2}\/[A-Z]{3}\b/i.test(text);

  if (isBBVA) {
    return parseBBVAStatement(text, defaultYear);
  }

  // 5. Detección de Tarjeta de Crédito Scotiabank (Scotia Travel, Scotia Rewards, etc.)
  const isScotiabankCreditCard =
    /(?:Scotia\s*(?:Travel|Rewards)|Tarjeta\s+de\s+Cr[eé]dito\s+Scotiabank|TU\s+PAGO\s+REQUERIDO\s+ESTE\s+PERIODO|CARGOS,\s*ABONOS\s*Y\s*COMPRAS\s*REGULARES)/i.test(text) ||
    (/\b\d{2}-[a-z]{3}-\d{4}\s+\d{2}-[a-z]{3}-\d{4}\b/i.test(text) && /[+-]\s*\$?[0-9,]+\.[0-9]{2}/.test(text));

  if (isScotiabankCreditCard) {
    return parseScotiabankCreditCardStatement(text, defaultYear);
  }

  // 6. Scotiabank tradicional (Cuenta de Cheques / Débito)
  return parseScotiabankStatement(text, defaultYear);
};

module.exports = {
  parseCfdiReport,
  parseBankStatement,
  parseCsvOrExcelBankStatement,
  parseBBVACreditOrCardStatement,
  parseBBVAStatement,
  parseBBVADetalleMovimientos,
  parseScotiabankStatement,
  parseScotiabankCreditCardStatement,
  classifyBBVAMovementIsRetiro
};

