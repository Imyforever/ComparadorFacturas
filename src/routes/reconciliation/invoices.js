/**
 * Rutas de captura manual y edicion de facturas dentro del modulo de conciliacion.
 */

const express = require('express');
const manualLinkService = require('../../services/manualLinkService');
const { sendError } = require('../../middleware/errorHandler');

const router = express.Router();

router.post('/manual-invoice', async (req, res) => {
  try {
    const { cleanUuid } = await manualLinkService.createManualInvoice(req.body || {});
    return res.json({
      success: true,
      message: `Factura ${cleanUuid.substring(0, 8)}... registrada y conciliada exitosamente.`
    });
  } catch (err) {
    return sendError(res, err);
  }
});

router.patch('/invoice/:uuid', async (req, res) => {
  try {
    const { resetAuto, invoice } = await manualLinkService.updateInvoice(req.params.uuid, req.body || {});
    if (resetAuto) {
      return res.json({
        success: true,
        message: 'Factura restablecida al calculo automatico.',
        invoice
      });
    }
    return res.json({
      success: true,
      message: 'Factura actualizada exitosamente.',
      invoice
    });
  } catch (err) {
    return sendError(res, err, 'Error actualizando factura:');
  }
});

router.post('/bulk-manual-paid', async (req, res) => {
  try {
    const { actualizadas } = await manualLinkService.bulkMarkPaidManual({
      uuids: req.body?.uuids,
      nota: req.body?.nota
    });
    return res.json({
      success: true,
      message: `${actualizadas} factura(s) marcada(s) como pagadas en efectivo.`,
      actualizadas
    });
  } catch (err) {
    return sendError(res, err, 'Error marcando facturas como pagadas:');
  }
});

module.exports = router;
