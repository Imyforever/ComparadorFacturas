/**
 * Rutas de autenticacion (/api/auth).
 */

const express = require('express');
const authService = require('../services/authService');

const { createLoginRateLimit } = require('../middleware/loginRateLimit');

const router = express.Router();

router.post('/login', createLoginRateLimit(), async (req, res) => {
  try {
    const result = await authService.login(req.body || {});
    return res.status(200).json(result);
  } catch (err) {
    if (err.status && err.status < 500) {
      return res.status(err.status).json({
        success: false,
        message: err.message
      });
    }
    console.error('Error en login:', err);
    return res.status(500).json({
      success: false,
      message: 'Error interno en la autenticacion.'
    });
  }
});

module.exports = router;
