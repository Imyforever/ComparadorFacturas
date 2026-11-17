/**
 * Rutas de vinculacion/desvinculacion manual de movimientos bancarios y edicion de notas de movimientos.
 */

const express = require('express');
const manualLinkService = require('../../services/manualLinkService');
const { sendError } = require('../../middleware/errorHandler');

const router = express.Router();

router.post('/link-manual', async (req, res) => {
  try {
    const { invoice, movement } = await manualLinkService.linkManual({
      movimientoId: req.body.movimientoId,
      invoiceUuid: req.body.invoiceUuid,
      observaciones: req.body.observaciones
    });

    return res.json({
      success: true,
      message: `Pago bancario de $${(movement.monto || 0).toFixed(2)} vinculado exitosamente con la factura ${invoice.uuid.substring(0, 8)}... (${invoice.emisor}). Marcada como Pagada (Manual).`,
      invoice,
      movement
    });
  } catch (err) {
    return sendError(res, err);
  }
});

router.post('/unlink-manual', async (req, res) => {
  try {
    await manualLinkService.unlinkManual({
      movimientoId: req.body.movimientoId,
      invoiceUuid: req.body.invoiceUuid
    });
    return res.json({
      success: true,
      message: 'Vinculacion manual removida exitosamente.'
    });
  } catch (err) {
    return sendError(res, err);
  }
});

router.patch('/bank-movement/:id', async (req, res) => {
  try {
    await manualLinkService.updateBankMovement(req.params.id, {
      observaciones: req.body.observaciones,
      categoria: req.body.categoria
    });
    return res.json({
      success: true,
      message: 'Movimiento bancario actualizado exitosamente.'
    });
  } catch (err) {
    return sendError(res, err);
  }
});

module.exports = router;
