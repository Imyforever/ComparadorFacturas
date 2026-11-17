/**
 * Ruta de exportacion de reporte de conciliacion en CSV.
 */

const express = require('express');
const exportService = require('../../services/exportService');
const { sendError } = require('../../middleware/errorHandler');

const router = express.Router();

router.get('/export-csv', async (req, res) => {
  try {
    const { fileName, asciiName, csvContent } = await exportService.exportPeriodCsv({
      periodo: req.query.periodo,
      entidad: req.query.entidad
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
    );
    return res.send(csvContent);
  } catch (err) {
    return sendError(res, err);
  }
});

module.exports = router;
