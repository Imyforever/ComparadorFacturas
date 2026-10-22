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
  // Garantizar que la pestania 'Personal' exista en AccountTab para este mes
  await AccountTab.findOneAndUpdate(
    { periodo, nombre: 'Personal' },
    { $setOnInsert: { periodo, nombre: 'Personal' } },
    { upsert: true }
  );

  // Registrar cualquier entidad existente en facturas que aun no este en AccountTab
  const distinctEntities = await Invoice.distinct('entidad', { periodo });
  if (distinctEntities.length > 0) {
    const tabOps = distinctEntities
      .filter((ent) => ent && typeof ent === 'string')
      .map((ent) => ({
        updateOne: {
          filter: { periodo, nombre: ent },
          update: { $setOnInsert: { periodo, nombre: ent } },
          upsert: true
        }
      }));
    if (tabOps.length > 0) {
      await AccountTab.bulkWrite(tabOps);
    }
  }
};

/**
 * Helper para re-ejecutar conciliacion de un mes y entidad en MongoDB Atlas
 */
const runReconciliationForPeriod = async (periodo, entidad = 'Personal') => {
  const invoices = await Invoice.find({ periodo, entidad }).lean();
  const bankMovements = await BankMovement.find({
    periodo,
    entidad,
    tipo: 'Retiro'
  }).lean();

  if (invoices.length === 0) {
    await BankMovement.updateMany(
      { periodo, entidad, tipo: 'Retiro' },
      { $set: { conciliado: false, facturaUuid: null } }
    );
    return { summary: null };
  }

  // 1. Facturas manuales que ya tienen un movimientoId asignado
  const manualInvoices = invoices.filter((i) => i.editadoManualmente && i.estadoPago === 'Pagada');
  const manuallyUsedMovementIds = new Set(
    manualInvoices
      .map((i) => i.pagoAsociado?.movimientoId)
      .filter(Boolean)
      .map((id) => String(id))
  );

  // 2. Movimientos disponibles para conciliacion automatica
  const availableMovements = bankMovements.filter((m) => !manuallyUsedMovementIds.has(String(m._id)));

  // 3. Facturas automaticas
  const autoInvoices = invoices.filter((i) => !i.editadoManualmente);

  const { summary, reconciledInvoices } = reconcile(autoInvoices, availableMovements);

  // 4. Actualizar facturas automaticas
  const bulkInvoiceOps = reconciledInvoices.map((inv) => ({
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

  if (bulkInvoiceOps.length > 0) {
    await Invoice.bulkWrite(bulkInvoiceOps);
  }

  // 5. Construir mapa de todos los movimientos que quedaron asociados (manuales y automaticos)
  const matchedMovementMap = new Map();

  for (const inv of manualInvoices) {
    if (inv.pagoAsociado?.movimientoId) {
      matchedMovementMap.set(String(inv.pagoAsociado.movimientoId), inv.uuid);
    }
  }

  for (const inv of reconciledInvoices) {
    if (inv.estadoPago === 'Pagada' && inv.pagoAsociado?.movimientoId) {
      matchedMovementMap.set(String(inv.pagoAsociado.movimientoId), inv.uuid);
    }
  }

  // 6. Actualizar cada BankMovement con su estado conciliado y facturaUuid
  const bulkBankOps = bankMovements.map((bm) => {
    const matchedUuid = matchedMovementMap.get(String(bm._id));
    return {
      updateOne: {
        filter: { _id: bm._id },
        update: {
          $set: {
            conciliado: !!matchedUuid,
            facturaUuid: matchedUuid || null
          }
        }
      }
    };
  });

  if (bulkBankOps.length > 0) {
    await BankMovement.bulkWrite(bulkBankOps);
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

    // Consultas concurrentes en paralelo para máxima velocidad
    const [allInvoices, unmatchedBankMovements, bankMovementsCount, bankStatements] = await Promise.all([
      Invoice.find({ periodo, entidad }).sort({ fechaEmision: 1 }).lean(),
      BankMovement.find({
        periodo,
        entidad,
        tipo: 'Retiro',
        conciliado: false
      }).sort({ fechaNormalizada: -1, fecha: -1 }).lean(),
      BankMovement.countDocuments({ periodo, entidad, tipo: 'Retiro' }),
      BankStatementFile.find({ periodo, entidad }).sort({ createdAt: -1 }).lean()
    ]);

    let pagadasCount = 0;
    let montoPagado = 0;
    let noPagadasCount = 0;
    let montoNoPagado = 0;
    let egresosCount = 0;
    let montoEgresos = 0;
    let canceladasCount = 0;
    let montoCancelado = 0;
    let montoTotal = 0;

    const invoices = [];

    for (let i = 0; i < allInvoices.length; i++) {
      const inv = allInvoices[i];
      const tot = inv.total || 0;
      montoTotal += tot;

      if (inv.estadoPago === 'Pagada') {
        pagadasCount++;
        montoPagado += tot;
      } else if (inv.estadoPago === 'No Pagada') {
        noPagadasCount++;
        montoNoPagado += tot;
      } else if (inv.estadoPago === 'Cancelada') {
        canceladasCount++;
        montoCancelado += tot;
      }

      if (inv.efecto === 'Egreso') {
        egresosCount++;
        montoEgresos += tot;
      }

      // Filtrado para la lista mostrada
      if (filter === 'all') {
        invoices.push(inv);
      } else if (filter === 'pagadas' && inv.estadoPago === 'Pagada') {
        invoices.push(inv);
      } else if (filter === 'no_pagadas' && inv.estadoPago === 'No Pagada') {
        invoices.push(inv);
      } else if (filter === 'egresos' && inv.efecto === 'Egreso') {
        invoices.push(inv);
      } else if (filter === 'canceladas' && inv.estadoPago === 'Cancelada') {
        invoices.push(inv);
      }
    }

    const totalFacturas = allInvoices.length;
    const unmatchedBankCount = unmatchedBankMovements.length;
    let unmatchedBankMonto = 0;
    for (let i = 0; i < unmatchedBankMovements.length; i++) {
      unmatchedBankMonto += unmatchedBankMovements[i].monto || 0;
    }

    return res.json({
      success: true,
      periodo,
      entidad,
      hasCfdiFile: totalFacturas > 0,
      summary: {
        totalFacturas,
        montoTotal,
        pagadasCount,
        montoPagado,
        noPagadasCount,
        montoNoPagado,
        egresosCount,
        montoEgresos,
        canceladasCount,
        montoCancelado,
        bankMovementsCount,
        unmatchedBankCount,
        unmatchedBankMonto
      },
      bankStatements,
      invoices,
      unmatchedBankMovements
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 3.1 Vincular manualmente un movimiento bancario con una factura de Facturas Recibidas
router.post('/link-manual', async (req, res) => {
  try {
    const { movimientoId, invoiceUuid, observaciones } = req.body;
    if (!movimientoId || !invoiceUuid) {
      return res.status(400).json({ success: false, message: 'Debe especificar movimientoId e invoiceUuid.' });
    }

    const movement = await BankMovement.findById(movimientoId);
    if (!movement) {
      return res.status(404).json({ success: false, message: 'Movimiento bancario no encontrado.' });
    }

    const invoice = await Invoice.findOne({ uuid: invoiceUuid });
    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Factura no encontrada.' });
    }

    // Vincular Factura con Movimiento Bancario
    invoice.estadoPago = 'Pagada';
    invoice.editadoManualmente = true;
    invoice.fechaEdicionManual = new Date();
    invoice.pagoAsociado = {
      movimientoId: movement._id,
      banco: movement.banco || 'Banco',
      fechaPago: movement.fecha,
      montoRetiro: movement.monto,
      diferencia: Math.round(Math.abs((movement.monto || 0) - (invoice.total || 0)) * 100) / 100,
      conceptoBanco: movement.concepto,
      referencia: movement.origenReferencia || ''
    };
    if (observaciones) {
      invoice.observaciones = observaciones.trim();
    }
    await invoice.save();

    // Actualizar movimiento bancario
    movement.conciliado = true;
    movement.facturaUuid = invoice.uuid;
    await movement.save();

    return res.json({
      success: true,
      message: `Pago bancario de $${movement.monto.toFixed(2)} vinculado exitosamente con la factura ${invoice.uuid.substring(0, 8)}... (${invoice.emisor}).`
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 3.2 Desvincular manualmente una factura de su movimiento bancario
router.post('/unlink-manual', async (req, res) => {
  try {
    const { movimientoId, invoiceUuid } = req.body;
    if (!movimientoId && !invoiceUuid) {
      return res.status(400).json({ success: false, message: 'Debe especificar movimientoId o invoiceUuid.' });
    }

    let targetInvoice = null;
    let targetMovement = null;

    if (invoiceUuid) {
      targetInvoice = await Invoice.findOne({ uuid: invoiceUuid });
      if (targetInvoice && targetInvoice.pagoAsociado?.movimientoId) {
        targetMovement = await BankMovement.findById(targetInvoice.pagoAsociado.movimientoId);
      }
    } else if (movimientoId) {
      targetMovement = await BankMovement.findById(movimientoId);
      if (targetMovement && targetMovement.facturaUuid) {
        targetInvoice = await Invoice.findOne({ uuid: targetMovement.facturaUuid });
      }
    }

    if (targetInvoice) {
      targetInvoice.estadoPago = 'No Pagada';
      targetInvoice.pagoAsociado = null;
      targetInvoice.editadoManualmente = false;
      await targetInvoice.save();
    }

    if (targetMovement) {
      targetMovement.conciliado = false;
      targetMovement.facturaUuid = null;
      await targetMovement.save();
    }

    return res.json({
      success: true,
      message: 'Vinculacion manual removida exitosamente.'
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 3.3 Actualizar categoria u observaciones de un movimiento bancario no encontrado en SAT
router.patch('/bank-movement/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { observaciones, categoria } = req.body;

    const movement = await BankMovement.findById(id);
    if (!movement) {
      return res.status(404).json({ success: false, message: 'Movimiento bancario no encontrado.' });
    }

    const updateFields = {};
    if (observaciones !== undefined) updateFields.observaciones = observaciones.trim();
    if (categoria !== undefined) updateFields.categoria = categoria.trim();

    await BankMovement.findByIdAndUpdate(id, { $set: updateFields });

    return res.json({
      success: true,
      message: 'Movimiento bancario actualizado exitosamente.'
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 3.4 Registrar factura externa manualmente y vincularla a un pago bancario
router.post('/manual-invoice', async (req, res) => {
  try {
    const { periodo, entidad, uuid, emisor, rfcEmisor, total, fechaEmision, observaciones, vincularConMovimientoId } = req.body;

    if (!periodo || !uuid || !emisor || total === undefined) {
      return res.status(400).json({ success: false, message: 'Faltan campos obligatorios para registrar la factura.' });
    }

    const cleanUuid = uuid.trim().toUpperCase();
    const existing = await Invoice.findOne({ uuid: cleanUuid });
    if (existing) {
      return res.status(400).json({ success: false, message: `Ya existe una factura registrada con el UUID ${cleanUuid}.` });
    }

    let pagoAsociado = null;
    let estadoPago = 'No Pagada';

    if (vincularConMovimientoId) {
      const movement = await BankMovement.findById(vincularConMovimientoId);
      if (movement) {
        estadoPago = 'Pagada';
        pagoAsociado = {
          movimientoId: movement._id,
          banco: movement.banco || 'Banco',
          fechaPago: movement.fecha,
          montoRetiro: movement.monto,
          diferencia: Math.round(Math.abs((movement.monto || 0) - Number(total)) * 100) / 100,
          conceptoBanco: movement.concepto,
          referencia: movement.origenReferencia || ''
        };
        movement.conciliado = true;
        movement.facturaUuid = cleanUuid;
        await movement.save();
      }
    }

    const newInvoice = new Invoice({
      uuid: cleanUuid,
      periodo,
      entidad: entidad || 'Personal',
      emisor: emisor.trim(),
      rfcEmisor: (rfcEmisor || '').trim().toUpperCase(),
      total: Number(total),
      fechaEmision: fechaEmision ? new Date(fechaEmision) : new Date(),
      efecto: 'Ingreso',
      estadoSat: 'Vigente',
      estadoPago,
      pagoAsociado,
      observaciones: observaciones ? observaciones.trim() : 'Factura registrada manualmente',
      editadoManualmente: true,
      fechaEdicionManual: new Date()
    });

    await newInvoice.save();

    return res.json({
      success: true,
      message: `Factura ${cleanUuid.substring(0, 8)}... registrada y conciliada exitosamente.`
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
      const { movements, detectedPeriods, banco, cuenta } = await parseBankStatement(
        file.buffer,
        targetPeriodo.split('-')[0] || '2026'
      );

      if (!detectedPeriods.includes(targetPeriodo)) {
        return res.status(400).json({
          success: false,
          message: `El archivo "${file.originalname}" corresponde a [${detectedPeriods.join(', ')}] y no contiene movimientos del mes seleccionado (${targetPeriodo}). Operacion cancelada.`
        });
      }

      uploadedResults.push({ file, movements, banco, cuenta });
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
      const bancoDetectado = item.banco || movements[0]?.banco || 'Banco';
      const cuentaDetectada = item.cuenta || movements[0]?.cuenta || '';

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

    const unmatchedBankMovements = await BankMovement.find({
      periodo,
      entidad,
      tipo: 'Retiro',
      conciliado: false
    })
      .sort({ fechaNormalizada: -1, fecha: -1 })
      .lean();

    const unmatchedHeaders = [
      'No.',
      'Fecha Retiro',
      'Banco',
      'Cuenta',
      'Concepto Bancario / Referencia',
      'RFC Detectado',
      'Monto Retiro',
      'Categoria',
      'Observaciones / Nota'
    ];

    const unmatchedRows = unmatchedBankMovements.map((m, idx) => [
      idx + 1,
      `"${m.fecha}"`,
      `"${m.banco}"`,
      `"${m.cuenta || ''}"`,
      `"${(m.concepto || '').replace(/"/g, '""')}"`,
      `"${m.rfcDetectado || ''}"`,
      (m.monto || 0).toFixed(2),
      `"${(m.categoria || '').replace(/"/g, '""')}"`,
      `"${(m.observaciones || '').replace(/"/g, '""')}"`
    ]);

    const csvSections = [
      '--- CONCILIACION DE FACTURAS RECIBIDAS (SAT) ---',
      headers.join(','),
      ...rows.map((r) => r.join(',')),
      '',
      '--- PAGOS BANCARIOS NO ENCONTRADOS EN FACTURAS RECIBIDAS (PENDIENTES DE COMPROBANTE SAT) ---',
      unmatchedHeaders.join(','),
      ...unmatchedRows.map((r) => r.join(','))
    ];

    const csvContent = csvSections.join('\r\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="Conciliacion_${entidad}_${periodo}.csv"`);
    return res.send('\uFEFF' + csvContent);
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
