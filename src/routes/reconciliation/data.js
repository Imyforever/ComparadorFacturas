/**
 * Rutas de obtencion de datos del panel y recalculo de conciliacion.
 */

const express = require('express');
const reconciliationService = require('../../services/reconciliationService');
const tabService = require('../../services/tabService');
const { sendError } = require('../../middleware/errorHandler');

const router = express.Router();

router.get('/data', async (req, res) => {
  try {
    const result = await reconciliationService.getPeriodData({
      periodo: req.query.periodo,
      entidad: req.query.entidad,
      filter: req.query.filter || 'all',
      ensureDefaultTabs: tabService.ensureDefaultTabs
    });
    return res.json(result);
  } catch (err) {
    return sendError(res, err);
  }
});

router.post('/refresh', async (req, res) => {
  try {
    const periodo = reconciliationService.readPeriodo(req.body.periodo || req.query.periodo);
    const entidad = reconciliationService.readEntidad(req.body.entidad || req.query.entidad);

    await tabService.ensureDefaultTabs(periodo);
    const { summary } = await reconciliationService.runReconciliationForPeriod(periodo, entidad);

    return res.json({
      success: true,
      message: `Conciliación del periodo ${periodo} (${entidad}) recalculada y sincronizada exitosamente.`,
      summary
    });
  } catch (err) {
    return sendError(res, err, 'Error recalculando conciliación:');
  }
});

module.exports = router;
