/**
 * Rutas de listado y subida individual de facturas (/api/invoices).
 */

const express = require('express');
const multer = require('multer');
const invoiceService = require('../services/invoiceService');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  defParamCharset: 'utf8',
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) {
      cb(null, true);
    } else {
      const err = new Error('Solo se permiten archivos en formato PDF.');
      err.status = 400;
      cb(err, false);
    }
  }
});

router.get('/', async (req, res) => {
  try {
    const result = await invoiceService.listInvoices();
    return res.json(result);
  } catch (err) {
    console.error('Error al listar facturas:', err);
    return res.status(500).json({ success: false, message: 'Error interno al obtener facturas.' });
  }
});

router.post('/upload', upload.single('pdf'), async (req, res) => {
  try {
    const { status, body } = await invoiceService.uploadInvoicePdf({
      file: req.file,
      body: req.body
    });
    return res.status(status).json(body);
  } catch (err) {
    console.error('Error al subir factura:', err);
    const status = err.name === 'ValidationError' ? 400 : err.status || 500;
    return res.status(status).json({
      success: false,
      message: err.message || 'Error al procesar el archivo PDF.'
    });
  }
});

module.exports = router;
