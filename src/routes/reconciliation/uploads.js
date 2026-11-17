/**
 * Rutas de subida y eliminacion de archivos CFDI del SAT y estados de cuenta bancarios.
 */

const express = require('express');
const multer = require('multer');
const uploadService = require('../../services/uploadService');
const { sendError } = require('../../middleware/errorHandler');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  defParamCharset: 'utf8'
});

router.post('/upload-cfdi', upload.single('cfdiPdf'), async (req, res) => {
  try {
    const result = await uploadService.uploadCfdi({
      file: req.file,
      periodo: req.body.periodo,
      entidad: req.body.entidad,
      replace: req.query.replace === 'true'
    });
    return res.json(result);
  } catch (err) {
    return sendError(res, err, 'Error procesando reporte CFDI:');
  }
});

router.delete('/cfdi', async (req, res) => {
  try {
    const result = await uploadService.deleteCfdi({
      periodo: req.query.periodo,
      entidad: req.query.entidad
    });
    return res.json(result);
  } catch (err) {
    return sendError(res, err);
  }
});

router.post('/upload-bank', upload.array('bankPdfs', 20), async (req, res) => {
  try {
    const result = await uploadService.uploadBankStatements({
      files: req.files,
      periodo: req.body.periodo,
      entidad: req.body.entidad
    });
    return res.json(result);
  } catch (err) {
    return sendError(res, err, 'Error procesando estados de cuenta:');
  }
});

router.delete('/bank-statement/:id', async (req, res) => {
  try {
    const result = await uploadService.deleteBankStatement(req.params.id);
    return res.json(result);
  } catch (err) {
    return sendError(res, err);
  }
});

router.get('/bank-statements', async (req, res) => {
  try {
    const result = await uploadService.listBankStatements({
      periodo: req.query.periodo,
      entidad: req.query.entidad
    });
    return res.json(result);
  } catch (err) {
    return sendError(res, err);
  }
});

module.exports = router;
