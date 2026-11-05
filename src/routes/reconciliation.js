const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const mongoose = require('mongoose');
const Invoice = require('../models/Invoice');
const BankMovement = require('../models/BankMovement');
const BankStatementFile = require('../models/BankStatementFile');
const AccountTab = require('../models/AccountTab');
const { parseCfdiReport, parseBankStatement, classifyBBVAMovementIsRetiro } = require('../services/fileFormats');
const { reconcile, normalizeText } = require('../services/reconciler');
const { parseFlexibleDate, PERIODO_REGEX } = require('../services/dates');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  // Conserva acentos y "ñ" en los nombres de archivo (por defecto multer los decodifica como latin1)
  defParamCharset: 'utf8'
});

// ============================================================================
// CONSTANTES Y HELPERS
// ============================================================================

const DEFAULT_PERIODO = '2026-09';
const DEFAULT_ENTIDAD = 'Personal';
// Facturas y cargos por debajo de este importe se ocultan de las tablas (se reportan en una tarjeta aparte)
const SMALL_AMOUNT_THRESHOLD = 100;
const MAX_TAB_NAME_LENGTH = 40;
const ESTADOS_PAGO = Invoice.schema.path('estadoPago').enumValues;

const RESET_MOVEMENT = { conciliado: false, facturaUuid: null };
const RESET_INVOICE_PAYMENT = { estadoPago: 'No Pagada', pagoAsociado: null, editadoManualmente: false };
const AUTO_EGRESO_OBS_REGEX = /^Aplicada a Factura /;

const httpError = (status, message) => {
  const err = new Error(message);
  err.status = status;
  return err;
};

/** Responde un error con el codigo HTTP adecuado (400 para datos invalidos, 500 para fallas del servidor) */
const sendError = (res, err, logLabel) => {
  let status = err.status || 500;
  let message = err.message || 'Error interno del servidor.';

  if (err.name === 'CastError') {
    status = 400;
    message = `Valor invalido para el campo "${err.path}".`;
  } else if (err.name === 'ValidationError') {
    status = 400;
    message = Object.values(err.errors || {})
      .map((e) => e.message)
      .join(' ') || message;
  } else if (err.code === 11000) {
    status = 409;
    message = 'Ya existe un registro con esos datos.';
  }

  if (status >= 500) console.error(logLabel || '[Conciliacion] Error:', err);
  return res.status(status).json({ success: false, message });
};

/** Lee y valida un periodo "AAAA-MM"; usa el periodo por defecto si no se envia */
const readPeriodo = (value) => {
  if (value === undefined || value === null || value === '') return DEFAULT_PERIODO;
  const p = String(value).trim();
  if (!PERIODO_REGEX.test(p)) throw httpError(400, `Periodo invalido "${p}". Use el formato AAAA-MM.`);
  return p;
};

const readEntidad = (value, fallback = DEFAULT_ENTIDAD) => {
  if (value === undefined || value === null) return fallback;
  const e = String(value).trim();
  return e || fallback;
};

const normUuid = (value) => String(value || '').trim().toUpperCase();
const isObjectId = (value) => !!value && mongoose.Types.ObjectId.isValid(String(value));
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const dateOnly = (value) => (value ? String(value).split('T')[0] : '');

/** Movimientos visibles en un mes: los fechados en el mes o los que vienen de un archivo subido a ese mes */
const movementScope = (periodo, entidad) => ({ entidad, $or: [{ periodo }, { archivoPeriodo: periodo }] });

/** Movimientos que pertenecen a los archivos subidos en un mes (con soporte para registros antiguos sin archivoPeriodo) */
const ownedByUpload = (periodo) => ({
  $or: [{ archivoPeriodo: periodo }, { archivoPeriodo: { $in: [null, ''] }, periodo }]
});

const buildPagoFromMovement = (movement, invoiceTotal) => ({
  movimientoId: movement._id,
  banco: movement.banco || 'Banco',
  fechaPago: movement.fecha,
  montoRetiro: movement.monto,
  diferencia: round2(Math.abs((movement.monto || 0) - (Number(invoiceTotal) || 0))),
  conceptoBanco: movement.concepto,
  referencia: movement.origenReferencia || ''
});

const movementTime = (m) => {
  const d = m.fechaNormalizada ? new Date(m.fechaNormalizada) : parseFlexibleDate(m.fecha);
  return d && !isNaN(d.getTime()) ? d.getTime() : 0;
};

/** Ordena movimientos del mas reciente al mas antiguo usando la fecha real (no el texto "DD-MES-YYYY") */
const sortMovementsDesc = (movements) => movements.sort((a, b) => movementTime(b) - movementTime(a));

/**
 * Huella estable de un movimiento para reconocerlo al volver a subir el mismo archivo.
 * El indice de ocurrencia distingue cargos identicos el mismo dia (ej. 2 pagos iguales de Starlink).
 */
const computeHuellas = (movements) => {
  const seen = new Map();
  return movements.map((m) => {
    const base = [
      m.fecha || '',
      m.tipo || '',
      Number(m.monto || 0).toFixed(2),
      normalizeText(m.concepto || ''),
      m.cuenta || ''
    ].join('|');
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    return crypto.createHash('sha1').update(`${base}|${n}`).digest('hex');
  });
};

/** Libera los movimientos bancarios vinculados a las facturas indicadas */
const releaseMovementsLinkedTo = async (uuids) => {
  if (!uuids || uuids.length === 0) return;
  await BankMovement.updateMany({ facturaUuid: { $in: uuids } }, { $set: RESET_MOVEMENT });
};

/**
 * Restablece las facturas que apuntaban a movimientos que ya no existen.
 * Devuelve los alcances (periodo + entidad) afectados para recalcularlos.
 */
const releaseInvoicesLinkedToMovements = async (movementIds) => {
  if (!movementIds || movementIds.length === 0) return [];
  const filter = { 'pagoAsociado.movimientoId': { $in: movementIds } };
  const affected = await Invoice.find(filter, { periodo: 1, entidad: 1 }).lean();
  if (affected.length === 0) return [];

  await Promise.all([
    Invoice.updateMany({ ...filter, estadoPago: 'Pagada' }, { $set: RESET_INVOICE_PAYMENT }),
    Invoice.updateMany({ ...filter, estadoPago: { $ne: 'Pagada' } }, { $set: { pagoAsociado: null } })
  ]);

  const scopes = new Map();
  for (const inv of affected) {
    const entidad = inv.entidad || DEFAULT_ENTIDAD;
    scopes.set(`${inv.periodo}|${entidad}`, { periodo: inv.periodo, entidad });
  }
  return Array.from(scopes.values());
};

/** Quita el vinculo de una Nota de Credito con su factura de ingreso, sin borrar notas escritas por el usuario */
const releaseEgreso = async (egresoUuid) => {
  if (!egresoUuid) return;
  const egreso = await Invoice.findOne({ uuid: egresoUuid });
  if (!egreso) return;
  egreso.ingresoAsociado = null;
  egreso.editadoManualmente = false;
  if (AUTO_EGRESO_OBS_REGEX.test(egreso.observaciones || '')) egreso.observaciones = '';
  await egreso.save();
};

/** Quita el vinculo de una factura de ingreso con una Nota de Credito (lado del ingreso) */
const releaseIngresoFromEgreso = async (ingresoUuid, egresoUuid) => {
  if (!ingresoUuid) return;
  const ingreso = await Invoice.findOne({ uuid: ingresoUuid });
  if (!ingreso) return;
  if (egresoUuid && ingreso.egresoAsociado?.uuid && ingreso.egresoAsociado.uuid !== egresoUuid) return;
  ingreso.egresoAsociado = null;
  if (!ingreso.pagoAsociado?.movimientoId && ingreso.pagoAsociado?.referencia === egresoUuid) {
    ingreso.pagoAsociado = null;
    ingreso.estadoPago = 'No Pagada';
    ingreso.editadoManualmente = false;
  }
  await ingreso.save();
};

/**
 * Vincula (manualmente) una factura con un movimiento bancario, liberando cualquier vinculo previo
 * de ambos lados. No guarda la factura: el llamador decide observaciones y guarda.
 */
