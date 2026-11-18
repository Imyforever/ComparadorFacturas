/**
 * Repositorio de acceso a datos para Facturas (Invoice).
 */

const mongoose = require('mongoose');
const Invoice = require('../models/Invoice');

const RESET_INVOICE_PAYMENT = { estadoPago: 'No Pagada', pagoAsociado: null, pagoConjunto: null, editadoManualmente: false };

const isConnected = () => mongoose.connection.readyState === 1;

const getAllowedEstadosPago = () => Invoice.schema.path('estadoPago').enumValues;

const findAllSorted = () => Invoice.find().sort({ createdAt: -1 }).lean();

const findByPeriodAndEntity = (periodo, entidad, { sortByFecha = false } = {}) => {
  const query = Invoice.find({ periodo, entidad });
  if (sortByFecha) query.sort({ fechaEmision: 1 });
  return query.lean();
};

/** Facturas Pagada de TODOS los meses de la entidad con concepto bancario (para aprender alias de proveedor) */
const findPaidWithBankConceptByEntity = (entidad) =>
  Invoice.find(
    {
      entidad,
      estadoPago: 'Pagada',
      'pagoAsociado.movimientoId': { $ne: null },
      'pagoAsociado.conceptoBanco': { $nin: [null, ''] }
    },
    { uuid: 1, rfcEmisor: 1, estadoPago: 1, pagoAsociado: 1, pagoConjunto: 1 }
  ).lean();

const findByUuid = (uuid, { lean = false } = {}) => {
  const query = Invoice.findOne({ uuid });
  return lean ? query.lean() : query;
};

const findExternalPaidByMovementIds = (movementIds, periodo, entidad) =>
  Invoice.find(
    {
      'pagoAsociado.movimientoId': { $in: movementIds },
      estadoPago: 'Pagada',
      $nor: [{ periodo, entidad }]
    },
    { uuid: 1, 'pagoAsociado.movimientoId': 1 }
  ).lean();

const findAffectedByMovementIds = (movementIds) =>
  Invoice.find({ 'pagoAsociado.movimientoId': { $in: movementIds } }, { periodo: 1, entidad: 1 }).lean();

const releaseFromMovementIds = async (movementIds) => {
  const filter = { 'pagoAsociado.movimientoId': { $in: movementIds } };
  await Promise.all([
    Invoice.updateMany({ ...filter, estadoPago: 'Pagada' }, { $set: RESET_INVOICE_PAYMENT }),
    Invoice.updateMany({ ...filter, estadoPago: { $ne: 'Pagada' } }, { $set: { pagoAsociado: null } })
  ]);
};

const releaseByUuidAndMovement = (uuid, movementId) =>
  Invoice.findOneAndUpdate({ uuid, 'pagoAsociado.movimientoId': movementId }, { $set: RESET_INVOICE_PAYMENT });

const releaseOtherInvoicesFromMovement = (movementId, keepUuid) =>
  Invoice.updateMany({ uuid: { $ne: keepUuid }, 'pagoAsociado.movimientoId': movementId }, { $set: RESET_INVOICE_PAYMENT });

const clearEgresoFromIngreso = (ingresoUuid) =>
  Invoice.findOneAndUpdate({ uuid: ingresoUuid }, { $set: { egresoAsociado: null, ...RESET_INVOICE_PAYMENT } });

const clearLinksToDeletedUuids = async (uuids) => {
  if (!uuids || uuids.length === 0) return;
  await Invoice.updateMany(
    { 'ingresoAsociado.uuid': { $in: uuids } },
    { $set: { ingresoAsociado: null, editadoManualmente: false } }
  );
  await Invoice.updateMany(
    { 'egresoAsociado.uuid': { $in: uuids } },
    { $set: { egresoAsociado: null, ...RESET_INVOICE_PAYMENT } }
  );
};

const findVigentesByEfecto = (periodo, entidad, efecto) =>
  Invoice.find({ periodo, entidad, efecto, estadoSat: 'Vigente' }).sort({ fechaEmision: 1 }).lean();

const findElsewhereByUuids = (uuids, periodo, entidad) =>
  Invoice.find({ uuid: { $in: uuids }, $nor: [{ periodo, entidad }] }, { uuid: 1, periodo: 1, entidad: 1 }).lean();

const countByPeriodAndEntity = (periodo, entidad) => Invoice.countDocuments({ periodo, entidad });

const distinctPeriodos = () => Invoice.distinct('periodo');

const distinctEntidadesByPeriodo = (periodo) => Invoice.distinct('entidad', { periodo });

const distinctUuids = (periodo, entidad) => Invoice.distinct('uuid', { periodo, entidad });

const countByEntidadInPeriodo = (periodo) =>
  Invoice.aggregate([{ $match: { periodo } }, { $group: { _id: '$entidad', n: { $sum: 1 } } }]);

const renameEntidad = (periodo, oldNombre, newNombre) =>
  Invoice.updateMany({ periodo, entidad: oldNombre }, { $set: { entidad: newNombre } });

const deleteByPeriodAndEntity = (periodo, entidad) => Invoice.deleteMany({ periodo, entidad });

const bulkWrite = (ops, options = {}) => Invoice.bulkWrite(ops, options);

const create = (data) => Invoice.create(data);

const createValidatedAndSave = async (data, beforeSave) => {
  const doc = new Invoice(data);
  await doc.validate();
  if (beforeSave) await beforeSave(doc);
  await doc.save();
  return doc;
};

const save = (doc) => doc.save();

module.exports = {
  RESET_INVOICE_PAYMENT,
  isConnected,
  getAllowedEstadosPago,
  findAllSorted,
  findByPeriodAndEntity,
  findPaidWithBankConceptByEntity,
  findByUuid,
  findExternalPaidByMovementIds,
  findAffectedByMovementIds,
  releaseFromMovementIds,
  releaseByUuidAndMovement,
  releaseOtherInvoicesFromMovement,
  clearEgresoFromIngreso,
  clearLinksToDeletedUuids,
  findVigentesByEfecto,
  findElsewhereByUuids,
  countByPeriodAndEntity,
  distinctPeriodos,
  distinctEntidadesByPeriodo,
  distinctUuids,
  countByEntidadInPeriodo,
  renameEntidad,
  deleteByPeriodAndEntity,
  bulkWrite,
  create,
  createValidatedAndSave,
  save
};
