/**
 * Repositorio de acceso a datos para Usuarios (User).
 */

const mongoose = require('mongoose');
const User = require('../models/User');

const isConnected = () => mongoose.connection.readyState === 1;

const findByUsername = (username) => User.findOne({ username: String(username || '').toLowerCase() });

const create = (data) => User.create(data);

module.exports = {
  isConnected,
  findByUsername,
  create
};
