/**
 * Constructores de errores HTTP con codigo de estado.
 */

const httpError = (status, message, extra = {}) => {
  const err = new Error(message);
  err.status = status;
  Object.assign(err, extra);
  return err;
};

const formatError = (message) => httpError(400, message);

module.exports = {
  httpError,
  formatError
};
