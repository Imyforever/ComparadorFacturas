const express = require('express');
const multer = require('multer');
const mongoose = require('mongoose');
const { uploadPdf } = require('../config/r2');
const Invoice = require('../models/Invoice');

const router = express.Router();

// Configuración de Multer en memoria para procesar el archivo antes de enviarlo a R2
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB límite
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

// Respaldo en memoria si aún no se conecta MongoDB Atlas
const memoryInvoices = [];

const isDbConnected = () => mongoose.connection.readyState === 1;

// 1. Obtener todas las facturas
router.get('/', async (req, res) => {
  try {
    if (isDbConnected()) {
      const invoices = await Invoice.find().sort({ createdAt: -1 }).lean();
      return res.json({ success: true, count: invoices.length, data: invoices });
    }
    return res.json({ success: true, count: memoryInvoices.length, data: memoryInvoices });
  } catch (err) {
    console.error('Error al listar facturas:', err);
    return res.status(500).json({ success: false, message: 'Error interno al obtener facturas.' });
  }
});

// 2. Subir PDF y registrar factura (Cloudflare R2 + MongoDB)
// Antes se inventaban folio, RFC y total aleatorios cuando no se enviaban y el documento no cumplia
// el esquema de Invoice (por lo que fallaba al guardar). Ahora se exigen los datos reales.
router.post('/upload', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Debe adjuntar un archivo PDF.' });
    }

    const uuid = String(req.body.uuid || req.body.folio || '').trim().toUpperCase();
    const emisor = String(req.body.emisor || '').trim();
    const rfcEmisor = String(req.body.rfcEmisor || '').trim().toUpperCase();
    const total = Number(req.body.total);
    const fechaEmision = String(req.body.fechaEmision || req.body.fecha || '').trim();

    const missing = [];
    if (!uuid) missing.push('uuid');
    if (!emisor) missing.push('emisor');
    if (!rfcEmisor) missing.push('rfcEmisor');
    if (!Number.isFinite(total)) missing.push('total');
    if (!/^\d{4}-\d{2}-\d{2}/.test(fechaEmision)) missing.push('fechaEmision (AAAA-MM-DD)');
    if (missing.length > 0) {
      return res.status(400).json({ success: false, message: `Faltan o son invalidos los campos: ${missing.join(', ')}.` });
    }

    // 1. Subir a Cloudflare R2 (o almacenamiento local de respaldo)
    const uploadResult = await uploadPdf(req.file);

    const data = {
      uuid,
      periodo: req.body.periodo || fechaEmision.substring(0, 7),
      entidad: req.body.entidad || 'Personal',
      emisor,
      rfcEmisor,
      total,
      fechaEmision,
      observaciones: `PDF: ${uploadResult.url}`
    };

    // 2. Guardar en MongoDB Atlas
    if (isDbConnected()) {
      const existing = await Invoice.findOne({ uuid }).lean();
      if (existing) {
        return res.status(409).json({ success: false, message: `Ya existe una factura con el UUID ${uuid}.` });
      }
      const saved = await Invoice.create(data);
      return res.status(201).json({
        success: true,
        message: `Factura ${uuid} procesada y guardada exitosamente en ${uploadResult.storage.toUpperCase()}.`,
        invoice: saved
      });
    }

    // Fallback en memoria si MongoDB aún no tiene conexión
    const memItem = { _id: `inv_${Date.now()}`, ...data, pdfUrl: uploadResult.url, storage: uploadResult.storage };
    memoryInvoices.unshift(memItem);

    return res.status(201).json({
      success: true,
      message: `Factura procesada y guardada en memoria local (${uploadResult.storage}).`,
      invoice: memItem
    });
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