const applyManualMovementLink = async (invoice, movement) => {
  // Si la factura tenia otro movimiento bancario asociado, liberarlo
  if (invoice.pagoAsociado?.movimientoId && String(invoice.pagoAsociado.movimientoId) !== String(movement._id)) {
    await BankMovement.findByIdAndUpdate(invoice.pagoAsociado.movimientoId, { $set: RESET_MOVEMENT });
  }

  // Si el movimiento bancario estaba vinculado a otra factura, liberarla
  if (movement.facturaUuid && movement.facturaUuid !== invoice.uuid) {
    await Invoice.findOneAndUpdate(
      { uuid: movement.facturaUuid, 'pagoAsociado.movimientoId': movement._id },
      { $set: RESET_INVOICE_PAYMENT }
    );
  }
  // Cualquier otra factura que aun apunte a este movimiento tambien se libera
  await Invoice.updateMany(
    { uuid: { $ne: invoice.uuid }, 'pagoAsociado.movimientoId': movement._id },
    { $set: RESET_INVOICE_PAYMENT }
  );

  // Si estaba amortizada con una Nota de Credito, el pago bancario la reemplaza
  if (invoice.egresoAsociado?.uuid) {
    await releaseEgreso(invoice.egresoAsociado.uuid);
    invoice.egresoAsociado = null;
  }

  invoice.estadoPago = 'Pagada';
  invoice.editadoManualmente = true;
  invoice.fechaEdicionManual = new Date();
  invoice.pagoAsociado = buildPagoFromMovement(movement, invoice.total);

  movement.conciliado = true;
  movement.facturaUuid = invoice.uuid;
  await movement.save();
};

/** Recalcula los totales de cargos/abonos de los registros de estados de cuenta indicados */
const recomputeStatementStats = async (entidad, nombresArchivo) => {
  if (!nombresArchivo || nombresArchivo.length === 0) return;
  const stats = await BankMovement.aggregate([
    { $match: { entidad, archivoOrigen: { $in: nombresArchivo } } },
    {
      $group: {
        _id: '$archivoOrigen',
        total: { $sum: 1 },
        cargosCount: { $sum: { $cond: [{ $eq: ['$tipo', 'Retiro'] }, 1, 0] } },
        abonosCount: { $sum: { $cond: [{ $eq: ['$tipo', 'Deposito'] }, 1, 0] } },
        montoCargos: { $sum: { $cond: [{ $eq: ['$tipo', 'Retiro'] }, '$monto', 0] } },
        montoAbonos: { $sum: { $cond: [{ $eq: ['$tipo', 'Deposito'] }, '$monto', 0] } }
      }
    }
  ]);
  if (stats.length === 0) return;
  await BankStatementFile.bulkWrite(
    stats.map((s) => ({
      updateMany: {
        filter: { entidad, nombreArchivo: s._id },
        update: {
          $set: {
            totalMovimientos: s.total,
            cargosCount: s.cargosCount,
            abonosCount: s.abonosCount,
            montoCargos: s.montoCargos,
            montoAbonos: s.montoAbonos
          }
        }
      }
    }))
  );
};

/**
 * Helper para asegurar que existan las pestanias por defecto y migrar registros anteriores
 */
const ensureDefaultTabs = async (periodo) => {
  const [totalTabs, distinctEntities] = await Promise.all([
    AccountTab.countDocuments({ periodo }),
    Invoice.distinct('entidad', { periodo })
  ]);

  // Solo si no existe ninguna pestaña activa para este mes, crear una inicial por defecto
  if (totalTabs === 0 && distinctEntities.length === 0) {
    try {
      await AccountTab.create({ periodo, nombre: DEFAULT_ENTIDAD });
    } catch (err) {
      if (err.code !== 11000) throw err; // Otra peticion simultanea ya la creo
    }
  }

  // Registrar cualquier entidad existente en facturas que aun no este en AccountTab
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
    await AccountTab.bulkWrite(tabOps, { ordered: false });
  }
};

/**
 * Corrige movimientos BBVA antiguos que se guardaron con una clasificacion Cargo/Abono distinta
 * a la actual. Solo aplica a estados de cuenta oficiales BBVA (los de Detalle Web se clasifican por saldo).
 */
const fixLegacyBBVAClassification = async (periodo, entidad) => {
  const officialFiles = await BankStatementFile.distinct('nombreArchivo', { entidad, banco: 'BBVA' });
  if (officialFiles.length === 0) return;

  const bbvaMovs = await BankMovement.find(
    { ...movementScope(periodo, entidad), banco: 'BBVA', archivoOrigen: { $in: officialFiles } },
    { concepto: 1, tipo: 1, archivoOrigen: 1 }
  ).lean();

  const fixOps = [];
  const touchedFiles = new Set();
  for (const m of bbvaMovs) {
    const expectedTipo = classifyBBVAMovementIsRetiro(m.concepto) ? 'Retiro' : 'Deposito';
    if (m.tipo !== expectedTipo) {
      fixOps.push({ updateOne: { filter: { _id: m._id }, update: { $set: { tipo: expectedTipo } } } });
      touchedFiles.add(m.archivoOrigen);
    }
  }

  if (fixOps.length > 0) {
    await BankMovement.bulkWrite(fixOps);
    await recomputeStatementStats(entidad, Array.from(touchedFiles));
  }
};

/**
 * Helper para re-ejecutar conciliacion de un mes y entidad en MongoDB Atlas
 */
const runReconciliationForPeriod = async (periodo, entidad = DEFAULT_ENTIDAD) => {
  // 0. Verificar y corregir si algún movimiento BBVA fue clasificado erróneamente antes de conciliar
  await fixLegacyBBVAClassification(periodo, entidad);

  const [invoices, bankMovements] = await Promise.all([
    Invoice.find({ periodo, entidad }).lean(),
    BankMovement.find({ ...movementScope(periodo, entidad), tipo: 'Retiro' }).lean()
  ]);

  // Movimientos que ya estan pagando facturas de OTRO mes o pestania (un estado de cuenta puede abarcar 2 meses).
  // No se pueden reutilizar aqui ni marcarse como libres.
  const externalReservations = new Map();
  if (bankMovements.length > 0) {
    const externalInvoices = await Invoice.find(
      {
        'pagoAsociado.movimientoId': { $in: bankMovements.map((m) => m._id) },
        estadoPago: 'Pagada',
        $nor: [{ periodo, entidad }]
      },
      { uuid: 1, 'pagoAsociado.movimientoId': 1 }
    ).lean();
    for (const inv of externalInvoices) {
      externalReservations.set(String(inv.pagoAsociado.movimientoId), inv.uuid);
    }
  }

  // 1. Facturas manuales que ya tienen un movimientoId asignado
  const manualInvoices = invoices.filter((i) => i.editadoManualmente && i.estadoPago !== 'No Pagada');
  const manuallyUsedMovementIds = new Set(
    manualInvoices
      .map((i) => i.pagoAsociado?.movimientoId)
      .filter(Boolean)
      .map((id) => String(id))
  );

  // 2. Movimientos disponibles para conciliacion automatica
  const availableMovements = bankMovements.filter(
    (m) => !manuallyUsedMovementIds.has(String(m._id)) && !externalReservations.has(String(m._id))
  );

  // 3. Facturas automaticas
  const autoInvoices = invoices.filter((i) => !i.editadoManualmente || i.estadoPago === 'No Pagada');

  const { summary, reconciledInvoices } = reconcile(autoInvoices, availableMovements);

  // 4. Actualizar solo las facturas automaticas cuyo resultado cambio
  const originalByUuid = new Map(autoInvoices.map((i) => [i.uuid, i]));
  const samePago = (a, b) => {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return (
      String(a.movimientoId || '') === String(b.movimientoId || '') &&
      a.montoRetiro === b.montoRetiro &&
      a.diferencia === b.diferencia &&
      a.fechaPago === b.fechaPago
    );
  };

  const bulkInvoiceOps = [];
  for (const inv of reconciledInvoices) {
    const before = originalByUuid.get(inv.uuid);
    const resetManual = inv.estadoPago === 'Pagada' && before?.editadoManualmente;
    if (before && before.estadoPago === inv.estadoPago && samePago(before.pagoAsociado, inv.pagoAsociado) && !resetManual) {
      continue;
    }
    bulkInvoiceOps.push({
      updateOne: {
        filter: { uuid: inv.uuid },
        update: {
          $set: {
            estadoPago: inv.estadoPago,
            pagoAsociado: inv.pagoAsociado,
            ...(inv.estadoPago === 'Pagada' ? { editadoManualmente: false } : {})
          }
        }
      }
    });
  }

  if (bulkInvoiceOps.length > 0) {
    await Invoice.bulkWrite(bulkInvoiceOps);
  }

  // 5. Construir mapa de todos los movimientos que quedaron asociados (manuales, automaticos y de otros meses)
  const matchedMovementMap = new Map(externalReservations);

  for (const inv of manualInvoices) {
    if (inv.estadoPago === 'Pagada' && inv.pagoAsociado?.movimientoId) {
      matchedMovementMap.set(String(inv.pagoAsociado.movimientoId), inv.uuid);
    }
  }

  for (const inv of reconciledInvoices) {
    if (inv.estadoPago === 'Pagada' && inv.pagoAsociado?.movimientoId) {
      matchedMovementMap.set(String(inv.pagoAsociado.movimientoId), inv.uuid);
    }
  }

  // 6. Actualizar solo los BankMovement cuyo estado conciliado / facturaUuid cambio
  const bulkBankOps = [];
  for (const bm of bankMovements) {
    const matchedUuid = matchedMovementMap.get(String(bm._id)) || null;
    if (!!bm.conciliado === !!matchedUuid && (bm.facturaUuid || null) === matchedUuid) continue;
    bulkBankOps.push({
      updateOne: {
        filter: { _id: bm._id },
        update: { $set: { conciliado: !!matchedUuid, facturaUuid: matchedUuid } }
      }
    });
  }

  if (bulkBankOps.length > 0) {
    await BankMovement.bulkWrite(bulkBankOps);
  }

  return { summary: invoices.length === 0 ? null : summary };
};

