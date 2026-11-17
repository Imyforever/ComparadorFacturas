/**
 * Rutas de periodos y administracion de pestanias/cuentas por mes.
 */

const express = require('express');
const tabService = require('../../services/tabService');
const { sendError } = require('../../middleware/errorHandler');

const router = express.Router();

router.get('/periodos', async (req, res) => {
  try {
    const periodos = await tabService.listPeriodos();
    return res.json({ success: true, periodos });
  } catch (err) {
    return sendError(res, err);
  }
});

router.get('/tabs', async (req, res) => {
  try {
    const tabs = await tabService.listTabs(req.query.periodo);
    return res.json({ success: true, tabs });
  } catch (err) {
    return sendError(res, err);
  }
});

router.post('/tabs', async (req, res) => {
  try {
    const { cleanName, tab } = await tabService.createTab({
      periodo: req.body.periodo,
      nombre: req.body.nombre
    });
    return res.json({
      success: true,
      message: `Pestania "${cleanName}" creada exitosamente.`,
      tab
    });
  } catch (err) {
    return sendError(res, err);
  }
});

router.patch('/tabs/rename', async (req, res) => {
  try {
    const { unchanged, cleanNew } = await tabService.renameTab({
      periodo: req.body.periodo,
      oldNombre: req.body.oldNombre,
      newNombre: req.body.newNombre
    });
    if (unchanged) {
      return res.json({ success: true, message: 'El nombre es identico.' });
    }
    return res.json({
      success: true,
      message: `Pestania renombrada a "${cleanNew}". Registros actualizados.`
    });
  } catch (err) {
    return sendError(res, err);
  }
});

router.delete('/tabs', async (req, res) => {
  try {
    const { nombre } = req.query;
    const { deletedInvoicesCount, deletedBankCount } = await tabService.deleteTab({
      periodo: req.query.periodo,
      nombre
    });
    return res.json({
      success: true,
      message: `Pestania "${nombre}" eliminada (${deletedInvoicesCount} facturas y ${deletedBankCount} movimientos eliminados).`
    });
  } catch (err) {
    return sendError(res, err);
  }
});

module.exports = router;
