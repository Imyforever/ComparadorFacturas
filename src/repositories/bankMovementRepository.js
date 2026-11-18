/**
 * Repositorio de acceso a datos para Movimientos Bancarios (BankMovement).
 */

const BankMovement = require('../models/BankMovement');

const RESET_MOVEMENT = { conciliado: false, facturaUuid: null };

/** Movimientos visibles en un mes: los fechados en el mes o los que vienen de un archivo subido a ese mes */
const movementScope = (periodo, entidad) => ({ entidad, $or: [{ periodo }, { archivoPeriodo: periodo }] });

/** Movimientos que pertenecen a los archivos subidos en un mes (con soporte para registros antiguos sin archivoPeriodo) */
const ownedByUpload = (periodo) => ({
  $or: [{ archivoPeriodo: periodo }, { archivoPeriodo: { $in: [null, ''] }, periodo }]
});

/** Retiros de un mes (se excluyen los duplicados de otro archivo, que no cuentan para nada) */
const findRetirosInScope = (periodo, entidad) =>
  BankMovement.find({ ...movementScope(periodo, entidad), tipo: 'Retiro', duplicadoDe: null }).lean();

/** Retiros del mes anterior (mismo criterio de alcance que un mes normal) para casar facturas del mes siguiente */
const findRetirosOfPreviousMonth = (previousPeriodo, entidad) => findRetirosInScope(previousPeriodo, entidad);

/** Movimientos de OTROS archivos de la entidad que pueden ser el original de un movimiento que se sube */
const findDuplicateCandidates = (entidad, archivoOrigen, fechas = []) =>
  BankMovement.find(
    { entidad, archivoOrigen: { $ne: archivoOrigen }, duplicadoDe: null, fecha: { $in: fechas } },
    { fecha: 1, tipo: 1, monto: 1, saldo: 1, cuenta: 1, archivoOrigen: 1 }
  ).lean();

/** Quita la marca duplicadoDe de los movimientos que apuntaban a ids que ya no existen; devuelve sus alcances */
const releaseDuplicatesOf = async (ids) => {
  if (!ids || ids.length === 0) return [];
  const freed = await BankMovement.find(
    { duplicadoDe: { $in: ids } },
    { entidad: 1, periodo: 1, archivoPeriodo: 1, archivoOrigen: 1 }
  ).lean();
  if (freed.length > 0) await BankMovement.updateMany({ duplicadoDe: { $in: ids } }, { $set: { duplicadoDe: null } });
  return freed;
};

/** Lectura generica (scripts de datos). Siempre lean */
const findAll = (filter = {}, projection = null) => BankMovement.find(filter, projection).lean();

const findBBVAByFilesInScope = (periodo, entidad, officialFiles) =>
  BankMovement.find(
    { ...movementScope(periodo, entidad), banco: 'BBVA', archivoOrigen: { $in: officialFiles } },
    { concepto: 1, tipo: 1, archivoOrigen: 1 }
  ).lean();

const findById = (id) => BankMovement.findById(id);

const updateById = (id, fields) => BankMovement.findByIdAndUpdate(id, { $set: fields }, { new: true });

const releaseById = (id) => BankMovement.findByIdAndUpdate(id, { $set: RESET_MOVEMENT });

const releaseByInvoiceUuids = async (uuids) => {
  if (!uuids || uuids.length === 0) return;
  await BankMovement.updateMany({ facturaUuid: { $in: uuids } }, { $set: RESET_MOVEMENT });
};

const findByOwner = (entidad, archivoOrigen) =>
  BankMovement.find({ archivoOrigen, entidad }).sort({ _id: 1 }).lean();

const deleteByOwner = (entidad, archivoOrigen) => BankMovement.deleteMany({ archivoOrigen, entidad });

const insertMany = (docs) => BankMovement.insertMany(docs);

const distinctIdsByUpload = (periodo, entidad) =>
  BankMovement.distinct('_id', { entidad, ...ownedByUpload(periodo) });

const deleteByUpload = (periodo, entidad) =>
  BankMovement.deleteMany({ entidad, ...ownedByUpload(periodo) });

const distinctIdsByFile = (entidad, nombreArchivo, periodo = null) => {
  const filter = periodo
    ? { archivoOrigen: nombreArchivo, entidad, ...ownedByUpload(periodo) }
    : { archivoOrigen: nombreArchivo, entidad };
  return BankMovement.distinct('_id', filter);
};

const deleteByFile = (entidad, nombreArchivo, periodo = null) => {
  const filter = periodo
    ? { archivoOrigen: nombreArchivo, entidad, ...ownedByUpload(periodo) }
    : { archivoOrigen: nombreArchivo, entidad };
  return BankMovement.deleteMany(filter);
};

const renameEntidadByUpload = (periodo, oldNombre, newNombre) =>
  BankMovement.updateMany({ entidad: oldNombre, ...ownedByUpload(periodo) }, { $set: { entidad: newNombre } });

const aggregateStatsByFiles = (entidad, nombresArchivo) =>
  BankMovement.aggregate([
    { $match: { entidad, archivoOrigen: { $in: nombresArchivo }, duplicadoDe: null } },
    {
      $group: {
        _id: '$archivoOrigen',
        total: { $sum: 1 },
        cargosCount: { $sum: { $cond: [{ $eq: ['$tipo', 'Retiro'] }, 1, 0] } },
        abonosCount: { $sum: { $cond: [{ $eq: ['$tipo', 'Deposito'] }, 1, 0] } },
        montoCargos: { $sum: { $cond: [{ $eq: ['$tipo', 'Retiro'] }, '$monto', 0] } },
        montoAbonos: { $sum: { $cond: [{ $eq: ['$tipo', 'Deposito'] }, '$monto', 0] } }
      }
    }
  ]);

const bulkWrite = (ops) => BankMovement.bulkWrite(ops);

const save = (doc) => doc.save();

module.exports = {
  RESET_MOVEMENT,
  movementScope,
  ownedByUpload,
  findRetirosInScope,
  findRetirosOfPreviousMonth,
  findDuplicateCandidates,
  releaseDuplicatesOf,
  findAll,
  findBBVAByFilesInScope,
  findById,
  updateById,
  releaseById,
  releaseByInvoiceUuids,
  findByOwner,
  deleteByOwner,
  insertMany,
  distinctIdsByUpload,
  deleteByUpload,
  distinctIdsByFile,
  deleteByFile,
  renameEntidadByUpload,
  aggregateStatsByFiles,
  bulkWrite,
  save
};