/** Recalcula varios alcances (periodo + entidad) evitando repetir el mismo */
const runReconciliationForScopes = async (scopes, skip = []) => {
  const skipKeys = new Set(skip.map((s) => `${s.periodo}|${s.entidad}`));
  for (const s of scopes) {
    const key = `${s.periodo}|${s.entidad}`;
    if (skipKeys.has(key)) continue;
    skipKeys.add(key);
    await runReconciliationForPeriod(s.periodo, s.entidad);
  }
};

/**
 * Movimientos de retiro de un mes que no pertenecen a ninguna factura pagada del mismo mes
 * (ni estan reservados por una factura de otro mes).
 */
const filterUnmatchedMovements = (rawBankMovements, allInvoices) => {
  // IDs de movimientos bancarios que están asignados a facturas marcadas como Pagada
  const paidMovementIdSet = new Set(
    allInvoices
      .filter((inv) => inv.estadoPago === 'Pagada' && inv.pagoAsociado?.movimientoId)
      .map((inv) => String(inv.pagoAsociado.movimientoId))
  );

  // UUIDs de facturas vigentes pagadas
  const paidInvoiceUuidSet = new Set(allInvoices.filter((inv) => inv.estadoPago === 'Pagada').map((inv) => inv.uuid));

  // NINGÚN movimiento que pertenezca a una factura pagada debe aparecer en la tabla de sin factura
  return rawBankMovements.filter((m) => {
    if (paidMovementIdSet.has(String(m._id))) return false;
    if (m.facturaUuid && paidInvoiceUuidSet.has(m.facturaUuid)) return false;
    return !m.conciliado || !m.facturaUuid;
  });
};

// ============================================================================
// RUTAS
// ============================================================================

// 1. Obtener lista de periodos (meses) disponibles
router.get('/periodos', async (req, res) => {
  try {
    const [fromInvoices, fromTabs, fromStatements] = await Promise.all([
      Invoice.distinct('periodo'),
      AccountTab.distinct('periodo'),
      BankStatementFile.distinct('periodo')
    ]);
    const sorted = Array.from(new Set([...fromInvoices, ...fromTabs, ...fromStatements]))
      .filter((p) => PERIODO_REGEX.test(p))
      .sort()
      .reverse();
    return res.json({ success: true, periodos: sorted.length ? sorted : [DEFAULT_PERIODO] });
  } catch (err) {
    return sendError(res, err);
  }
});

// 2. Rutas de Administracion de Pestanias / Cuentas por Mes (Personal, Empresa, etc.)
router.get('/tabs', async (req, res) => {
  try {
    const periodo = readPeriodo(req.query.periodo);
    await ensureDefaultTabs(periodo);

    // Conteos agrupados en una sola consulta por coleccion (en lugar de 2 consultas por pestania)
    const [tabs, invoiceCounts, fileCounts] = await Promise.all([
      AccountTab.find({ periodo }).sort({ createdAt: 1 }).lean(),
      Invoice.aggregate([{ $match: { periodo } }, { $group: { _id: '$entidad', n: { $sum: 1 } } }]),
      BankStatementFile.aggregate([{ $match: { periodo } }, { $group: { _id: '$entidad', n: { $sum: 1 } } }])
    ]);

    const invMap = new Map(invoiceCounts.map((c) => [c._id, c.n]));
    const fileMap = new Map(fileCounts.map((c) => [c._id, c.n]));

    const tabsWithCounts = tabs.map((t) => ({
      ...t,
      facturasCount: invMap.get(t.nombre) || 0,
      bankFilesCount: fileMap.get(t.nombre) || 0
    }));

    return res.json({ success: true, tabs: tabsWithCounts });
  } catch (err) {
    return sendError(res, err);
  }
});

router.post('/tabs', async (req, res) => {
  try {
    const { nombre } = req.body;
    if (!req.body.periodo || typeof nombre !== 'string' || !nombre.trim()) {
      return res.status(400).json({ success: false, message: 'El nombre de la pestania es obligatorio.' });
    }
    const periodo = readPeriodo(req.body.periodo);

    const cleanName = nombre.trim().replace(/\s+/g, ' ');
    if (cleanName.length > MAX_TAB_NAME_LENGTH) {
      return res.status(400).json({ success: false, message: `El nombre no puede exceder ${MAX_TAB_NAME_LENGTH} caracteres.` });
    }

    const existing = await AccountTab.findOne({ periodo, nombre: cleanName }).lean();
    if (existing) {
      return res.status(400).json({ success: false, message: `Ya existe una pestania llamada "${cleanName}" en este mes.` });
    }

    try {
      const tab = await AccountTab.create({ periodo, nombre: cleanName });
      return res.json({ success: true, message: `Pestania "${cleanName}" creada exitosamente.`, tab });
    } catch (err) {
      if (err.code === 11000) {
        return res.status(400).json({ success: false, message: `Ya existe una pestania llamada "${cleanName}" en este mes.` });
      }
      throw err;
    }
  } catch (err) {
    return sendError(res, err);
  }
});

router.patch('/tabs/rename', async (req, res) => {
  try {
    const { oldNombre, newNombre } = req.body;
    if (!req.body.periodo || !oldNombre || typeof newNombre !== 'string' || !newNombre.trim()) {
      return res.status(400).json({ success: false, message: 'Datos incompletos para renombrar la pestania.' });
    }
    const periodo = readPeriodo(req.body.periodo);

    const cleanNew = newNombre.trim().replace(/\s+/g, ' ');
    if (oldNombre === cleanNew) {
      return res.json({ success: true, message: 'El nombre es identico.' });
    }
    if (cleanNew.length > MAX_TAB_NAME_LENGTH) {
      return res.status(400).json({ success: false, message: `El nombre no puede exceder ${MAX_TAB_NAME_LENGTH} caracteres.` });
    }

    const tab = await AccountTab.findOne({ periodo, nombre: oldNombre });
    if (!tab) {
      return res.status(404).json({ success: false, message: 'Pestania no encontrada.' });
    }

    const collision = await AccountTab.findOne({ periodo, nombre: cleanNew }).lean();
    if (collision) {
      return res.status(400).json({ success: false, message: `Ya existe una pestania llamada "${cleanNew}".` });
    }

    tab.nombre = cleanNew;
    await tab.save();

    // Actualizar todas las facturas y estados de cuenta asociados a este nombre.
    // Los movimientos se identifican por el mes al que se subio su archivo (no por su fecha),
    // asi los movimientos del mes siguiente incluidos en el mismo estado de cuenta tambien se mueven.
    await Promise.all([
      Invoice.updateMany({ periodo, entidad: oldNombre }, { $set: { entidad: cleanNew } }),
      BankMovement.updateMany({ entidad: oldNombre, ...ownedByUpload(periodo) }, { $set: { entidad: cleanNew } }),
      BankStatementFile.updateMany({ periodo, entidad: oldNombre }, { $set: { entidad: cleanNew } })
    ]);

    await runReconciliationForPeriod(periodo, cleanNew);

    return res.json({
      success: true,
      message: `Pestania renombrada a "${cleanNew}". Registros actualizados.`
    });
  } catch (err) {
    return sendError(res, err);
  }
});

