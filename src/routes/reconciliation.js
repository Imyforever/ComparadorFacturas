const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const Invoice = require('../models/Invoice');
const BankMovement = require('../models/BankMovement');
const BankStatementFile = require('../models/BankStatementFile');
const AccountTab = require('../models/AccountTab');
const { parseCfdiReport } = require('../services/cfdiParser');
const { parseBankStatement } = require('../services/bankParser');
const { reconcile } = require('../services/reconciler');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

/**
 * Helper para asegurar que existan las pestanias por defecto y migrar registros anteriores
 */
const ensureDefaultTabs = async (periodo) => {
  // 1. Asignar 'Personal' a cualquier documento previo que no tenga entidad
  await Invoice.updateMany({ entidad: { $exists: false } }, { $set: { entidad: 'Personal' } });
  await BankMovement.updateMany({ entidad: { $exists: false } }, { $set: { entidad: 'Personal' } });
  await BankStatementFile.updateMany({ entidad: { $exists: false } }, { $set: { entidad: 'Personal' } });

  // 2. Garantizar que la pestania 'Personal' exista en AccountTab para este mes
  const personalTab = await AccountTab.findOne({ periodo, nombre: 'Personal' });
  if (!personalTab) {
    await AccountTab.create({ periodo, nombre: 'Personal' });
  }

  // 3. Registrar cualquier entidad existente en facturas que aun no este en AccountTab
  const distinctEntities = await Invoice.distinct('entidad', { periodo });
  for (const ent of distinctEntities) {
    if (ent && typeof ent === 'string') {
      await AccountTab.findOneAndUpdate(
        { periodo, nombre: ent },
        { $setOnInsert: { periodo, nombre: ent } },
        { upsert: true }
      );
    }
  }
};

/**
 * Helper para re-ejecutar conciliacion de un mes y entidad en MongoDB Atlas
 */
