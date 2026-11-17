/**
 * Manejadores de errores HTTP y rutas de API no encontradas.
 */

const multer = require('multer');

/** Responde un error con el codigo HTTP adecuado (400 para datos invalidos, 500 para fallas del servidor) */
const sendError = (res, err, logLabel) => {
  let status = err.status || 500;
  let message = err.message || 'Error interno del servidor.';

  if (err.name === 'CastError') {
    status = 400;
    message = `Valor invalido para el campo "${err.path}".`;
  } else if (err.name === 'ValidationError') {
    status = 400;
    message =
      Object.values(err.errors || {})
        .map((e) => e.message)
        .join(' ') || message;
  } else if (err.code === 11000) {
    status = 409;
    message = 'Ya existe un registro con esos datos.';
  }

  if (status >= 500) console.error(logLabel || '[Conciliacion] Error:', err);
  const payload = { success: false, message };
  if (err.isBlocked) payload.isBlocked = true;
  return res.status(status).json(payload);
};

const apiNotFoundHandler = (req, res) => {
  res.status(404).json({
    success: false,
    message: `Ruta de API no encontrada: ${req.method} ${req.originalUrl}`
  });
};

const errorHandler = (err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  if (err instanceof multer.MulterError) {
    const messages = {
      LIMIT_FILE_SIZE: 'El archivo excede el tamano maximo permitido.',
      LIMIT_FILE_COUNT: 'Se excedio el numero maximo de archivos por envio.',
      LIMIT_UNEXPECTED_FILE: 'Campo de archivo inesperado en el formulario.'
    };
    return res.status(400).json({ success: false, message: messages[err.code] || err.message });
  }

  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: 'El cuerpo de la peticion no es JSON valido.' });
  }

  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('[Error No Controlado]:', err);
  return res.status(status).json({
    success: false,
    message: err.message || 'Error interno del servidor.'
  });
};

errorHandler.errorHandler = errorHandler;
errorHandler.apiNotFoundHandler = apiNotFoundHandler;
errorHandler.sendError = sendError;

module.exports = errorHandler;
