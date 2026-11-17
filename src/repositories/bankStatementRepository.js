/**
 * Repositorio de acceso a datos para Archivos de Estado de Cuenta (BankStatementFile).
 */

const BankStatementFile = require('../models/BankStatementFile');

const distinctPeriodos = () => BankStatementFile.distinct('periodo');

const distinctArchivosByBanco = (entidad, banco) =>
  BankStatementFile.distinct('nombreArchivo', { entidad, banco });

const countByEntidadInPeriodo = (periodo) =>
  BankStatementFile.aggregate([{ $match: { periodo } }, { $group: { _id: '$entidad', n: { $sum: 1 } } }]);

const findByPeriodAndEntity = (periodo, entidad) =>
  BankStatementFile.find({ periodo, entidad }).sort({ createdAt: -1 }).lean();

const findById = (id) => BankStatementFile.findById(id);

const countOtherRecordsForFile = (entidad, nombreArchivo, excludeId) =>
  BankStatementFile.countDocuments({
    entidad,
    nombreArchivo,
    _id: { $ne: excludeId }
  });

const upsertStatement = (periodo, entidad, nombreArchivo, fields) =>
  BankStatementFile.findOneAndUpdate(
    { periodo, entidad, nombreArchivo },
    { $set: fields },
    { upsert: true, new: true }
  );

const deleteById = (id) => BankStatementFile.deleteOne({ _id: id });

const deleteByPeriodAndEntity = (periodo, entidad) => BankStatementFile.deleteMany({ periodo, entidad });

const renameEntidad = (periodo, oldNombre, newNombre) =>
  BankStatementFile.updateMany({ periodo, entidad: oldNombre }, { $set: { entidad: newNombre } });

const bulkWrite = (ops) => BankStatementFile.bulkWrite(ops);

module.exports = {
  distinctPeriodos,
  distinctArchivosByBanco,
  countByEntidadInPeriodo,
  findByPeriodAndEntity,
  findById,
  countOtherRecordsForFile,
  upsertStatement,
  deleteById,
  deleteByPeriodAndEntity,
  renameEntidad,
  bulkWrite
};
