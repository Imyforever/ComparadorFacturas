/**
 * Middleware que exige conexion activa a MongoDB antes de ejecutar rutas de datos.
 */

const mongoose = require('mongoose');
const env = require('../config/env');

const createRequireDatabase = ({
  getReadyState = () => mongoose.connection.readyState,
  hasMongoUri = () => Boolean(env.MONGODB_URI)
} = {}) => {
  return (req, res, next) => {
    const state = getReadyState();
    if (state === 1 || state === 2) return next();
    return res.status(503).json({
      success: false,
      message: hasMongoUri()
        ? 'La base de datos no esta disponible en este momento. Intente de nuevo en unos segundos.'
        : 'La base de datos no esta configurada (falta MONGODB_URI en el archivo .env).'
    });
  };
};

const requireDatabase = createRequireDatabase();
requireDatabase.requireDatabase = requireDatabase;
requireDatabase.createRequireDatabase = createRequireDatabase;

module.exports = requireDatabase;
