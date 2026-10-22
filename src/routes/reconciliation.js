const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const Invoice = require('../models/Invoice');
const BankMovement = require('../models/BankMovement');
const BankStatementFile = require('../models/BankStatementFile');
const { parseCfdiReport } = require('../services/cfdiParser');
const { parseBankStatement } = require('../services/bankParser');
const { reconcile } = require('../services/reconciler');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

/**
 * Helper para re-ejecutar conciliacion de un mes en MongoDB Atlas
 */
const runReconciliationForPeriod = async (periodo) => {
  const invoices = await Invoice.find({ periodo }).lean();
  const bankMovements = await BankMovement.find({
    $or: [{ periodo }, { tipo: 'Retiro' }]
  }).lean();

  if (invoices.length === 0) {
    return { summary: null };
  }

  const { summary, reconciledInvoices } = reconcile(invoices, bankMovements);

  const bulkOps = reconciledInvoices
    .filter((inv) => !inv.editadoManualmente)
    .map((inv) => ({
      updateOne: {
        filter: { uuid: inv.uuid },
        update: {
          $set: {
            estadoPago: inv.estadoPago,
            pagoAsociado: inv.pagoAsociado
          }
        }
      }
    }));

  if (bulkOps.length > 0) {
    await Invoice.bulkWrite(bulkOps);
  }

  return { summary };
};

