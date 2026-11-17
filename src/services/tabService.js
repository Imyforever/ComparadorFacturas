/**
 * Servicio de administracion de periodos y pestanias (cuentas/entidades por mes).
 */

const defaultAccountTabRepo = require('../repositories/accountTabRepository');
const defaultInvoiceRepo = require('../repositories/invoiceRepository');
const defaultBankMovementRepo = require('../repositories/bankMovementRepository');
const defaultBankStatementRepo = require('../repositories/bankStatementRepository');
const defaultReconciliationService = require('./reconciliationService');
const { PERIODO_REGEX } = require('../utils/dates');
const { httpError } = require('../utils/errors');

const MAX_TAB_NAME_LENGTH = 40;
const { DEFAULT_PERIODO, DEFAULT_ENTIDAD, readPeriodo } = defaultReconciliationService;

const createTabService = ({
  accountTabRepo = defaultAccountTabRepo,
  invoiceRepo = defaultInvoiceRepo,
  bankMovementRepo = defaultBankMovementRepo,
  bankStatementRepo = defaultBankStatementRepo,
  reconciliationService = defaultReconciliationService
} = {}) => {
  const ensureDefaultTabs = async (periodo) => {
    const [totalTabs, distinctEntities] = await Promise.all([
      accountTabRepo.countByPeriodo(periodo),
      invoiceRepo.distinctEntidadesByPeriodo(periodo)
    ]);

    if (totalTabs === 0 && distinctEntities.length === 0) {
      try {
        await accountTabRepo.create({ periodo, nombre: DEFAULT_ENTIDAD });
      } catch (err) {
        if (err.code !== 11000) throw err;
      }
    }

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
      await accountTabRepo.bulkWrite(tabOps, { ordered: false });
    }
  };

  const listPeriodos = async () => {
    const [fromInvoices, fromTabs, fromStatements] = await Promise.all([
      invoiceRepo.distinctPeriodos(),
      accountTabRepo.distinctPeriodos(),
      bankStatementRepo.distinctPeriodos()
    ]);
    const sorted = Array.from(new Set([...fromInvoices, ...fromTabs, ...fromStatements]))
      .filter((p) => PERIODO_REGEX.test(p))
      .sort()
      .reverse();
    return sorted.length ? sorted : [DEFAULT_PERIODO];
  };

  const listTabs = async (rawPeriodo) => {
    const periodo = readPeriodo(rawPeriodo);
    await ensureDefaultTabs(periodo);

    const [tabs, invoiceCounts, fileCounts] = await Promise.all([
      accountTabRepo.findByPeriodo(periodo),
      invoiceRepo.countByEntidadInPeriodo(periodo),
      bankStatementRepo.countByEntidadInPeriodo(periodo)
    ]);

    const invMap = new Map(invoiceCounts.map((c) => [c._id, c.n]));
    const fileMap = new Map(fileCounts.map((c) => [c._id, c.n]));

    return tabs.map((t) => ({
      ...t,
      facturasCount: invMap.get(t.nombre) || 0,
      bankFilesCount: fileMap.get(t.nombre) || 0
    }));
  };

  const createTab = async ({ periodo: rawPeriodo, nombre }) => {
    if (!rawPeriodo || typeof nombre !== 'string' || !nombre.trim()) {
      throw httpError(400, 'El nombre de la pestania es obligatorio.');
    }
    const periodo = readPeriodo(rawPeriodo);
    const cleanName = nombre.trim().replace(/\s+/g, ' ');
    if (cleanName.length > MAX_TAB_NAME_LENGTH) {
      throw httpError(400, `El nombre no puede exceder ${MAX_TAB_NAME_LENGTH} caracteres.`);
    }

    const existing = await accountTabRepo.findOne(periodo, cleanName, { lean: true });
    if (existing) {
      throw httpError(400, `Ya existe una pestania llamada "${cleanName}" en este mes.`);
    }

    try {
      const tab = await accountTabRepo.create({ periodo, nombre: cleanName });
      return { cleanName, tab };
    } catch (err) {
      if (err.code === 11000) {
        throw httpError(400, `Ya existe una pestania llamada "${cleanName}" en este mes.`);
      }
      throw err;
    }
  };

  const renameTab = async ({ periodo: rawPeriodo, oldNombre, newNombre }) => {
    if (!rawPeriodo || !oldNombre || typeof newNombre !== 'string' || !newNombre.trim()) {
      throw httpError(400, 'Datos incompletos para renombrar la pestania.');
    }
    const periodo = readPeriodo(rawPeriodo);
    const cleanNew = newNombre.trim().replace(/\s+/g, ' ');
    if (oldNombre === cleanNew) {
      return { unchanged: true, cleanNew };
    }
    if (cleanNew.length > MAX_TAB_NAME_LENGTH) {
      throw httpError(400, `El nombre no puede exceder ${MAX_TAB_NAME_LENGTH} caracteres.`);
    }

    const tab = await accountTabRepo.findOne(periodo, oldNombre);
    if (!tab) {
      throw httpError(404, 'Pestania no encontrada.');
    }

    const collision = await accountTabRepo.findOne(periodo, cleanNew, { lean: true });
    if (collision) {
      throw httpError(400, `Ya existe una pestania llamada "${cleanNew}".`);
    }

    tab.nombre = cleanNew;
    await accountTabRepo.save(tab);

    await Promise.all([
      invoiceRepo.renameEntidad(periodo, oldNombre, cleanNew),
      bankMovementRepo.renameEntidadByUpload(periodo, oldNombre, cleanNew),
      bankStatementRepo.renameEntidad(periodo, oldNombre, cleanNew)
    ]);

    await reconciliationService.runReconciliationForPeriod(periodo, cleanNew);
    return { unchanged: false, cleanNew };
  };

  const deleteTab = async ({ periodo: rawPeriodo, nombre }) => {
    if (!rawPeriodo || !nombre) {
      throw httpError(400, 'Datos insuficientes.');
    }
    const periodo = readPeriodo(rawPeriodo);

    const totalTabs = await accountTabRepo.countByPeriodo(periodo);
    if (totalTabs <= 1) {
      throw httpError(400, 'No se puede eliminar la unica pestania activa del mes.');
    }

    const tab = await accountTabRepo.findOne(periodo, nombre, { lean: true });
    if (!tab) {
      throw httpError(404, 'Pestania no encontrada.');
    }

    const [invoiceUuids, movementIds] = await Promise.all([
      invoiceRepo.distinctUuids(periodo, nombre),
      bankMovementRepo.distinctIdsByUpload(periodo, nombre)
    ]);

    await accountTabRepo.deleteById(tab._id);
    const deletedInvoices = await invoiceRepo.deleteByPeriodAndEntity(periodo, nombre);
    const deletedBank = await bankMovementRepo.deleteByUpload(periodo, nombre);
    await bankStatementRepo.deleteByPeriodAndEntity(periodo, nombre);

    await reconciliationService.releaseMovementsLinkedTo(invoiceUuids);
    const affectedScopes = await reconciliationService.releaseInvoicesLinkedToMovements(movementIds);
    await reconciliationService.runReconciliationForScopes(affectedScopes, [{ periodo, entidad: nombre }]);

    return {
      deletedInvoicesCount: deletedInvoices.deletedCount || 0,
      deletedBankCount: deletedBank.deletedCount || 0
    };
  };

  return {
    ensureDefaultTabs,
    listPeriodos,
    listTabs,
    createTab,
    renameTab,
    deleteTab
  };
};

const defaultService = createTabService();

module.exports = {
  MAX_TAB_NAME_LENGTH,
  createTabService,
  ...defaultService
};