router.delete('/tabs', async (req, res) => {
  try {
    const { nombre } = req.query;
    if (!req.query.periodo || !nombre) {
      return res.status(400).json({ success: false, message: 'Datos insuficientes.' });
    }
    const periodo = readPeriodo(req.query.periodo);

    const totalTabs = await AccountTab.countDocuments({ periodo });
    if (totalTabs <= 1) {
      return res.status(400).json({ success: false, message: 'No se puede eliminar la unica pestania activa del mes.' });
    }

    const tab = await AccountTab.findOne({ periodo, nombre }).lean();
    if (!tab) {
      return res.status(404).json({ success: false, message: 'Pestania no encontrada.' });
    }

    const movementFilter = { entidad: nombre, ...ownedByUpload(periodo) };
    const [invoiceUuids, movementIds] = await Promise.all([
      Invoice.distinct('uuid', { periodo, entidad: nombre }),
      BankMovement.distinct('_id', movementFilter)
    ]);

    await AccountTab.deleteOne({ _id: tab._id });
    const deletedInvoices = await Invoice.deleteMany({ periodo, entidad: nombre });
    const deletedBank = await BankMovement.deleteMany(movementFilter);
    await BankStatementFile.deleteMany({ periodo, entidad: nombre });

    // Limpiar vinculos que otros meses tenian con los registros eliminados
    await releaseMovementsLinkedTo(invoiceUuids);
    const affectedScopes = await releaseInvoicesLinkedToMovements(movementIds);
    await runReconciliationForScopes(affectedScopes, [{ periodo, entidad: nombre }]);

    return res.json({
      success: true,
      message: `Pestania "${nombre}" eliminada (${deletedInvoices.deletedCount} facturas y ${deletedBank.deletedCount} movimientos eliminados).`
    });
  } catch (err) {
    return sendError(res, err);
  }
});

// 3. Obtener resumen, facturas y lista de estados de cuenta subidos de un periodo y entidad
router.get('/data', async (req, res) => {
  try {
    const periodo = readPeriodo(req.query.periodo);
    const filter = req.query.filter || 'all';

    await ensureDefaultTabs(periodo);

    let entidad = req.query.entidad;
    if (!entidad) {
      const firstTab = await AccountTab.findOne({ periodo }).sort({ createdAt: 1 }).lean();
      entidad = firstTab ? firstTab.nombre : DEFAULT_ENTIDAD;
    }

    // Consultas concurrentes en paralelo para máxima velocidad
    const [allInvoices, rawBankMovements, bankStatements] = await Promise.all([
      Invoice.find({ periodo, entidad }).sort({ fechaEmision: 1 }).lean(),
      BankMovement.find({ ...movementScope(periodo, entidad), tipo: 'Retiro' }).lean(),
      BankStatementFile.find({ periodo, entidad }).sort({ createdAt: -1 }).lean()
    ]);

    sortMovementsDesc(rawBankMovements);
    const bankMovementsCount = rawBankMovements.length;
    const allUnmatchedBankMovements = filterUnmatchedMovements(rawBankMovements, allInvoices);

    let pagadasCount = 0;
    let montoPagado = 0;
    let noPagadasCount = 0;
    let montoNoPagado = 0;
    let egresosCount = 0;
    let montoEgresos = 0;
    let canceladasCount = 0;
    let montoCancelado = 0;
    let montoTotal = 0;
    let menores50Count = 0;
    let montoMenores50 = 0;

    const invoices = [];

    for (const inv of allInvoices) {
      const tot = Number(inv.total || 0);
      montoTotal += tot;

      if (tot < SMALL_AMOUNT_THRESHOLD) {
        menores50Count++;
        montoMenores50 += tot;
      }

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

      // Excluir facturas de importe menor al umbral de las tablas
      if (tot < SMALL_AMOUNT_THRESHOLD) continue;

      // Filtrado para la lista mostrada
      if (
        filter === 'all' ||
        (filter === 'pagadas' && inv.estadoPago === 'Pagada') ||
        (filter === 'no_pagadas' && inv.estadoPago === 'No Pagada') ||
        (filter === 'egresos' && inv.efecto === 'Egreso') ||
        (filter === 'canceladas' && inv.estadoPago === 'Cancelada')
      ) {
        invoices.push(inv);
      }
    }

    let unmatchedMenores50Count = 0;
    let unmatchedMontoMenores50 = 0;
    let unmatchedBankMonto = 0;
    const unmatchedBankMovements = [];

    for (const m of allUnmatchedBankMovements) {
      const mvMonto = Number(m.monto || 0);
      if (mvMonto < SMALL_AMOUNT_THRESHOLD) {
        unmatchedMenores50Count++;
        unmatchedMontoMenores50 += mvMonto;
        menores50Count++;
        montoMenores50 += mvMonto;
        continue;
      }
      unmatchedBankMovements.push(m);
      unmatchedBankMonto += mvMonto;
    }

    const totalFacturas = allInvoices.length;

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
        menores50Count,
        montoMenores50,
        unmatchedMenores50Count,
        unmatchedMontoMenores50,
        bankMovementsCount,
        unmatchedBankCount: unmatchedBankMovements.length,
        unmatchedBankMonto
      },
      bankStatements,
      invoices,
      unmatchedBankMovements
    });
  } catch (err) {
    return sendError(res, err);
  }
});

// 3.0 Recalcular y sincronizar conciliación de un periodo y entidad
router.post('/refresh', async (req, res) => {
  try {
    const periodo = readPeriodo(req.body.periodo || req.query.periodo);
    const entidad = readEntidad(req.body.entidad || req.query.entidad);

    await ensureDefaultTabs(periodo);
    const { summary } = await runReconciliationForPeriod(periodo, entidad);

    return res.json({
      success: true,
      message: `Conciliación del periodo ${periodo} (${entidad}) recalculada y sincronizada exitosamente.`,
      summary
    });
  } catch (err) {
    return sendError(res, err, 'Error recalculando conciliación:');
  }
});