const runReconciliationForPeriod = async (periodo, entidad = 'Personal') => {
  const invoices = await Invoice.find({ periodo, entidad }).lean();
  const bankMovements = await BankMovement.find({
    entidad,
    tipo: 'Retiro'
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

// 2. Rutas de Administracion de Pestanias / Cuentas por Mes (Personal, Empresa, etc.)
router.get('/tabs', async (req, res) => {
  try {
    const periodo = req.query.periodo || '2026-09';
    await ensureDefaultTabs(periodo);

    const tabs = await AccountTab.find({ periodo }).sort({ createdAt: 1 }).lean();

    // Contar comprobantes y estados de cuenta por pestania
    const tabsWithCounts = await Promise.all(
      tabs.map(async (t) => {
        const facturasCount = await Invoice.countDocuments({ periodo, entidad: t.nombre });
        const bankFilesCount = await BankStatementFile.countDocuments({ periodo, entidad: t.nombre });
        return {
          ...t,
          facturasCount,
          bankFilesCount
        };
      })
    );

    return res.json({ success: true, tabs: tabsWithCounts });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/tabs', async (req, res) => {
  try {
    const { periodo, nombre } = req.body;
    if (!periodo || !nombre || !nombre.trim()) {
      return res.status(400).json({ success: false, message: 'El nombre de la pestania es obligatorio.' });
    }

    const cleanName = nombre.trim();
    if (cleanName.length > 40) {
      return res.status(400).json({ success: false, message: 'El nombre no puede exceder 40 caracteres.' });
    }

    const existing = await AccountTab.findOne({ periodo, nombre: cleanName });
    if (existing) {
      return res.status(400).json({ success: false, message: `Ya existe una pestania llamada "${cleanName}" en este mes.` });
    }

    const tab = await AccountTab.create({ periodo, nombre: cleanName });
    return res.json({ success: true, message: `Pestania "${cleanName}" creada exitosamente.`, tab });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.patch('/tabs/rename', async (req, res) => {
  try {
    const { periodo, oldNombre, newNombre } = req.body;
    if (!periodo || !oldNombre || !newNombre || !newNombre.trim()) {
      return res.status(400).json({ success: false, message: 'Datos incompletos para renombrar la pestania.' });
    }

    const cleanNew = newNombre.trim();
    if (oldNombre === cleanNew) {
      return res.json({ success: true, message: 'El nombre es identico.' });
    }

    const tab = await AccountTab.findOne({ periodo, nombre: oldNombre });
    if (!tab) {
      return res.status(404).json({ success: false, message: 'Pestania no encontrada.' });
    }

    const collision = await AccountTab.findOne({ periodo, nombre: cleanNew });
    if (collision) {
      return res.status(400).json({ success: false, message: `Ya existe una pestania llamada "${cleanNew}".` });
    }

    tab.nombre = cleanNew;
    await tab.save();

    // Actualizar todas las facturas y estados de cuenta asociados a este nombre
    await Invoice.updateMany({ periodo, entidad: oldNombre }, { $set: { entidad: cleanNew } });
    await BankMovement.updateMany({ periodo, entidad: oldNombre }, { $set: { entidad: cleanNew } });
    await BankStatementFile.updateMany({ periodo, entidad: oldNombre }, { $set: { entidad: cleanNew } });

    await runReconciliationForPeriod(periodo, cleanNew);

    return res.json({
      success: true,
      message: `Pestania renombrada a "${cleanNew}". Registros actualizados.`
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/tabs', async (req, res) => {
  try {
    const { periodo, nombre } = req.query;
    if (!periodo || !nombre) {
      return res.status(400).json({ success: false, message: 'Datos insuficientes.' });
    }

    const totalTabs = await AccountTab.countDocuments({ periodo });
    if (totalTabs <= 1) {
      return res.status(400).json({ success: false, message: 'No se puede eliminar la unica pestania activa del mes.' });
    }

    await AccountTab.deleteOne({ periodo, nombre });
    const deletedInvoices = await Invoice.deleteMany({ periodo, entidad: nombre });
    const deletedBank = await BankMovement.deleteMany({ periodo, entidad: nombre });
    await BankStatementFile.deleteMany({ periodo, entidad: nombre });

    return res.json({
      success: true,
      message: `Pestania "${nombre}" eliminada (${deletedInvoices.deletedCount} facturas y ${deletedBank.deletedCount} movimientos eliminados).`
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 3. Obtener resumen, facturas y lista de estados de cuenta subidos de un periodo y entidad
router.get('/data', async (req, res) => {
  try {
    const periodo = req.query.periodo || '2026-09';
    const entidad = req.query.entidad || 'Personal';
    const filter = req.query.filter || 'all';

    await ensureDefaultTabs(periodo);

    const query = { periodo, entidad };
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

    const allInvoices = await Invoice.find({ periodo, entidad }).lean();
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

    const bankMovementsCount = await BankMovement.countDocuments({ periodo, entidad, tipo: 'Retiro' });

    // Consultar lista de estados de cuenta bancarios registrados para el mes y la entidad
    const bankStatements = await BankStatementFile.find({ periodo, entidad }).sort({ createdAt: -1 }).lean();

    return res.json({
      success: true,
      periodo,
      entidad,
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

// 4. Subir archivo PDF de Facturas Recibidas (SAT Consulta CFDI)
router.post('/upload-cfdi', upload.single('cfdiPdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Debe adjuntar el archivo PDF de facturas.' });
    }

    const targetPeriodo = req.body.periodo || '2026-09';
    const entidad = req.body.entidad || 'Personal';

    // Regla: Solo un archivo de facturas por mes y pestania. Si ya existe, se bloquea.
    const existingCount = await Invoice.countDocuments({ periodo: targetPeriodo, entidad });
    if (existingCount > 0 && req.query.replace !== 'true') {
      return res.status(400).json({
        success: false,
        isBlocked: true,
        message: `Ya existe un archivo de facturas cargado para "${entidad}" en el mes ${targetPeriodo} (${existingCount} facturas). Solo se permite un archivo por pestania.`
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
      periodo: targetPeriodo,
      entidad
    }));

    const bulkOps = invoicesToSave.map((inv) => ({
      updateOne: {
        filter: { uuid: inv.uuid },
        update: { $set: inv },
        upsert: true
      }
    }));

    await Invoice.bulkWrite(bulkOps);

    // Reconciliar de inmediato para esta entidad y periodo
    await runReconciliationForPeriod(targetPeriodo, entidad);

    return res.json({
      success: true,
      message: `Se procesaron y guardaron ${invoicesToSave.length} facturas para "${entidad}" en el mes ${targetPeriodo}.`,
      count: invoicesToSave.length,
      periodo: targetPeriodo,
      entidad
    });
  } catch (err) {
    console.error('Error procesando reporte CFDI:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 5. Eliminar archivo de facturas de un mes y entidad si se desea reemplazar
router.delete('/cfdi', async (req, res) => {
  try {
    const periodo = req.query.periodo || '2026-09';
    const entidad = req.query.entidad || 'Personal';
    const deleted = await Invoice.deleteMany({ periodo, entidad });
    return res.json({
      success: true,
      message: `Se eliminaron ${deleted.deletedCount} facturas de "${entidad}" del mes ${periodo}. Ahora puede subir un nuevo archivo.`
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 6. Subir N archivos de Estado de Cuenta Bancario
router.post('/upload-bank', upload.array('bankPdfs', 20), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, message: 'Debe adjuntar al menos un estado de cuenta.' });
    }

    const targetPeriodo = req.body.periodo || '2026-09';
    const entidad = req.body.entidad || 'Personal';
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
            entidad,
            banco: mv.banco,
            fecha: mv.fecha,
            monto: mv.monto,
            saldo: mv.saldo,
            concepto: mv.concepto
          },
          update: {
            $set: {
              ...mv,
              entidad,
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
        { periodo: targetPeriodo, entidad, nombreArchivo: file.originalname },
        {
          $set: {
            periodo: targetPeriodo,
            entidad,
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

    const { summary } = await runReconciliationForPeriod(targetPeriodo, entidad);
    const bankStatements = await BankStatementFile.find({ periodo: targetPeriodo, entidad })
      .sort({ createdAt: -1 })
      .lean();

    return res.json({
      success: true,
      message: `Se procesaron exitosamente ${req.files.length} estado(s) de cuenta para "${entidad}" con ${totalMovements} movimientos bancarios. Conciliacion actualizada.`,
      totalMovements,
      entidad,
      bankStatements,
      summary
    });
  } catch (err) {
    console.error('Error procesando estados de cuenta:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 7. Eliminar un estado de cuenta especifico y recalcular conciliacion
router.delete('/bank-statement/:id', async (req, res) => {
  try {
    const fileDoc = await BankStatementFile.findById(req.params.id);
    if (!fileDoc) {
      return res.status(404).json({ success: false, message: 'Estado de cuenta no encontrado.' });
    }

    const { periodo, entidad, nombreArchivo } = fileDoc;
    const targetEntidad = entidad || 'Personal';

    await BankStatementFile.deleteOne({ _id: fileDoc._id });
    const deletedMvs = await BankMovement.deleteMany({ archivoOrigen: nombreArchivo, entidad: targetEntidad });

    const { summary } = await runReconciliationForPeriod(periodo, targetEntidad);
    const bankStatements = await BankStatementFile.find({ periodo, entidad: targetEntidad }).sort({ createdAt: -1 }).lean();

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

// 8. Consultar unicamente los estados de cuenta subidos de un mes y entidad
router.get('/bank-statements', async (req, res) => {
  try {
    const periodo = req.query.periodo || '2026-09';
    const entidad = req.query.entidad || 'Personal';
    const bankStatements = await BankStatementFile.find({ periodo, entidad }).sort({ createdAt: -1 }).lean();
    return res.json({ success: true, bankStatements });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 9. Actualizar manualmente estado de pago y observaciones de una factura
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

      // Recalcular conciliacion para este periodo y entidad
      await runReconciliationForPeriod(invoice.periodo, invoice.entidad || 'Personal');
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

// 10. Exportar reporte en CSV
router.get('/export-csv', async (req, res) => {
  try {
    const periodo = req.query.periodo || '2026-09';
    const entidad = req.query.entidad || 'Personal';
    const invoices = await Invoice.find({ periodo, entidad }).sort({ fechaEmision: 1 }).lean();

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
    res.setHeader('Content-Disposition', `attachment; filename="Conciliacion_${entidad}_${periodo}.csv"`);
    return res.send('\uFEFF' + csvContent);
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
