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
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten archivos en formato PDF.'), false);
    }
  }
});

// Respaldo en memoria si aún no se conecta MongoDB Atlas
let memoryInvoices = [
  {
    _id: 'inv_demo_1',
    folio: 'FAC-2026-001',
    emisor: 'Servicios de Consultoría Integral SA',
    rfcEmisor: 'SCI980112XX1',
    total: 14500.0,
    fecha: '2026-10-20',
    estado: 'Conciliada',
    pdfUrl: '#',
    storage: 'local'
  },
  {
    _id: 'inv_demo_2',
    folio: 'FAC-2026-002',
    emisor: 'Papelería Corporativa Nacional',
    rfcEmisor: 'PCN050414AB2',
    total: 3820.5,
    fecha: '2026-10-21',
    estado: 'Conciliada',
    pdfUrl: '#',
    storage: 'local'
  }
];

// 1. Obtener todas las facturas
router.get('/', async (req, res) => {
  try {
    if (mongoose.connection.readyState === 1) {
      const invoices = await Invoice.find().sort({ createdAt: -1 });
      return res.json({ success: true, count: invoices.length, data: invoices });
    }
    return res.json({ success: true, count: memoryInvoices.length, data: memoryInvoices });
  } catch (err) {
    console.error('Error al listar facturas:', err);
    return res.status(500).json({ success: false, message: 'Error interno al obtener facturas.' });
  }
});

// 2. Subir PDF y registrar factura (Cloudflare R2 + MongoDB)
router.post('/upload', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Debe adjuntar un archivo PDF.' });
    }

    // 1. Subir a Cloudflare R2 (o almacenamiento local de respaldo)
    const uploadResult = await uploadPdf(req.file);

    // 2. Extraer o generar datos de la factura
    const folio = req.body.folio || `FAC-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
    const emisor = req.body.emisor || 'Proveedor Comercial SA de CV';
    const rfcEmisor = req.body.rfcEmisor || 'PRO010101XYZ';
    const total = parseFloat(req.body.total) || Math.floor(1500 + Math.random() * 25000);
    const fecha = req.body.fecha || new Date().toISOString().split('T')[0];

    // 3. Guardar en MongoDB Atlas
    if (mongoose.connection.readyState === 1) {
      const newInvoice = new Invoice({
        folio,
        emisor,
        rfcEmisor,
        total,
        fecha,
        estado: 'Conciliada',
        pdfUrl: uploadResult.url,
        pdfKey: uploadResult.key,
        storage: uploadResult.storage
      });

      const saved = await newInvoice.save();
      return res.status(201).json({
        success: true,
        message: `Factura ${folio} procesada y guardada exitosamente en ${uploadResult.storage.toUpperCase()}.`,
        invoice: saved
      });
    }

    // Fallback en memoria si MongoDB aún no tiene conexión
    const memItem = {
      _id: `inv_${Date.now()}`,
      folio,
      emisor,
      rfcEmisor,
      total,
      fecha,
      estado: 'Conciliada',
      pdfUrl: uploadResult.url,
      storage: uploadResult.storage
    };
    memoryInvoices.unshift(memItem);

    return res.status(201).json({
      success: true,
      message: `Factura procesada y guardada en memoria local (${uploadResult.storage}).`,
      invoice: memItem
    });
  } catch (err) {
    console.error('Error al subir factura:', err);
    return res.status(500).json({
      success: false,
      message: err.message || 'Error al procesar el archivo PDF.'
    });
  }
});

module.exports = router;