// 3.1 Vincular manualmente un movimiento bancario con una factura de Facturas Recibidas
router.post('/link-manual', async (req, res) => {
  try {
    const { movimientoId, observaciones } = req.body;
    const invoiceUuid = normUuid(req.body.invoiceUuid);
    if (!movimientoId || !invoiceUuid) {
      return res.status(400).json({ success: false, message: 'Debe especificar movimientoId e invoiceUuid.' });
    }
    if (!isObjectId(movimientoId)) {
      return res.status(400).json({ success: false, message: 'Identificador de movimiento invalido.' });
    }

    const [movement, invoice] = await Promise.all([
      BankMovement.findById(movimientoId),
      Invoice.findOne({ uuid: invoiceUuid })
    ]);
    if (!movement) {
      return res.status(404).json({ success: false, message: 'Movimiento bancario no encontrado.' });
    }
    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Factura no encontrada.' });
    }

    await applyManualMovementLink(invoice, movement);

    if (typeof observaciones === 'string' && observaciones.trim()) {
      invoice.observaciones = observaciones.trim();
    } else if (!invoice.observaciones || invoice.observaciones === 'Sin observaciones') {
      invoice.observaciones = `Vinculado manualmente a retiro de ${movement.banco || 'Banco'} ($${(movement.monto || 0).toFixed(2)})`;
    }
    await invoice.save();

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

// 3.2 Desvincular manualmente una factura de su movimiento bancario
router.post('/unlink-manual', async (req, res) => {
  try {
    const { movimientoId } = req.body;
    const invoiceUuid = normUuid(req.body.invoiceUuid);
    if (!movimientoId && !invoiceUuid) {
      return res.status(400).json({ success: false, message: 'Debe especificar movimientoId o invoiceUuid.' });
    }
    if (!invoiceUuid && !isObjectId(movimientoId)) {
      return res.status(400).json({ success: false, message: 'Identificador de movimiento invalido.' });
    }

    let targetInvoice = null;
    let targetMovement = null;

    if (invoiceUuid) {
      targetInvoice = await Invoice.findOne({ uuid: invoiceUuid });
      if (targetInvoice && targetInvoice.pagoAsociado?.movimientoId) {
        targetMovement = await BankMovement.findById(targetInvoice.pagoAsociado.movimientoId);
      }
    } else {
      targetMovement = await BankMovement.findById(movimientoId);
      if (targetMovement && targetMovement.facturaUuid) {
        targetInvoice = await Invoice.findOne({ uuid: targetMovement.facturaUuid });
      }
    }

    if (targetInvoice) {
      // Si el pago era una Nota de Credito, liberar tambien la nota
      if (targetInvoice.egresoAsociado?.uuid && !targetInvoice.pagoAsociado?.movimientoId) {
        await releaseEgreso(targetInvoice.egresoAsociado.uuid);
        targetInvoice.egresoAsociado = null;
      }
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
    return sendError(res, err);
  }
});

// 3.2.1 Vincular manualmente una factura de Ingreso con una Nota de Credito (Egreso)
router.post('/link-egreso', async (req, res) => {
  try {
    const { observaciones } = req.body;
    const cleanIngresoUuid = normUuid(req.body.ingresoUuid);
    const cleanEgresoUuid = normUuid(req.body.egresoUuid);
    if (!cleanIngresoUuid || !cleanEgresoUuid) {
      return res.status(400).json({ success: false, message: 'Debe especificar ingresoUuid y egresoUuid.' });
    }
    if (cleanIngresoUuid === cleanEgresoUuid) {
      return res.status(400).json({ success: false, message: 'La factura y la nota de crédito deben ser comprobantes distintos.' });
    }

    const [ingreso, egreso] = await Promise.all([
      Invoice.findOne({ uuid: cleanIngresoUuid }),
      Invoice.findOne({ uuid: cleanEgresoUuid })
    ]);
    if (!ingreso) {
      return res.status(404).json({ success: false, message: 'Factura de ingreso no encontrada.' });
    }
    if (!egreso) {
      return res.status(404).json({ success: false, message: 'Nota de crédito (Egreso) no encontrada.' });
    }
    if (egreso.efecto !== 'Egreso') {
      return res.status(400).json({ success: false, message: 'El comprobante a vincular debe ser de tipo "Egreso" (Nota de Crédito).' });
    }
    if (ingreso.efecto === 'Egreso') {
      return res.status(400).json({ success: false, message: 'Una Nota de Crédito no puede amortizarse con otra Nota de Crédito.' });
    }

    // Si el ingreso tenia un movimiento bancario previamente vinculado, liberarlo
    if (ingreso.pagoAsociado?.movimientoId) {
      await BankMovement.findByIdAndUpdate(ingreso.pagoAsociado.movimientoId, { $set: RESET_MOVEMENT });
    }

    // Si el ingreso ya estaba amortizado con otra nota de credito, liberarla
    if (ingreso.egresoAsociado?.uuid && ingreso.egresoAsociado.uuid !== egreso.uuid) {
      await releaseEgreso(ingreso.egresoAsociado.uuid);
    }

    // Si el egreso ya estaba asociado a otro ingreso, desvincular el previo
    if (egreso.ingresoAsociado?.uuid && egreso.ingresoAsociado.uuid !== ingreso.uuid) {
      await Invoice.findOneAndUpdate(
        { uuid: egreso.ingresoAsociado.uuid },
        { $set: { egresoAsociado: null, ...RESET_INVOICE_PAYMENT } }
      );
    }

    // Vincular Factura de Ingreso
    ingreso.estadoPago = 'Pagada';
    ingreso.editadoManualmente = true;
    ingreso.fechaEdicionManual = new Date();
    ingreso.egresoAsociado = {
      uuid: egreso.uuid,
      total: egreso.total,
      fechaEmision: egreso.fechaEmision,
      emisor: egreso.emisor
    };
    ingreso.pagoAsociado = {
      movimientoId: null,
      banco: 'Nota de Crédito (Egreso)',
      fechaPago: dateOnly(egreso.fechaEmision) || dateOnly(ingreso.fechaEmision),
      montoRetiro: egreso.total,
      diferencia: round2(Math.abs((egreso.total || 0) - (ingreso.total || 0))),
      conceptoBanco: `Nota de Crédito SAT: ${egreso.uuid}`,
      referencia: egreso.uuid
    };
    if (typeof observaciones === 'string' && observaciones.trim()) {
      ingreso.observaciones = observaciones.trim();
    } else if (!ingreso.observaciones || ingreso.observaciones === 'Sin observaciones') {
      ingreso.observaciones = `Amortizada con Nota de Crédito ${egreso.uuid.substring(0, 8)}...`;
    }
    await ingreso.save();

    // Actualizar Nota de Crédito (Egreso)
    egreso.ingresoAsociado = {
      uuid: ingreso.uuid,
      total: ingreso.total,
      fechaEmision: ingreso.fechaEmision,
      emisor: ingreso.emisor
    };
    egreso.editadoManualmente = true;
    egreso.fechaEdicionManual = new Date();
    if (!egreso.observaciones || egreso.observaciones === 'Sin observaciones' || AUTO_EGRESO_OBS_REGEX.test(egreso.observaciones)) {
      egreso.observaciones = `Aplicada a Factura ${ingreso.uuid.substring(0, 8)}... (${ingreso.emisor})`;
    }
    await egreso.save();

    return res.json({
      success: true,
      message: `Factura ${ingreso.uuid.substring(0, 8)}... vinculada exitosamente con la Nota de Crédito ${egreso.uuid.substring(0, 8)}... ($${(egreso.total || 0).toFixed(2)}).`,
      ingreso,
      egreso
    });
  } catch (err) {
    return sendError(res, err, 'Error vinculando egreso:');
  }
});

// 3.2.2 Desvincular manualmente una factura de su Nota de Credito (Egreso)
router.post('/unlink-egreso', async (req, res) => {
  try {
    const ingresoUuid = normUuid(req.body.ingresoUuid);
    const egresoUuid = normUuid(req.body.egresoUuid);
    if (!ingresoUuid && !egresoUuid) {
      return res.status(400).json({ success: false, message: 'Debe especificar ingresoUuid o egresoUuid.' });
    }

    let targetIngreso = null;
    let targetEgreso = null;

    if (ingresoUuid) {
      targetIngreso = await Invoice.findOne({ uuid: ingresoUuid });
      if (targetIngreso && targetIngreso.egresoAsociado?.uuid) {
        targetEgreso = await Invoice.findOne({ uuid: targetIngreso.egresoAsociado.uuid });
      }
    } else {
      targetEgreso = await Invoice.findOne({ uuid: egresoUuid });
      if (targetEgreso && targetEgreso.ingresoAsociado?.uuid) {
        targetIngreso = await Invoice.findOne({ uuid: targetEgreso.ingresoAsociado.uuid });
      }
    }

    if (targetIngreso) {
      const linkedEgresoUuid = targetEgreso?.uuid || targetIngreso.egresoAsociado?.uuid;
      targetIngreso.egresoAsociado = null;
      if (
        !targetIngreso.pagoAsociado?.movimientoId &&
        (targetIngreso.pagoAsociado?.banco?.includes('Nota de Crédito') ||
          (linkedEgresoUuid && targetIngreso.pagoAsociado?.referencia === linkedEgresoUuid))
      ) {
        targetIngreso.pagoAsociado = null;
        targetIngreso.estadoPago = 'No Pagada';
        targetIngreso.editadoManualmente = false;
      }
      await targetIngreso.save();
    }

    if (targetEgreso) {
      targetEgreso.ingresoAsociado = null;
      targetEgreso.editadoManualmente = false;
      // Conservar notas escritas por el usuario; borrar solo la nota generada automaticamente
      if (AUTO_EGRESO_OBS_REGEX.test(targetEgreso.observaciones || '')) targetEgreso.observaciones = '';
      await targetEgreso.save();
    }

    return res.json({
      success: true,
      message: 'Nota de crédito desvinculada exitosamente.'
    });
  } catch (err) {
    return sendError(res, err);
  }
});

// 3.2.3 Auto-vincular facturas de Ingreso con Notas de Credito (Egresos) de monto y proveedor identicos
router.post('/auto-link-egresos', async (req, res) => {
  try {
    const { entidad } = req.body;
    if (!req.body.periodo || !entidad) {
      return res.status(400).json({ success: false, message: 'Debe especificar periodo y entidad.' });
    }
    const periodo = readPeriodo(req.body.periodo);

    const [ingresos, egresos] = await Promise.all([
      Invoice.find({ periodo, entidad, efecto: 'Ingreso', estadoSat: 'Vigente' }).sort({ fechaEmision: 1 }).lean(),
      Invoice.find({ periodo, entidad, efecto: 'Egreso', estadoSat: 'Vigente' }).sort({ fechaEmision: 1 }).lean()
    ]);

    const usedEgresoUuids = new Set(ingresos.map((i) => i.egresoAsociado?.uuid).filter(Boolean));

    // Indice de notas de credito disponibles por RFC + importe en centavos
    const availableByKey = new Map();
    for (const e of egresos) {
      if (usedEgresoUuids.has(e.uuid) || e.ingresoAsociado?.uuid) continue;
      const key = `${e.rfcEmisor}|${Math.round(Number(e.total || 0) * 100)}`;
      if (!availableByKey.has(key)) availableByKey.set(key, []);
      availableByKey.get(key).push(e);
    }

    const unlinkedIngresos = ingresos.filter(
      (i) => !i.egresoAsociado?.uuid && !i.pagoAsociado?.movimientoId && i.estadoPago !== 'Pagada'
    );

    let linkedCount = 0;
    const bulkOps = [];
    const now = new Date();

    for (const ing of unlinkedIngresos) {
      const key = `${ing.rfcEmisor}|${Math.round(Number(ing.total || 0) * 100)}`;
      const bucket = availableByKey.get(key);
      if (!bucket || bucket.length === 0) continue;

      const eg = bucket.shift();
      linkedCount++;

      bulkOps.push({
        updateOne: {
          filter: { uuid: ing.uuid },
          update: {
            $set: {
              estadoPago: 'Pagada',
              editadoManualmente: true,
              fechaEdicionManual: now,
              egresoAsociado: {
                uuid: eg.uuid,
                total: eg.total,
                fechaEmision: eg.fechaEmision,
                emisor: eg.emisor
              },
              pagoAsociado: {
                movimientoId: null,
                banco: 'Nota de Crédito (Egreso)',
                fechaPago: dateOnly(eg.fechaEmision),
                montoRetiro: eg.total,
                diferencia: 0.0,
                conceptoBanco: `Nota de Crédito SAT: ${eg.uuid}`,
                referencia: eg.uuid
              },
              ...(ing.observaciones && ing.observaciones !== 'Sin observaciones'
                ? {}
                : { observaciones: `Amortizada automáticamente con Nota de Crédito ${eg.uuid.substring(0, 8)}...` })
            }
          }
        }
      });

      bulkOps.push({
        updateOne: {
          filter: { uuid: eg.uuid },
          update: {
            $set: {
              ingresoAsociado: {
                uuid: ing.uuid,
                total: ing.total,
                fechaEmision: ing.fechaEmision,
                emisor: ing.emisor
              },
              editadoManualmente: true,
              fechaEdicionManual: now,
              ...(eg.observaciones && !AUTO_EGRESO_OBS_REGEX.test(eg.observaciones) && eg.observaciones !== 'Sin observaciones'
                ? {}
                : { observaciones: `Aplicada a Factura ${ing.uuid.substring(0, 8)}... (${ing.emisor})` })
            }
          }
        }
      });
    }

    if (bulkOps.length > 0) {
      await Invoice.bulkWrite(bulkOps);
    }

    return res.json({
      success: true,
      linkedCount,
      message: `Se asociaron exitosamente ${linkedCount} facturas con sus Notas de Crédito correspondientes.`
    });
  } catch (err) {
    return sendError(res, err);
  }
});

// 3.3 Actualizar categoria u observaciones de un movimiento bancario no encontrado en SAT
router.patch('/bank-movement/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { observaciones, categoria } = req.body;

    if (!isObjectId(id)) {
      return res.status(400).json({ success: false, message: 'Identificador de movimiento invalido.' });
    }

    const updateFields = {};
    if (observaciones !== undefined && observaciones !== null) updateFields.observaciones = String(observaciones).trim();
    if (categoria !== undefined && categoria !== null) updateFields.categoria = String(categoria).trim();

    const movement = await BankMovement.findByIdAndUpdate(id, { $set: updateFields }, { new: true });
    if (!movement) {
      return res.status(404).json({ success: false, message: 'Movimiento bancario no encontrado.' });
    }

    return res.json({
      success: true,
      message: 'Movimiento bancario actualizado exitosamente.'
    });
  } catch (err) {
    return sendError(res, err);
  }
});

// 3.4 Registrar factura externa manualmente y vincularla a un pago bancario
router.post('/manual-invoice', async (req, res) => {
  try {
    const { entidad, uuid, emisor, rfcEmisor, total, fechaEmision, observaciones, vincularConMovimientoId } = req.body;

    if (!req.body.periodo || !uuid || !emisor || total === undefined || total === null || total === '') {
      return res.status(400).json({ success: false, message: 'Faltan campos obligatorios para registrar la factura.' });
    }
    const periodo = readPeriodo(req.body.periodo);

    const numericTotal = Number(total);
    if (!Number.isFinite(numericTotal) || numericTotal < 0) {
      return res.status(400).json({ success: false, message: 'El total de la factura debe ser un numero valido.' });
    }

    const cleanUuid = normUuid(uuid);
    const existing = await Invoice.findOne({ uuid: cleanUuid }).lean();
    if (existing) {
      return res.status(400).json({ success: false, message: `Ya existe una factura registrada con el UUID ${cleanUuid}.` });
    }

    // fechaEmision se guarda como texto ISO (igual que las facturas del SAT) para que ordene correctamente
    let fechaTexto = new Date().toISOString().split('.')[0];
    if (fechaEmision) {
      const parsed = parseFlexibleDate(fechaEmision);
      if (!parsed) {
        return res.status(400).json({ success: false, message: 'Fecha de emision invalida.' });
      }
      const pad = (n) => String(n).padStart(2, '0');
      fechaTexto = `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}T00:00:00`;
    }

    let movement = null;
    if (vincularConMovimientoId) {
      if (!isObjectId(vincularConMovimientoId)) {
        return res.status(400).json({ success: false, message: 'Identificador de movimiento invalido.' });
      }
      movement = await BankMovement.findById(vincularConMovimientoId);
      if (!movement) {
        return res.status(404).json({ success: false, message: 'Movimiento bancario no encontrado.' });
      }
    }

    const newInvoice = new Invoice({
      uuid: cleanUuid,
      periodo,
      entidad: readEntidad(entidad),
      emisor: String(emisor).trim(),
      // RFC generico del SAT cuando el proveedor no lo proporciona (el campo es obligatorio)
      rfcEmisor: String(rfcEmisor || '').trim().toUpperCase() || 'XAXX010101000',
      total: numericTotal,
      fechaEmision: fechaTexto,
      efecto: 'Ingreso',
      estadoSat: 'Vigente',
      estadoPago: 'No Pagada',
      pagoAsociado: null,
      observaciones: typeof observaciones === 'string' && observaciones.trim() ? observaciones.trim() : 'Factura registrada manualmente',
      editadoManualmente: true,
      fechaEdicionManual: new Date()
    });

    // Validar antes de tocar el movimiento para no dejarlo vinculado a una factura que no se guardo
    await newInvoice.validate();
    if (movement) {
      await applyManualMovementLink(newInvoice, movement);
    }
    await newInvoice.save();

    return res.json({
      success: true,
      message: `Factura ${cleanUuid.substring(0, 8)}... registrada y conciliada exitosamente.`
    });
  } catch (err) {
    return sendError(res, err);
  }
});

// 4. Subir archivo PDF de Facturas Recibidas (SAT Consulta CFDI)
router.post('/upload-cfdi', upload.single('cfdiPdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Debe adjuntar el archivo PDF de facturas.' });
    }

    const targetPeriodo = readPeriodo(req.body.periodo);
    const entidad = readEntidad(req.body.entidad);

    // Regla: Solo un archivo de facturas por mes y pestania. Si ya existe, se bloquea.
    const existingCount = await Invoice.countDocuments({ periodo: targetPeriodo, entidad });
    if (existingCount > 0 && req.query.replace !== 'true') {
      return res.status(400).json({
        success: false,
        isBlocked: true,
        message: `Ya existe un archivo de facturas cargado para "${entidad}" en el mes ${targetPeriodo} (${existingCount} facturas). Solo se permite un archivo por pestania.`
      });
    }

    let parsed;
    try {
      parsed = await parseCfdiReport(req.file.buffer);
    } catch (parseErr) {
      throw httpError(parseErr.status || 400, parseErr.status ? parseErr.message : `No se pudo leer el PDF de facturas: ${parseErr.message}`);
    }
    const { invoices: parsedInvoices, detectedPeriod } = parsed;

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

    // Quitar UUID repetidos dentro del mismo PDF
    const uniqueByUuid = new Map();
    for (const inv of parsedInvoices) uniqueByUuid.set(inv.uuid, inv);
    const uuids = Array.from(uniqueByUuid.keys());

    // El UUID es unico global: no mover facturas que ya pertenecen a otra pestania o mes
    const elsewhere = await Invoice.find(
      { uuid: { $in: uuids }, $nor: [{ periodo: targetPeriodo, entidad }] },
      { uuid: 1, periodo: 1, entidad: 1 }
    ).lean();
    const elsewhereSet = new Set(elsewhere.map((i) => i.uuid));

    const invoicesToSave = Array.from(uniqueByUuid.values()).filter((inv) => !elsewhereSet.has(inv.uuid));

    if (invoicesToSave.length === 0) {
      const sample = elsewhere[0];
      return res.status(400).json({
        success: false,
        message: `Todas las facturas de este archivo ya estan registradas en otra pestania o mes (ej. "${sample.entidad}" ${sample.periodo}).`
      });
    }

    const bulkOps = invoicesToSave.map((inv) => {
      const { estadoPago, ...satFields } = inv;
      const isCancelada = inv.estadoSat === 'Cancelado';
      return {
        updateOne: {
          filter: { uuid: inv.uuid },
          update: {
            // Datos del SAT siempre se actualizan; el estado de pago capturado por el usuario se conserva al reemplazar
            $set: { ...satFields, periodo: targetPeriodo, entidad, ...(isCancelada ? { estadoPago: 'Cancelada' } : {}) },
            ...(isCancelada ? {} : { $setOnInsert: { estadoPago: estadoPago || 'No Pagada' } })
          },
          upsert: true
        }
      };
    });

    await Invoice.bulkWrite(bulkOps, { ordered: false });

    // Reconciliar de inmediato para esta entidad y periodo
    await runReconciliationForPeriod(targetPeriodo, entidad);

    const skippedMsg = elsewhereSet.size > 0
      ? ` Se omitieron ${elsewhereSet.size} facturas que ya estaban registradas en otra pestania o mes.`
      : '';

    return res.json({
      success: true,
      message: `Se procesaron y guardaron ${invoicesToSave.length} facturas para "${entidad}" en el mes ${targetPeriodo}.${skippedMsg}`,
      count: invoicesToSave.length,
      skipped: elsewhereSet.size,
      periodo: targetPeriodo,
      entidad
    });
  } catch (err) {
    return sendError(res, err, 'Error procesando reporte CFDI:');
  }
});

