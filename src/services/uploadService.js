/**
 * Servicio de carga y eliminacion de archivos CFDI del SAT y estados de cuenta bancarios.
 */

const defaultInvoiceRepo = require('../repositories/invoiceRepository');
const defaultBankMovementRepo = require('../repositories/bankMovementRepository');
const defaultBankStatementRepo = require('../repositories/bankStatementRepository');
const defaultReconciliationService = require('./reconciliationService');
const { parseCfdiReport } = require('../parsers/sat/cfdiReport');
const { parseBankStatement } = require('../parsers/registry');
const { findDuplicatesOfExisting } = require('./duplicateDetector');
const { toCents, fromCents } = require('../utils/money');
const { computeHuellas, isObjectId } = require('../utils/text');
const { httpError } = require('../utils/errors');

const { DEFAULT_ENTIDAD, readPeriodo, readEntidad } = defaultReconciliationService;

const createUploadService = ({
  invoiceRepo = defaultInvoiceRepo,
  bankMovementRepo = defaultBankMovementRepo,
  bankStatementRepo = defaultBankStatementRepo,
  reconciliationService = defaultReconciliationService,
  clock = () => new Date()
} = {}) => {
  const uploadCfdi = async ({ file, periodo: rawPeriodo, entidad: rawEntidad, replace = false }) => {
    if (!file) {
      throw httpError(400, 'Debe adjuntar el archivo PDF de facturas.');
    }

    const targetPeriodo = readPeriodo(rawPeriodo);
    const entidad = readEntidad(rawEntidad);

    const existingCount = await invoiceRepo.countByPeriodAndEntity(targetPeriodo, entidad);
    if (existingCount > 0 && !replace) {
      throw httpError(
        400,
        `Ya existe un archivo de facturas cargado para "${entidad}" en el mes ${targetPeriodo} (${existingCount} facturas). Solo se permite un archivo por pestania.`,
        { isBlocked: true }
      );
    }

    let parsed;
    try {
      parsed = await parseCfdiReport(file.buffer);
    } catch (parseErr) {
      throw httpError(
        parseErr.status || 400,
        parseErr.status ? parseErr.message : `No se pudo leer el PDF de facturas: ${parseErr.message}`
      );
    }
    const { invoices: parsedInvoices, detectedPeriod } = parsed;

    if (parsedInvoices.length === 0) {
      throw httpError(400, 'No se encontraron registros de Folio Fiscal en el documento.');
    }

    if (detectedPeriod && detectedPeriod !== targetPeriodo) {
      throw httpError(
        400,
        `El archivo contiene facturas correspondientes a ${detectedPeriod} y no coincide con el mes seleccionado (${targetPeriodo}). No se permite subirlo.`
      );
    }

    const uniqueByUuid = new Map();
    for (const inv of parsedInvoices) uniqueByUuid.set(inv.uuid, inv);
    const uuids = Array.from(uniqueByUuid.keys());

    const elsewhere = await invoiceRepo.findElsewhereByUuids(uuids, targetPeriodo, entidad);
    const elsewhereSet = new Set(elsewhere.map((i) => i.uuid));

    const invoicesToSave = Array.from(uniqueByUuid.values()).filter((inv) => !elsewhereSet.has(inv.uuid));

    if (invoicesToSave.length === 0) {
      const sample = elsewhere[0];
      throw httpError(
        400,
        `Todas las facturas de este archivo ya estan registradas en otra pestania o mes (ej. "${sample.entidad}" ${sample.periodo}).`
      );
    }

    const bulkOps = invoicesToSave.map((inv) => {
      const { estadoPago, ...satFields } = inv;
      const isCancelada = inv.estadoSat === 'Cancelado';
      return {
        updateOne: {
          filter: { uuid: inv.uuid },
          update: {
            $set: { ...satFields, periodo: targetPeriodo, entidad, ...(isCancelada ? { estadoPago: 'Cancelada' } : {}) },
            ...(isCancelada ? {} : { $setOnInsert: { estadoPago: estadoPago || 'No Pagada' } })
          },
          upsert: true
        }
      };
    });

    await invoiceRepo.bulkWrite(bulkOps, { ordered: false });
    await reconciliationService.runReconciliationForPeriod(targetPeriodo, entidad);

    const skipped = elsewhereSet.size;
    const skippedMsg =
      skipped > 0 ? ` Se omitieron ${skipped} facturas que ya estaban registradas en otra pestania o mes.` : '';

    return {
      success: true,
      message: `Se procesaron y guardaron ${invoicesToSave.length} facturas para "${entidad}" en el mes ${targetPeriodo}.${skippedMsg}`,
      count: invoicesToSave.length,
      skipped,
      periodo: targetPeriodo,
      entidad
    };
  };

  const deleteCfdi = async ({ periodo: rawPeriodo, entidad: rawEntidad }) => {
    const periodo = readPeriodo(rawPeriodo);
    const entidad = readEntidad(rawEntidad);

    const uuids = await invoiceRepo.distinctUuids(periodo, entidad);
    const deleted = await invoiceRepo.deleteByPeriodAndEntity(periodo, entidad);

    await reconciliationService.releaseMovementsLinkedTo(uuids);
    await invoiceRepo.clearLinksToDeletedUuids(uuids);

    return {
      success: true,
      message: `Se eliminaron ${deleted.deletedCount} facturas de "${entidad}" del mes ${periodo}. Ahora puede subir un nuevo archivo.`
    };
  };

  /** Libera los movimientos que eran duplicado de ids que ya no existen y devuelve los meses afectados */
  const releaseDuplicatesOfMovements = async (entidad, movementIds) => {
    if (typeof bankMovementRepo.releaseDuplicatesOf !== 'function' || !movementIds || movementIds.length === 0) {
      return [];
    }
    const freed = await bankMovementRepo.releaseDuplicatesOf(movementIds);
    const scopes = new Map();
    for (const m of freed) {
      for (const p of [m.periodo, m.archivoPeriodo]) {
        if (p) scopes.set(`${p}|${m.entidad}`, { periodo: p, entidad: m.entidad });
      }
    }
    if (freed.length > 0 && typeof reconciliationService.recomputeStatementStats === 'function') {
      await reconciliationService.recomputeStatementStats(
        entidad,
        Array.from(new Set(freed.map((m) => m.archivoOrigen)))
      );
    }
    return Array.from(scopes.values());
  };

  const uploadBankStatements = async ({ files, periodo: rawPeriodo, entidad: rawEntidad }) => {
    if (!files || files.length === 0) {
      throw httpError(400, 'Debe adjuntar al menos un estado de cuenta.');
    }

    const targetPeriodo = readPeriodo(rawPeriodo);
    const entidad = readEntidad(rawEntidad);
    let totalMovements = 0;
    let duplicatesCount = 0;
    const uploadedResults = [];

    for (const file of files) {
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
        throw httpError(
          400,
          `No se encontraron movimientos en el archivo "${fileName}". Verifique que sea un estado de cuenta compatible (BBVA o Scotiabank). Operacion cancelada.`
        );
      }

      if (!detectedPeriods.includes(targetPeriodo)) {
        throw httpError(
          400,
          `El archivo "${fileName}" corresponde a [${detectedPeriods.join(', ')}] y no contiene movimientos del mes seleccionado (${targetPeriodo}). Operacion cancelada.`
        );
      }

      uploadedResults.push({ file, fileName, movements, banco, cuenta });
    }

    const removedMovementIds = [];

    for (const item of uploadedResults) {
      const { fileName, movements } = item;

      const oldMovs = await bankMovementRepo.findByOwner(entidad, fileName);
      const oldHuellas = computeHuellas(oldMovs);
      const oldByHuella = new Map();
      oldMovs.forEach((m, idx) => oldByHuella.set(m.huella || oldHuellas[idx], m));

      const newHuellas = computeHuellas(movements);

      // Movimientos que ya existen en OTRO archivo de la entidad y cuenta: se guardan como duplicadoDe
      const candidates =
        typeof bankMovementRepo.findDuplicateCandidates === 'function'
          ? await bankMovementRepo.findDuplicateCandidates(entidad, fileName, [
              ...new Set(movements.map((m) => m.fecha))
            ])
          : [];
      const duplicateOf = findDuplicatesOfExisting(movements, candidates);

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
        // Un movimiento ya ligado a una factura no se marca como duplicado (no se le quita su pago)
        if (duplicateOf[idx] && !(doc.conciliado || doc.facturaUuid)) doc.duplicadoDe = duplicateOf[idx];
        return doc;
      });
      const ownMovements = movements.filter((_, idx) => !docsToInsert[idx].duplicadoDe);
      duplicatesCount += movements.length - ownMovements.length;

      for (const m of oldMovs) {
        if (!preservedIds.has(String(m._id))) removedMovementIds.push(m._id);
      }

      await bankMovementRepo.deleteByOwner(entidad, fileName);
      if (docsToInsert.length > 0) {
        await bankMovementRepo.insertMany(docsToInsert);
        totalMovements += ownMovements.length;
      }

      // Las estadisticas del archivo no cuentan los duplicados de otros archivos
      const retiros = ownMovements.filter((m) => m.tipo === 'Retiro');
      const depositos = ownMovements.filter((m) => m.tipo === 'Deposito');
      const totalCargos = fromCents(retiros.reduce((s, m) => s + toCents(m.monto), 0));
      const totalAbonos = fromCents(depositos.reduce((s, m) => s + toCents(m.monto), 0));
      const bancoDetectado = item.banco || movements[0]?.banco || 'Banco';
      const cuentaDetectada = item.cuenta || movements[0]?.cuenta || '';

      await bankStatementRepo.upsertStatement(targetPeriodo, entidad, fileName, {
        periodo: targetPeriodo,
        entidad,
        nombreArchivo: fileName,
        banco: bancoDetectado,
        cuenta: cuentaDetectada,
        totalMovimientos: ownMovements.length,
        cargosCount: retiros.length,
        abonosCount: depositos.length,
        montoCargos: totalCargos,
        montoAbonos: totalAbonos,
        fechaSubida: clock()
      });
    }

    const releasedScopes = await reconciliationService.releaseInvoicesLinkedToMovements(removedMovementIds);
    const freedScopes = await releaseDuplicatesOfMovements(entidad, removedMovementIds);
    const affectedScopes = [...releasedScopes, ...freedScopes];

    const { summary } = await reconciliationService.runReconciliationForPeriod(targetPeriodo, entidad);
    await reconciliationService.runReconciliationForScopes(affectedScopes, [{ periodo: targetPeriodo, entidad }]);

    const bankStatements = await bankStatementRepo.findByPeriodAndEntity(targetPeriodo, entidad);
    const duplicatesMsg =
      duplicatesCount > 0 ? ` Se omitieron ${duplicatesCount} movimientos que ya existian en otro archivo.` : '';

    return {
      success: true,
      message: `Se procesaron exitosamente ${files.length} estado(s) de cuenta para "${entidad}" con ${totalMovements} movimientos bancarios.${duplicatesMsg} Conciliacion actualizada.`,
      totalMovements,
      ...(duplicatesCount > 0 ? { duplicados: duplicatesCount } : {}),
      entidad,
      bankStatements,
      summary
    };
  };

  const deleteBankStatement = async (id) => {
    if (!isObjectId(id)) {
      throw httpError(400, 'Identificador de estado de cuenta invalido.');
    }

    const fileDoc = await bankStatementRepo.findById(id);
    if (!fileDoc) {
      throw httpError(404, 'Estado de cuenta no encontrado.');
    }

    const { periodo, nombreArchivo } = fileDoc;
    const targetEntidad = fileDoc.entidad || DEFAULT_ENTIDAD;

    const otherRecords = await bankStatementRepo.countOtherRecordsForFile(targetEntidad, nombreArchivo, fileDoc._id);
    const scopePeriodo = otherRecords > 0 ? periodo : null;

    const movementIds = await bankMovementRepo.distinctIdsByFile(targetEntidad, nombreArchivo, scopePeriodo);

    await bankStatementRepo.deleteById(fileDoc._id);
    const deletedMvs = await bankMovementRepo.deleteByFile(targetEntidad, nombreArchivo, scopePeriodo);

    const releasedScopes = await reconciliationService.releaseInvoicesLinkedToMovements(movementIds);
    const freedScopes = await releaseDuplicatesOfMovements(targetEntidad, movementIds);
    const affectedScopes = [...releasedScopes, ...freedScopes];

    const { summary } = await reconciliationService.runReconciliationForPeriod(periodo, targetEntidad);
    await reconciliationService.runReconciliationForScopes(affectedScopes, [{ periodo, entidad: targetEntidad }]);

    const bankStatements = await bankStatementRepo.findByPeriodAndEntity(periodo, targetEntidad);

    return {
      success: true,
      message: `Se elimino el archivo "${nombreArchivo}" y sus ${deletedMvs.deletedCount} movimientos asociados. Conciliacion recalculada.`,
      bankStatements,
      summary
    };
  };

  const listBankStatements = async ({ periodo: rawPeriodo, entidad: rawEntidad }) => {
    const periodo = readPeriodo(rawPeriodo);
    const entidad = readEntidad(rawEntidad);
    const bankStatements = await bankStatementRepo.findByPeriodAndEntity(periodo, entidad);
    return { success: true, bankStatements };
  };

  return {
    uploadCfdi,
    deleteCfdi,
    uploadBankStatements,
    deleteBankStatement,
    listBankStatements
  };
};

const defaultService = createUploadService();

module.exports = {
  createUploadService,
  ...defaultService
};
