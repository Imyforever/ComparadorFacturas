/**
 * Registro central y detector automatico de formatos de estados de cuenta bancarios.
 * Cada lector cumple el contrato { id, canParse(text, fileName), parse(text, defaultYear) }.
 */

const { extractPdfText } = require('../services/pdfText');
const { parseFlexibleDate } = require('../utils/dates');
const { round2 } = require('../utils/money');
const { decodeTextBuffer } = require('../utils/text');
const { formatError } = require('../utils/errors');

const cfdiReportParser = require('./sat/cfdiReport');
const csvParser = require('./csv');
const bbvaDetalleWebParser = require('./bbva/detalleWeb');
const bbvaCreditCardParser = require('./bbva/creditCard');
const bbvaStatementParser = require('./bbva/statement');
const scotiabankCreditCardParser = require('./scotiabank/creditCard');
const scotiabankStatementParser = require('./scotiabank/statement');

// Orden estricto de deteccion (identico a detectAndParseBankStatement original)
const PARSERS = [
  csvParser,
  bbvaDetalleWebParser,
  bbvaCreditCardParser,
  bbvaStatementParser,
  scotiabankCreditCardParser,
  scotiabankStatementParser
];

const ALL_PARSERS = [cfdiReportParser, ...PARSERS];

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
        monto: round2(m.monto),
        ...(fechaNormalizada ? { fechaNormalizada } : {})
      };
    });

  return { ...result, movements, detectedPeriods: Array.from(new Set(result.detectedPeriods || [])).sort() };
};

/**
 * Detecta el primer parser compatible con el texto y nombre de archivo dados.
 * @param {string} text
 * @param {string} [fileName='']
 * @returns {{ id: string, canParse: Function, parse: Function } | null}
 */
const detectParser = (text, fileName = '') => {
  if (!text || typeof text !== 'string') return null;
  for (const parser of PARSERS) {
    if (parser.canParse(text, fileName)) {
      return parser;
    }
  }
  return null;
};

/**
 * Detecta el formato a partir de texto ya extraido y ejecuta su lector.
 * Lanza error 400 si ningun formato registrado lo reconoce.
 */
const parseByRegistry = (text, defaultYear = '2026', originalName = '') => {
  const parser = detectParser(text, originalName);
  if (!parser) {
    throw formatError(
      `No se reconocio el formato del archivo "${originalName}". Se aceptan estados de cuenta en PDF (BBVA, Scotiabank) o CSV de ScotiaWeb.`
    );
  }
  return parser.parse(text, String(defaultYear));
};

const detectAndParseBankStatement = async (fileBuffer, defaultYear = '2026', originalName = '') => {
  if (typeof fileBuffer === 'string') {
    return parseByRegistry(fileBuffer, defaultYear, originalName);
  }

  const header = fileBuffer.slice(0, 8);
  const isPdfBuffer = header.slice(0, 4).toString('latin1') === '%PDF';
  const isXlsx = header[0] === 0x50 && header[1] === 0x4b && header[2] === 0x03 && header[3] === 0x04;
  const isXlsBinary = header.toString('hex') === 'd0cf11e0a1b11ae1';

  if (!isPdfBuffer && (isXlsx || isXlsBinary)) {
    throw formatError(
      `El archivo "${originalName}" es un libro de Excel binario. Abralo en Excel y guardelo como "CSV (delimitado por comas)" para poder leerlo.`
    );
  }

  if (!isPdfBuffer) {
    const rawText = decodeTextBuffer(fileBuffer);
    if (csvParser.canParse(rawText, originalName)) {
      return csvParser.parse(rawText, defaultYear);
    }
    const matched = detectParser(rawText, originalName);
    if (matched) {
      return matched.parse(rawText, defaultYear);
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

  // En PDFs se conserva el comportamiento original: si ningun detector coincide se usa Scotiabank debito,
  // porque su texto extraido a menudo no incluye el nombre del banco (va en el logo).
  const parser = detectParser(text, originalName) || scotiabankStatementParser;
  return parser.parse(text, String(defaultYear));
};

const parseBankStatement = async (fileBuffer, defaultYear = '2026', originalName = '') => {
  if (!fileBuffer || fileBuffer.length === 0) {
    throw formatError(`El archivo "${originalName || 'sin nombre'}" esta vacio.`);
  }
  return finalizeStatement(await detectAndParseBankStatement(fileBuffer, String(defaultYear), originalName));
};

module.exports = {
  PARSERS,
  ALL_PARSERS,
  detectParser,
  parse: (text, defaultYear = '2026', originalName = '') =>
    finalizeStatement(parseByRegistry(text, defaultYear, originalName)),
  parseByRegistry,
  finalizeStatement,
  detectAndParseBankStatement,
  parseBankStatement
};