// 1. Obtener lista de periodos (meses) disponibles
router.get('/periodos', async (req, res) => {
  try {
    const periodos = await Invoice.distinct('periodo');
    const sorted = periodos.sort().reverse();
    return res.json({ success: true, periodos: sorted.length ? sorted : ['2026-09'] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 2. Obtener resumen, facturas y lista de estados de cuenta subidos de un periodo
router.get('/data', async (req, res) => {
  try {
    const periodo = req.query.periodo || '2026-09';
    const filter = req.query.filter || 'all';

    const query = { periodo };
    if (filter === 'pagadas') {
      query.estadoPago = 'Pagada';
    } else if (filter === 'no_pagadas') {
      query.estadoPago = 'No Pagada';
    } else if (filter === 'egresos') {
      query.efecto = 'Egreso';
    } else if (filter === 'canceladas') {
      query.estadoPago = 'Cancelada';
    }

    const invoices = await Invoice.find(query).sort({ fechaEmision: 1 }).lean();

    const allInvoices = await Invoice.find({ periodo }).lean();
    const pagadas = allInvoices.filter((i) => i.estadoPago === 'Pagada');
    const noPagadas = allInvoices.filter((i) => i.estadoPago === 'No Pagada');
    const egresos = allInvoices.filter((i) => i.efecto === 'Egreso');
    const canceladas = allInvoices.filter((i) => i.estadoPago === 'Cancelada');

    const totalFacturas = allInvoices.length;
    const montoTotal = allInvoices.reduce((s, i) => s + (i.total || 0), 0);
    const montoPagado = pagadas.reduce((s, i) => s + (i.total || 0), 0);
    const montoNoPagado = noPagadas.reduce((s, i) => s + (i.total || 0), 0);
    const montoEgresos = egresos.reduce((s, i) => s + (i.total || 0), 0);
    const montoCancelado = canceladas.reduce((s, i) => s + (i.total || 0), 0);

    const bankMovementsCount = await BankMovement.countDocuments({ periodo, tipo: 'Retiro' });

    // Consultar lista de estados de cuenta bancarios registrados para el mes
    const bankStatements = await BankStatementFile.find({ periodo }).sort({ createdAt: -1 }).lean();

    return res.json({
      success: true,
      periodo,
      hasCfdiFile: totalFacturas > 0,
      summary: {
        totalFacturas,
        montoTotal,
        pagadasCount: pagadas.length,
        montoPagado,
        noPagadasCount: noPagadas.length,
        montoNoPagado,
        egresosCount: egresos.length,
        montoEgresos,
        canceladasCount: canceladas.length,
        montoCancelado,
        bankMovementsCount
      },
      bankStatements,
      invoices
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 3. Subir archivo PDF de Facturas Recibidas (SAT Consulta CFDI)
router.post('/upload-cfdi', upload.single('cfdiPdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Debe adjuntar el archivo PDF de facturas.' });
    }

    const targetPeriodo = req.body.periodo || '2026-09';

    // Regla: Solo un archivo de facturas por mes. Si ya existe, se bloquea.
    const existingCount = await Invoice.countDocuments({ periodo: targetPeriodo });
    if (existingCount > 0 && req.query.replace !== 'true') {
      return res.status(400).json({
        success: false,
        isBlocked: true,
        message: `Ya existe un archivo de facturas cargado para el mes ${targetPeriodo} (${existingCount} facturas). Solo se permite un archivo por mes.`
      });
    }

    const { invoices: parsedInvoices, detectedPeriod } = await parseCfdiReport(req.file.buffer);

    if (parsedInvoices.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No se encontraron registros de Folio Fiscal en el documento.'
      });
    }

    // Validacion de mes correspondiente
    if (detectedPeriod && detectedPeriod !== targetPeriodo) {
      return res.status(400).json({
        success: false,
        message: `El archivo contiene facturas correspondientes a ${detectedPeriod} y no coincide con el mes seleccionado (${targetPeriodo}). No se permite subirlo.`
      });
    }

    const invoicesToSave = parsedInvoices.map((inv) => ({
      ...inv,
      periodo: targetPeriodo
    }));

    const bulkOps = invoicesToSave.map((inv) => ({
      updateOne: {
        filter: { uuid: inv.uuid },
        update: { $set: inv },
        upsert: true
      }
    }));

    await Invoice.bulkWrite(bulkOps);

    // Reconciliar de inmediato
    await runReconciliationForPeriod(targetPeriodo);

    return res.json({
      success: true,
      message: `Se procesaron y guardaron ${invoicesToSave.length} facturas para el mes ${targetPeriodo}.`,
      count: invoicesToSave.length,
      periodo: targetPeriodo
    });
  } catch (err) {
    console.error('Error procesando reporte CFDI:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Eliminar archivo de facturas de un mes si se desea reemplazar
router.delete('/cfdi', async (req, res) => {
  try {
    const periodo = req.query.periodo || '2026-09';
    const deleted = await Invoice.deleteMany({ periodo });
    return res.json({
      success: true,
      message: `Se eliminaron ${deleted.deletedCount} facturas del mes ${periodo}. Ahora puede subir un nuevo archivo.`
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 4. Subir N archivos de Estado de Cuenta Bancario
router.post('/upload-bank', upload.array('bankPdfs', 20), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, message: 'Debe adjuntar al menos un estado de cuenta.' });
    }

    const targetPeriodo = req.body.periodo || '2026-09';
    let totalMovements = 0;
    const uploadedResults = [];

    // Validar primero todos los archivos
    for (const file of req.files) {
      const { movements, detectedPeriods } = await parseBankStatement(
        file.buffer,
        targetPeriodo.split('-')[0] || '2026'
      );

      if (!detectedPeriods.includes(targetPeriodo)) {
        return res.status(400).json({
          success: false,
          message: `El archivo "${file.originalname}" corresponde a [${detectedPeriods.join(', ')}] y no contiene movimientos del mes seleccionado (${targetPeriodo}). Operacion cancelada.`
        });
      }

      uploadedResults.push({ file, movements });
    }

    // Si todos pasaron la validacion de mes, guardar movimientos y registrar archivo
    for (const item of uploadedResults) {
      const { file, movements } = item;

      const bulkOps = movements.map((mv) => ({
        updateOne: {
          filter: {
            banco: mv.banco,
            fecha: mv.fecha,
            monto: mv.monto,
            saldo: mv.saldo,
            concepto: mv.concepto
          },
          update: {
            $set: {
              ...mv,
              archivoOrigen: file.originalname
            }
          },
          upsert: true
        }
      }));

      if (bulkOps.length > 0) {
        await BankMovement.bulkWrite(bulkOps);
        totalMovements += bulkOps.length;
      }

      const retiros = movements.filter((m) => m.tipo === 'Retiro');
      const depositos = movements.filter((m) => m.tipo === 'Deposito');
      const totalCargos = retiros.reduce((s, m) => s + (m.monto || 0), 0);
      const totalAbonos = depositos.reduce((s, m) => s + (m.monto || 0), 0);
      const bancoDetectado = movements[0]?.banco || 'Banco';
      const cuentaDetectada = movements[0]?.cuenta || '';

      await BankStatementFile.findOneAndUpdate(
        { periodo: targetPeriodo, nombreArchivo: file.originalname },
        {
          $set: {
            periodo: targetPeriodo,
            nombreArchivo: file.originalname,
            banco: bancoDetectado,
            cuenta: cuentaDetectada,
            totalMovimientos: movements.length,
            cargosCount: retiros.length,
            abonosCount: depositos.length,
            montoCargos: totalCargos,
            montoAbonos: totalAbonos,
            fechaSubida: new Date()
          }
        },
        { upsert: true, new: true }
      );
    }

    const { summary } = await runReconciliationForPeriod(targetPeriodo);
    const bankStatements = await BankStatementFile.find({ periodo: targetPeriodo })
      .sort({ createdAt: -1 })
      .lean();

    return res.json({
      success: true,
      message: `Se procesaron exitosamente ${req.files.length} estado(s) de cuenta con ${totalMovements} movimientos bancarios. Conciliacion actualizada.`,
      totalMovements,
      bankStatements,
      summary
    });
  } catch (err) {
    console.error('Error procesando estados de cuenta:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 5. Eliminar un estado de cuenta especifico y recalcular conciliacion
router.delete('/bank-statement/:id', async (req, res) => {
  try {
    const fileDoc = await BankStatementFile.findById(req.params.id);
    if (!fileDoc) {
      return res.status(404).json({ success: false, message: 'Estado de cuenta no encontrado.' });
    }

    const { periodo, nombreArchivo } = fileDoc;

    await BankStatementFile.deleteOne({ _id: fileDoc._id });
    const deletedMvs = await BankMovement.deleteMany({ archivoOrigen: nombreArchivo });

    const { summary } = await runReconciliationForPeriod(periodo);
    const bankStatements = await BankStatementFile.find({ periodo }).sort({ createdAt: -1 }).lean();

    return res.json({
      success: true,
      message: `Se elimino el archivo "${nombreArchivo}" y sus ${deletedMvs.deletedCount} movimientos asociados. Conciliacion recalculada.`,
      bankStatements,
      summary
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 6. Consultar unicamente los estados de cuenta subidos de un mes
router.get('/bank-statements', async (req, res) => {
  try {
    const periodo = req.query.periodo || '2026-09';
    const bankStatements = await BankStatementFile.find({ periodo }).sort({ createdAt: -1 }).lean();
    return res.json({ success: true, bankStatements });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 7. Cargar directamente los archivos locales de Septiembre 2026 desde Downloads
router.post('/process-local-september', async (req, res) => {
  try {
    const cfdiPath = '/Users/angel_dzul/Downloads/FACTURAS RECIBIDAS SEPTIEMBRE.pdf';
    const bankCandidates = [
      '/Users/angel_dzul/Downloads/ESTADO DE CUENTA 4912 AGOSTO.pdf',
      '/Users/angel_dzul/Downloads/ESTADO DE CUENTA 9260 SEPTIEMBRE.pdf'
    ];

    if (!fs.existsSync(cfdiPath)) {
      return res.status(404).json({ success: false, message: `No se encontro el archivo: ${cfdiPath}` });
    }

    const periodo = '2026-09';

    const cfdiBuf = fs.readFileSync(cfdiPath);
    const { invoices: parsedInvoices } = await parseCfdiReport(cfdiBuf);

    const invoicesToSave = parsedInvoices.map((inv) => ({
      ...inv,
      periodo
    }));

    const invoiceOps = invoicesToSave.map((inv) => ({
      updateOne: {
        filter: { uuid: inv.uuid },
        update: { $set: inv },
        upsert: true
      }
    }));
    await Invoice.bulkWrite(invoiceOps);

    let bankCount = 0;
    for (const bankPath of bankCandidates) {
      if (fs.existsSync(bankPath)) {
        const bankBuf = fs.readFileSync(bankPath);
        const { movements } = await parseBankStatement(bankBuf, '2026');
        const filename = path.basename(bankPath);

        const bankOps = movements.map((mv) => ({
          updateOne: {
            filter: {
              banco: mv.banco,
              fecha: mv.fecha,
              monto: mv.monto,
              saldo: mv.saldo,
              concepto: mv.concepto
            },
            update: {
              $set: {
                ...mv,
                archivoOrigen: filename
              }
            },
            upsert: true
          }
        }));
        if (bankOps.length > 0) {
          await BankMovement.bulkWrite(bankOps);
          bankCount += bankOps.length;
        }

        const retiros = movements.filter((m) => m.tipo === 'Retiro');
        const depositos = movements.filter((m) => m.tipo === 'Deposito');
        const totalCargos = retiros.reduce((s, m) => s + (m.monto || 0), 0);
        const totalAbonos = depositos.reduce((s, m) => s + (m.monto || 0), 0);
        const bancoDetectado = movements[0]?.banco || 'Banco';
        const cuentaDetectada = movements[0]?.cuenta || '';

        await BankStatementFile.findOneAndUpdate(
          { periodo, nombreArchivo: filename },
          {
            $set: {
              periodo,
              nombreArchivo: filename,
              banco: bancoDetectado,
              cuenta: cuentaDetectada,
              totalMovimientos: movements.length,
              cargosCount: retiros.length,
              abonosCount: depositos.length,
              montoCargos: totalCargos,
              montoAbonos: totalAbonos,
              fechaSubida: new Date()
            }
          },
          { upsert: true, new: true }
        );
      }
    }

    const { summary } = await runReconciliationForPeriod(periodo);
    const bankStatements = await BankStatementFile.find({ periodo }).sort({ createdAt: -1 }).lean();

    return res.json({
      success: true,
      message: `Procesamiento completado para ${periodo}. ${invoicesToSave.length} facturas y ${bankCount} movimientos bancarios procesados.`,
      periodo,
      invoicesCount: invoicesToSave.length,
      bankCount,
      bankStatements,
      summary
    });
  } catch (err) {
    console.error('Error procesando archivos locales:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 8. Actualizar manualmente estado de pago y observaciones de una factura
router.patch('/invoice/:uuid', async (req, res) => {
  try {
    const { uuid } = req.params;
    const { estadoPago, observaciones, resetAuto } = req.body;

    const invoice = await Invoice.findOne({ uuid });
    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Factura no encontrada.' });
    }

    if (resetAuto) {
      // Revertir a calculo automatico
      invoice.editadoManualmente = false;
      if (observaciones !== undefined) {
        invoice.observaciones = observaciones;
      }
      await invoice.save();

      // Recalcular conciliacion para este periodo
      await runReconciliationForPeriod(invoice.periodo);
      const updated = await Invoice.findOne({ uuid }).lean();

      return res.json({
        success: true,
        message: 'Factura restablecida al calculo automatico.',
        invoice: updated
      });
    }

    // Actualizacion manual
    if (estadoPago) {
      invoice.estadoPago = estadoPago;
      invoice.editadoManualmente = true;
      invoice.fechaEdicionManual = new Date();
    }
    if (observaciones !== undefined) {
      invoice.observaciones = observaciones;
    }

    await invoice.save();

    return res.json({
      success: true,
      message: 'Factura actualizada exitosamente.',
      invoice
    });
  } catch (err) {
    console.error('Error actualizando factura:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 9. Exportar reporte en CSV
router.get('/export-csv', async (req, res) => {
  try {
    const periodo = req.query.periodo || '2026-09';
    const invoices = await Invoice.find({ periodo }).sort({ fechaEmision: 1 }).lean();

    const headers = [
      'No.',
      'Folio Fiscal (UUID)',
      'RFC Emisor',
      'Proveedor / Emisor',
      'Fecha Emision',
      'Total Factura',
      'Estado SAT',
      'Efecto',
      'Estado de Pago',
      'Modificacion Manual',
      'Fecha Pago Banco',
      'Monto Pagado',
      'Concepto Banco',
      'Observaciones'
    ];

    const rows = invoices.map((inv, idx) => [
      idx + 1,
      `"${inv.uuid}"`,
      `"${inv.rfcEmisor}"`,
      `"${(inv.emisor || '').replace(/"/g, '""')}"`,
      `"${inv.fechaEmision}"`,
      (inv.total || 0).toFixed(2),
      `"${inv.estadoSat}"`,
      `"${inv.efecto}"`,
      `"${inv.estadoPago}"`,
      `"${inv.editadoManualmente ? 'Si' : 'No'}"`,
      `"${inv.pagoAsociado?.fechaPago || ''}"`,
      inv.pagoAsociado?.montoRetiro ? inv.pagoAsociado.montoRetiro.toFixed(2) : '',
      `"${(inv.pagoAsociado?.conceptoBanco || '').replace(/"/g, '""')}"`,
      `"${(inv.observaciones || '').replace(/"/g, '""')}"`
    ]);

    const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="Conciliacion_Facturas_${periodo}.csv"`);
    return res.send('\uFEFF' + csvContent);
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