// 5. Eliminar archivo de facturas de un mes y entidad si se desea reemplazar
router.delete('/cfdi', async (req, res) => {
  try {
    const periodo = readPeriodo(req.query.periodo);
    const entidad = readEntidad(req.query.entidad);

    const uuids = await Invoice.distinct('uuid', { periodo, entidad });
    const deleted = await Invoice.deleteMany({ periodo, entidad });

    // Liberar los movimientos bancarios que estaban conciliados con las facturas eliminadas
    // (de lo contrario quedarian ocultos de la tabla de pagos sin factura)
    await releaseMovementsLinkedTo(uuids);
    // Notas de credito de otros meses aplicadas a estas facturas (o al reves)
    await Invoice.updateMany({ 'ingresoAsociado.uuid': { $in: uuids } }, { $set: { ingresoAsociado: null, editadoManualmente: false } });
    await Invoice.updateMany(
      { 'egresoAsociado.uuid': { $in: uuids } },
      { $set: { egresoAsociado: null, ...RESET_INVOICE_PAYMENT } }
    );

    return res.json({
      success: true,
      message: `Se eliminaron ${deleted.deletedCount} facturas de "${entidad}" del mes ${periodo}. Ahora puede subir un nuevo archivo.`
    });
  } catch (err) {
    return sendError(res, err);
  }
});

