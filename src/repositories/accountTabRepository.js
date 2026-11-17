/**
 * Repositorio de acceso a datos para Pestanias de Cuenta (AccountTab).
 */

const AccountTab = require('../models/AccountTab');

const distinctPeriodos = () => AccountTab.distinct('periodo');

const countByPeriodo = (periodo) => AccountTab.countDocuments({ periodo });

const findByPeriodo = (periodo) => AccountTab.find({ periodo }).sort({ createdAt: 1 }).lean();

const findFirstByPeriodo = (periodo) => AccountTab.findOne({ periodo }).sort({ createdAt: 1 }).lean();

const findOne = (periodo, nombre, { lean = false } = {}) => {
  const query = AccountTab.findOne({ periodo, nombre });
  return lean ? query.lean() : query;
};

const create = (data) => AccountTab.create(data);

const deleteById = (id) => AccountTab.deleteOne({ _id: id });

const bulkWrite = (ops, options = {}) => AccountTab.bulkWrite(ops, options);

const save = (doc) => doc.save();

module.exports = {
  distinctPeriodos,
  countByPeriodo,
  findByPeriodo,
  findFirstByPeriodo,
  findOne,
  create,
  deleteById,
  bulkWrite,
  save
};
