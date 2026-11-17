/**
 * Utilidades puras de normalizacion de texto, coincidencia de proveedores y huellas.
 */

const crypto = require('crypto');

const normalizeText = (text) => {
  if (!text) return '';
  return String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

const stopWords = new Set([
  'sociedad',
  'anonima',
  'capital',
  'variable',
  'mexico',
  'corporativo',
  'grupo',
  'comercial',
  'nacional',
  'servicios',
  'distribuidora',
  'tiendas',
  'responsabilidad',
  'limitada'
]);

/**
 * Evalua coincidencia de nombre de proveedor en el concepto bancario.
 * Acepta el concepto ya normalizado para evitar recalcularlo en cada comparacion.
 */
const matchVendorName = (emisor, concepto, conceptoYaNormalizado = false) => {
  if (!emisor || !concepto) return false;
  const normEmisor = normalizeText(emisor);
  const normConcepto = conceptoYaNormalizado ? concepto : normalizeText(concepto);
  if (!normEmisor || !normConcepto) return false;

  const keywords = normEmisor.split(' ').filter((w) => w.length >= 4 && !stopWords.has(w));

  if (keywords.length === 0) {
    const prefix = normEmisor.substring(0, 8).trim();
    return prefix.length >= 3 && normConcepto.includes(prefix);
  }

  const conceptWords = new Set(normConcepto.split(' '));
  return keywords.some((kw) => conceptWords.has(kw) || (kw.length >= 6 && normConcepto.includes(kw)));
};

const normUuid = (value) => String(value || '').trim().toUpperCase();

/** Verifica si un valor tiene formato valido de ObjectId de 24 caracteres hexadecimales */
const isObjectId = (value) => typeof value === 'string' || typeof value === 'object'
  ? /^[a-fA-F0-9]{24}$/.test(String(value || ''))
  : false;

/** Decodifica texto plano probando UTF-8 y, si hay caracteres invalidos, Latin-1 (Excel en Windows) */
const decodeTextBuffer = (buffer) => {
  if (typeof buffer === 'string') return buffer;
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  return buffer.toString('latin1');
};

/**
 * Huella estable de un movimiento para reconocerlo al volver a subir el mismo archivo.
 * El indice de ocurrencia distingue cargos identicos el mismo dia (ej. 2 pagos iguales de Starlink).
 */
const computeHuellas = (movements = []) => {
  const seen = new Map();
  return movements.map((m) => {
    const base = [
      m.fecha || '',
      m.tipo || '',
      Number(m.monto || 0).toFixed(2),
      normalizeText(m.concepto || ''),
      m.cuenta || ''
    ].join('|');
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    return crypto.createHash('sha1').update(`${base}|${n}`).digest('hex');
  });
};

const safeAsciiFileName = (fileName) =>
  String(fileName || 'archivo')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w.\- ]/g, '_');

/** Longitud maxima aceptada de un identificador de login (usuario o correo) */
const MAX_LOGIN_IDENTIFIER_LENGTH = 254;

/**
 * Normaliza el identificador de login igual en el limitador de intentos y en el servicio de auth.
 * Devuelve '' si falta y null si excede la longitud maxima (debe rechazarse).
 */
const normalizeLoginIdentifier = (body = {}) => {
  const id = String((body && (body.username || body.email)) || '').trim().toLowerCase();
  if (id.length > MAX_LOGIN_IDENTIFIER_LENGTH) return null;
  return id;
};

module.exports = {
  MAX_LOGIN_IDENTIFIER_LENGTH,
  normalizeLoginIdentifier,
  normalizeText,
  matchVendorName,
  normUuid,
  isObjectId,
  decodeTextBuffer,
  computeHuellas,
  safeAsciiFileName
};