// 6. Subir N archivos de Estado de Cuenta Bancario
router.post('/upload-bank', upload.array('bankPdfs', 20), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, message: 'Debe adjuntar al menos un estado de cuenta.' });
    }

    const targetPeriodo = readPeriodo(req.body.periodo);
    const entidad = readEntidad(req.body.entidad);
    let totalMovements = 0;
    const uploadedResults = [];

    // Validar primero todos los archivos
    for (const file of req.files) {
      const fileName = file.originalname || 'archivo';
      let parsed;
      try {
        parsed = await parseBankStatement(file.buffer, targetPeriodo.split('-')[0], fileName);
      } catch (parseErr) {
        throw httpError(
          parseErr.status || 400,
          parseErr.status ? parseErr.message : `No se pudo leer el archivo "${fileName}": ${parseErr.message}`
        );
      }
      const { movements, detectedPeriods, banco, cuenta } = parsed;

      if (movements.length === 0) {
        return res.status(400).json({
          success: false,
          message: `No se encontraron movimientos en el archivo "${fileName}". Verifique que sea un estado de cuenta compatible (BBVA o Scotiabank). Operacion cancelada.`
        });
      }

      if (!detectedPeriods.includes(targetPeriodo)) {
        return res.status(400).json({
          success: false,
          message: `El archivo "${fileName}" corresponde a [${detectedPeriods.join(', ')}] y no contiene movimientos del mes seleccionado (${targetPeriodo}). Operacion cancelada.`
        });
      }

      uploadedResults.push({ file, fileName, movements, banco, cuenta });
    }

    const removedMovementIds = [];

    // Si todos pasaron la validacion de mes, guardar movimientos y registrar archivo
    for (const item of uploadedResults) {
      const { fileName, movements } = item;
      const ownerFilter = { archivoOrigen: fileName, entidad };

      // Movimientos previos de este mismo archivo: se reemplazan para evitar duplicados al re-subir,
      // pero se conservan su _id, notas y categoria para no romper vinculos manuales con facturas.
      const oldMovs = await BankMovement.find(ownerFilter).sort({ _id: 1 }).lean();
      const oldHuellas = computeHuellas(oldMovs);
      const oldByHuella = new Map();
      oldMovs.forEach((m, idx) => oldByHuella.set(m.huella || oldHuellas[idx], m));

      // Insertar cada movimiento del estado de cuenta fielmente.
      // Si el PDF contiene 2 o más cargos con el mismo importe y fecha (ej. 2 pagos de Starlink de $1,724.24),
      // se conservan y guardan AMBOS movimientos con su ID único propio para que concilien sus respectivas facturas.
      const newHuellas = computeHuellas(movements);
      const preservedIds = new Set();
      const docsToInsert = movements.map((mv, idx) => {
        const huella = newHuellas[idx];
        const previous = oldByHuella.get(huella);
        const doc = { ...mv, entidad, archivoOrigen: fileName, archivoPeriodo: targetPeriodo, huella };
        if (previous) {
          preservedIds.add(String(previous._id));
          doc._id = previous._id;
          doc.observaciones = previous.observaciones || '';
          doc.categoria = previous.categoria || '';
          if (previous.tipo === mv.tipo) {
            doc.conciliado = !!previous.conciliado;
            doc.facturaUuid = previous.facturaUuid || null;
          }
        }
        return doc;
      });

      for (const m of oldMovs) {
        if (!preservedIds.has(String(m._id))) removedMovementIds.push(m._id);
      }

      await BankMovement.deleteMany(ownerFilter);
      if (docsToInsert.length > 0) {
        await BankMovement.insertMany(docsToInsert);
        totalMovements += docsToInsert.length;
      }

      const retiros = movements.filter((m) => m.tipo === 'Retiro');
      const depositos = movements.filter((m) => m.tipo === 'Deposito');
      const totalCargos = retiros.reduce((s, m) => s + (m.monto || 0), 0);
      const totalAbonos = depositos.reduce((s, m) => s + (m.monto || 0), 0);
      const bancoDetectado = item.banco || movements[0]?.banco || 'Banco';
      const cuentaDetectada = item.cuenta || movements[0]?.cuenta || '';

      await BankStatementFile.findOneAndUpdate(
        { periodo: targetPeriodo, entidad, nombreArchivo: fileName },
        {
          $set: {
            periodo: targetPeriodo,
            entidad,
            nombreArchivo: fileName,
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

    // Facturas que apuntaban a movimientos que desaparecieron al re-subir
    const affectedScopes = await releaseInvoicesLinkedToMovements(removedMovementIds);

    const { summary } = await runReconciliationForPeriod(targetPeriodo, entidad);
    await runReconciliationForScopes(affectedScopes, [{ periodo: targetPeriodo, entidad }]);

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
    return sendError(res, err, 'Error procesando estados de cuenta:');
  }
});

// 7. Eliminar un estado de cuenta especifico y recalcular conciliacion
router.delete('/bank-statement/:id', async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Identificador de estado de cuenta invalido.' });
    }

    const fileDoc = await BankStatementFile.findById(req.params.id);
    if (!fileDoc) {
      return res.status(404).json({ success: false, message: 'Estado de cuenta no encontrado.' });
    }

    const { periodo, nombreArchivo } = fileDoc;
    const targetEntidad = fileDoc.entidad || DEFAULT_ENTIDAD;

    // Si el mismo archivo esta registrado tambien en otro mes, borrar solo los movimientos de este mes
    const otherRecords = await BankStatementFile.countDocuments({
      entidad: targetEntidad,
      nombreArchivo,
      _id: { $ne: fileDoc._id }
    });
    const movementFilter =
      otherRecords > 0
        ? { archivoOrigen: nombreArchivo, entidad: targetEntidad, ...ownedByUpload(periodo) }
        : { archivoOrigen: nombreArchivo, entidad: targetEntidad };

    const movementIds = await BankMovement.distinct('_id', movementFilter);

    await BankStatementFile.deleteOne({ _id: fileDoc._id });
    const deletedMvs = await BankMovement.deleteMany(movementFilter);

    // Facturas (manuales o de otros meses) que estaban pagadas con los movimientos eliminados
    const affectedScopes = await releaseInvoicesLinkedToMovements(movementIds);

    const { summary } = await runReconciliationForPeriod(periodo, targetEntidad);
    await runReconciliationForScopes(affectedScopes, [{ periodo, entidad: targetEntidad }]);

    const bankStatements = await BankStatementFile.find({ periodo, entidad: targetEntidad }).sort({ createdAt: -1 }).lean();

    return res.json({
      success: true,
      message: `Se elimino el archivo "${nombreArchivo}" y sus ${deletedMvs.deletedCount} movimientos asociados. Conciliacion recalculada.`,
      bankStatements,
      summary
    });
  } catch (err) {
    return sendError(res, err);
  }
});

