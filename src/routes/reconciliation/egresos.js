/**
 * Rutas de vinculacion, desvinculacion y auto-vinculacion de Notas de Credito (Egresos).
 */

const express = require('express');
const egresoService = require('../../services/egresoService');
const { sendError } = require('../../middleware/errorHandler');

const router = express.Router();

router.post('/link-egreso', async (req, res) => {
  try {
    const { ingreso, egreso } = await egresoService.linkEgreso({
      ingresoUuid: req.body.ingresoUuid,
      egresoUuid: req.body.egresoUuid,
      observaciones: req.body.observaciones
    });

    return res.json({
      success: true,
      message: `Factura ${ingreso.uuid.substring(0, 8)}... vinculada exitosamente con la Nota de Crédito ${egreso.uuid.substring(0, 8)}... ($${(egreso.total || 0).toFixed(2)}).`,
      ingreso,
      egreso
    });
  } catch (err) {
    return sendError(res, err, 'Error vinculando egreso:');
  }
});

router.post('/unlink-egreso', async (req, res) => {
  try {
    await egresoService.unlinkEgreso({
      ingresoUuid: req.body.ingresoUuid,
      egresoUuid: req.body.egresoUuid
    });
    return res.json({
      success: true,
      message: 'Nota de crédito desvinculada exitosamente.'
    });
  } catch (err) {
    return sendError(res, err);
  }
});

router.post('/auto-link-egresos', async (req, res) => {
  try {
    const { linkedCount } = await egresoService.autoLinkEgresos({
      periodo: req.body.periodo,
      entidad: req.body.entidad
    });
    return res.json({
      success: true,
      linkedCount,
      message: `Se asociaron exitosamente ${linkedCount} facturas con sus Notas de Crédito correspondientes.`
    });
  } catch (err) {
    return sendError(res, err);
  }
});

module.exports = router;