// 8. Consultar unicamente los estados de cuenta subidos de un mes y entidad
router.get('/bank-statements', async (req, res) => {
  try {
    const periodo = readPeriodo(req.query.periodo);
    const entidad = readEntidad(req.query.entidad);
    const bankStatements = await BankStatementFile.find({ periodo, entidad }).sort({ createdAt: -1 }).lean();
    return res.json({ success: true, bankStatements });
  } catch (err) {
    return sendError(res, err);
  }
});

// 9. Actualizar manualmente estado de pago y observaciones de una factura
router.patch('/invoice/:uuid', async (req, res) => {
  try {
    const uuid = normUuid(req.params.uuid);
    const { estadoPago, observaciones, resetAuto, movimientoId, desvincularPago, pagoManual } = req.body;

    if (estadoPago && !ESTADOS_PAGO.includes(estadoPago)) {
      return res.status(400).json({ success: false, message: `Estado de pago invalido "${estadoPago}".` });
    }
    if (movimientoId && !isObjectId(movimientoId)) {
      return res.status(400).json({ success: false, message: 'Identificador de movimiento invalido.' });
    }
    if (observaciones !== undefined && observaciones !== null && typeof observaciones !== 'string') {
      return res.status(400).json({ success: false, message: 'Las observaciones deben ser texto.' });
    }

    const invoice = await Invoice.findOne({ uuid });
    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Factura no encontrada.' });
    }

    if (resetAuto) {
      // Liberar movimiento bancario si tenia uno asociado
      if (invoice.pagoAsociado?.movimientoId) {
        await BankMovement.findByIdAndUpdate(invoice.pagoAsociado.movimientoId, { $set: RESET_MOVEMENT });
      }
      // Liberar Nota de Credito si tenia una asociada
      if (invoice.egresoAsociado?.uuid) {
        await releaseEgreso(invoice.egresoAsociado.uuid);
        invoice.egresoAsociado = null;
      }
      // Si esta factura es una Nota de Credito aplicada a un ingreso, liberar el ingreso
      if (invoice.ingresoAsociado?.uuid) {
        await releaseIngresoFromEgreso(invoice.ingresoAsociado.uuid, invoice.uuid);
        invoice.ingresoAsociado = null;
      }
      invoice.pagoAsociado = null;
      invoice.editadoManualmente = false;
      if (invoice.estadoSat !== 'Cancelado') invoice.estadoPago = 'No Pagada';
      if (observaciones !== undefined && observaciones !== null) {
        invoice.observaciones = observaciones;
      }
      await invoice.save();

      // Recalcular conciliacion para este periodo y entidad
      await runReconciliationForPeriod(invoice.periodo, invoice.entidad || DEFAULT_ENTIDAD);
      const updated = await Invoice.findOne({ uuid }).lean();

      return res.json({
        success: true,
        message: 'Factura restablecida al calculo automatico.',
        invoice: updated
      });
    }

    // Desvincular pago si se solicita
    if (desvincularPago && invoice.pagoAsociado?.movimientoId) {
      await BankMovement.findByIdAndUpdate(invoice.pagoAsociado.movimientoId, { $set: RESET_MOVEMENT });
      invoice.pagoAsociado = null;
      invoice.estadoPago = 'No Pagada';
      invoice.editadoManualmente = false;
    }

    // Vincular con movimiento bancario si se especifico movimientoId
    if (movimientoId) {
      const movement = await BankMovement.findById(movimientoId);
      if (!movement) {
        return res.status(404).json({ success: false, message: 'Movimiento bancario no encontrado.' });
      }
      await applyManualMovementLink(invoice, movement);
    } else if (pagoManual) {
      // Pago manual sin movimiento bancario: liberar el movimiento que tuviera
      if (invoice.pagoAsociado?.movimientoId) {
        await BankMovement.findByIdAndUpdate(invoice.pagoAsociado.movimientoId, { $set: RESET_MOVEMENT });
      }
      const monto = Number(pagoManual.monto || invoice.total);
      invoice.estadoPago = 'Pagada';
      invoice.editadoManualmente = true;
      invoice.fechaEdicionManual = new Date();
      invoice.pagoAsociado = {
        movimientoId: null,
        banco: pagoManual.banco || 'Pago Manual / Directo',
        fechaPago: pagoManual.fechaPago || dateOnly(invoice.fechaEmision) || new Date().toISOString().split('T')[0],
        montoRetiro: Number.isFinite(monto) ? monto : invoice.total,
        diferencia: Number.isFinite(monto) ? round2(Math.abs(monto - (invoice.total || 0))) : 0.0,
        conceptoBanco: pagoManual.concepto || 'Marcada como pagada manualmente',
        referencia: pagoManual.referencia || ''
      };
    } else if (estadoPago) {
      // Si cambia a no pagada o cancelada y tenia movimiento, liberarlo
      if (estadoPago !== 'Pagada' && invoice.pagoAsociado?.movimientoId) {
        await BankMovement.findByIdAndUpdate(invoice.pagoAsociado.movimientoId, { $set: RESET_MOVEMENT });
        invoice.pagoAsociado = null;
      }
      invoice.estadoPago = estadoPago;
      invoice.editadoManualmente = true;
      invoice.fechaEdicionManual = new Date();
    }

    if (observaciones !== undefined && observaciones !== null) {
      invoice.observaciones = observaciones;
    }

    await invoice.save();

    return res.json({
      success: true,
      message: 'Factura actualizada exitosamente.',
      invoice
    });
  } catch (err) {
    return sendError(res, err, 'Error actualizando factura:');
  }
});

// 10. Exportar reporte en CSV
/** Celda CSV segura: escapa comillas y neutraliza formulas (=, +, -, @) que Excel ejecutaria */
const csvText = (value) => {
  let s = value === undefined || value === null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};
const csvMoney = (value) => (Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value).toFixed(2) : '');

router.get('/export-csv', async (req, res) => {
  try {
    const periodo = readPeriodo(req.query.periodo);
    const entidad = readEntidad(req.query.entidad);

    const [invoices, rawBankMovements] = await Promise.all([
      Invoice.find({ periodo, entidad }).sort({ fechaEmision: 1 }).lean(),
      BankMovement.find({ ...movementScope(periodo, entidad), tipo: 'Retiro' }).lean()
    ]);

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
      csvText(inv.uuid),
      csvText(inv.rfcEmisor),
      csvText(inv.emisor),
      csvText(inv.fechaEmision),
      csvMoney(inv.total || 0),
      csvText(inv.estadoSat),
      csvText(inv.efecto),
      csvText(inv.estadoPago),
      csvText(inv.editadoManualmente ? 'Si' : 'No'),
      csvText(inv.pagoAsociado?.fechaPago),
      inv.pagoAsociado?.montoRetiro ? csvMoney(inv.pagoAsociado.montoRetiro) : '',
      csvText(inv.pagoAsociado?.conceptoBanco),
      csvText(inv.observaciones)
    ]);

    // Mismo criterio que la tabla del panel (incluye movimientos del archivo del mes con fecha en el mes siguiente)
    const unmatchedBankMovements = filterUnmatchedMovements(sortMovementsDesc(rawBankMovements), invoices);

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
      csvText(m.fecha),
      csvText(m.banco),
      csvText(m.cuenta),
      csvText(m.concepto),
      csvText(m.rfcDetectado),
      csvMoney(m.monto || 0),
      csvText(m.categoria),
      csvText(m.observaciones)
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

    // Nombre de archivo seguro para cabeceras HTTP (acentos y comillas romperian la cabecera)
    const fileName = `Conciliacion_${entidad}_${periodo}.csv`;
    const asciiName = fileName
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^\w.\- ]/g, '_');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
    );
    return res.send('﻿' + csvContent);
  } catch (err) {
    return sendError(res, err);
  }
});

module.exports = router;
