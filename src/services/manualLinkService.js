/**
 * Servicio de enlaces manuales entre facturas y movimientos bancarios,
 * registro manual de facturas y edicion de estado de pago/observaciones.
 */

const defaultInvoiceRepo = require('../repositories/invoiceRepository');
const defaultBankMovementRepo = require('../repositories/bankMovementRepository');
const defaultReconciliationService = require('./reconciliationService');
const defaultEgresoService = require('./egresoService');
const { createJointGroupReleaser } = require('./jointGroup');
const { parseFlexibleDate, dateOnly, formatIsoDate } = require('../utils/dates');
const { diffAmount } = require('../utils/money');
const { normUuid, isObjectId } = require('../utils/text');
const { httpError } = require('../utils/errors');

const { DEFAULT_ENTIDAD, readPeriodo, readEntidad } = defaultReconciliationService;

const MAX_BULK_MANUAL_PAID = 500;
const DEFAULT_BULK_NOTE = 'PAGADO EN EFECTIVO';

const buildPagoFromMovement = (movement, invoiceTotal) => ({
  movimientoId: movement._id,
  banco: movement.banco || 'Banco',
  fechaPago: movement.fecha,
  montoRetiro: movement.monto,
  diferencia: diffAmount(movement.monto, invoiceTotal),
  conceptoBanco: movement.concepto,
  referencia: movement.origenReferencia || ''
});

const createManualLinkService = ({
  invoiceRepo = defaultInvoiceRepo,
  bankMovementRepo = defaultBankMovementRepo,
  reconciliationService = defaultReconciliationService,
  egresoService = defaultEgresoService,
  clock = () => new Date()
} = {}) => {
  const { releaseJointGroup } = createJointGroupReleaser({ invoiceRepo, bankMovementRepo });

  const applyManualMovementLink = async (invoice, movement) => {
    // Si la factura era parte de un pago conjunto, el grupo entero se libera
    await releaseJointGroup(invoice);

    if (invoice.pagoAsociado?.movimientoId && String(invoice.pagoAsociado.movimientoId) !== String(movement._id)) {
      await bankMovementRepo.releaseById(invoice.pagoAsociado.movimientoId);
    }

    if (movement.facturaUuid && movement.facturaUuid !== invoice.uuid) {
      await invoiceRepo.releaseByUuidAndMovement(movement.facturaUuid, movement._id);
    }
    await invoiceRepo.releaseOtherInvoicesFromMovement(movement._id, invoice.uuid);

    if (invoice.egresoAsociado?.uuid) {
      await egresoService.releaseEgreso(invoice.egresoAsociado.uuid);
      invoice.egresoAsociado = null;
    }

    invoice.estadoPago = 'Pagada';
    invoice.editadoManualmente = true;
    invoice.fechaEdicionManual = clock();
    invoice.asignacionAutomatica = null;
    invoice.pagoAsociado = buildPagoFromMovement(movement, invoice.total);

    movement.conciliado = true;
    movement.facturaUuid = invoice.uuid;
    await bankMovementRepo.save(movement);
  };

  const linkManual = async ({ movimientoId, invoiceUuid: rawInvoiceUuid, observaciones }) => {
    const invoiceUuid = normUuid(rawInvoiceUuid);
    if (!movimientoId || !invoiceUuid) {
      throw httpError(400, 'Debe especificar movimientoId e invoiceUuid.');
    }
    if (!isObjectId(movimientoId)) {
      throw httpError(400, 'Identificador de movimiento invalido.');
    }

    const [movement, invoice] = await Promise.all([
      bankMovementRepo.findById(movimientoId),
      invoiceRepo.findByUuid(invoiceUuid)
    ]);
    if (!movement) {
      throw httpError(404, 'Movimiento bancario no encontrado.');
    }
    if (!invoice) {
      throw httpError(404, 'Factura no encontrada.');
    }

    await applyManualMovementLink(invoice, movement);

    if (typeof observaciones === 'string' && observaciones.trim()) {
      invoice.observaciones = observaciones.trim();
    } else if (!invoice.observaciones || invoice.observaciones === 'Sin observaciones') {
      invoice.observaciones = `Vinculado manualmente a retiro de ${movement.banco || 'Banco'} ($${(movement.monto || 0).toFixed(2)})`;
    }
    await invoiceRepo.save(invoice);

    return { invoice, movement };
  };

  const unlinkManual = async ({ movimientoId, invoiceUuid: rawInvoiceUuid }) => {
    const invoiceUuid = normUuid(rawInvoiceUuid);
    if (!movimientoId && !invoiceUuid) {
      throw httpError(400, 'Debe especificar movimientoId o invoiceUuid.');
    }
    if (!invoiceUuid && !isObjectId(movimientoId)) {
      throw httpError(400, 'Identificador de movimiento invalido.');
    }

    let targetInvoice = null;
    let targetMovement = null;

    if (invoiceUuid) {
      targetInvoice = await invoiceRepo.findByUuid(invoiceUuid);
      if (targetInvoice && targetInvoice.pagoAsociado?.movimientoId) {
        targetMovement = await bankMovementRepo.findById(targetInvoice.pagoAsociado.movimientoId);
      }
    } else {
      targetMovement = await bankMovementRepo.findById(movimientoId);
      if (targetMovement && targetMovement.facturaUuid) {
        targetInvoice = await invoiceRepo.findByUuid(targetMovement.facturaUuid);
      }
    }

    if (targetInvoice) {
      // Pago conjunto: liberar el retiro implica liberar el grupo entero de facturas
      await releaseJointGroup(targetInvoice);
      if (
        targetInvoice.egresoAsociado?.uuid &&
        (!targetInvoice.pagoAsociado?.movimientoId || targetInvoice.asignacionAutomatica?.tipo === 'nota-credito-parcial')
      ) {
        await egresoService.releaseEgreso(targetInvoice.egresoAsociado.uuid);
        targetInvoice.egresoAsociado = null;
      }
      targetInvoice.asignacionAutomatica = null;
      targetInvoice.estadoPago = 'No Pagada';
      targetInvoice.pagoAsociado = null;
      targetInvoice.editadoManualmente = false;
      await invoiceRepo.save(targetInvoice);
    }

    if (targetMovement) {
      targetMovement.conciliado = false;
      targetMovement.facturaUuid = null;
      await bankMovementRepo.save(targetMovement);
    }
  };

  const updateBankMovement = async (id, { observaciones, categoria }) => {
    if (!isObjectId(id)) {
      throw httpError(400, 'Identificador de movimiento invalido.');
    }

    const updateFields = {};
    if (observaciones !== undefined && observaciones !== null) {
      updateFields.observaciones = String(observaciones).trim();
    }
    if (categoria !== undefined && categoria !== null) {
      updateFields.categoria = String(categoria).trim();
    }

    const movement = await bankMovementRepo.updateById(id, updateFields);
    if (!movement) {
      throw httpError(404, 'Movimiento bancario no encontrado.');
    }
    return movement;
  };

  const createManualInvoice = async (payload) => {
    const { periodo: rawPeriodo, entidad, uuid, emisor, rfcEmisor, total, fechaEmision, observaciones, vincularConMovimientoId } =
      payload;

    if (!rawPeriodo || !uuid || !emisor || total === undefined || total === null || total === '') {
      throw httpError(400, 'Faltan campos obligatorios para registrar la factura.');
    }
    const periodo = readPeriodo(rawPeriodo);

    const numericTotal = Number(total);
    if (!Number.isFinite(numericTotal) || numericTotal < 0) {
      throw httpError(400, 'El total de la factura debe ser un numero valido.');
    }

    const cleanUuid = normUuid(uuid);
    const existing = await invoiceRepo.findByUuid(cleanUuid, { lean: true });
    if (existing) {
      throw httpError(400, `Ya existe una factura registrada con el UUID ${cleanUuid}.`);
    }

    let fechaTexto = clock().toISOString().split('.')[0];
    if (fechaEmision) {
      const parsed = parseFlexibleDate(fechaEmision);
      if (!parsed) {
        throw httpError(400, 'Fecha de emision invalida.');
      }
      fechaTexto = formatIsoDate(parsed);
    }

    let movement = null;
    if (vincularConMovimientoId) {
      if (!isObjectId(vincularConMovimientoId)) {
        throw httpError(400, 'Identificador de movimiento invalido.');
      }
      movement = await bankMovementRepo.findById(vincularConMovimientoId);
      if (!movement) {
        throw httpError(404, 'Movimiento bancario no encontrado.');
      }
    }

    const data = {
      uuid: cleanUuid,
      periodo,
      entidad: readEntidad(entidad),
      emisor: String(emisor).trim(),
      rfcEmisor: String(rfcEmisor || '').trim().toUpperCase() || 'XAXX010101000',
      total: numericTotal,
      fechaEmision: fechaTexto,
      efecto: 'Ingreso',
      estadoSat: 'Vigente',
      estadoPago: 'No Pagada',
      pagoAsociado: null,
      observaciones: typeof observaciones === 'string' && observaciones.trim() ? observaciones.trim() : 'Factura registrada manualmente',
      editadoManualmente: true,
      fechaEdicionManual: clock()
    };

    const newInvoice = await invoiceRepo.createValidatedAndSave(data, async (doc) => {
      if (movement) {
        await applyManualMovementLink(doc, movement);
      }
    });

    return { cleanUuid, invoice: newInvoice };
  };

  const updateInvoice = async (rawUuid, payload) => {
    const uuid = normUuid(rawUuid);
    const { estadoPago, observaciones, resetAuto, movimientoId, desvincularPago, pagoManual } = payload;

    const allowedEstados = invoiceRepo.getAllowedEstadosPago();
    if (estadoPago && !allowedEstados.includes(estadoPago)) {
      throw httpError(400, `Estado de pago invalido "${estadoPago}".`);
    }
    if (movimientoId && !isObjectId(movimientoId)) {
      throw httpError(400, 'Identificador de movimiento invalido.');
    }
    if (observaciones !== undefined && observaciones !== null && typeof observaciones !== 'string') {
      throw httpError(400, 'Las observaciones deben ser texto.');
    }

    const invoice = await invoiceRepo.findByUuid(uuid);
    if (!invoice) {
      throw httpError(404, 'Factura no encontrada.');
    }

    // Editar a mano una factura de un pago conjunto libera el grupo entero (retiro y demas facturas)
    const changesPayment = Boolean(resetAuto || desvincularPago || movimientoId || pagoManual || estadoPago);
    const jointMovementId = invoice.pagoConjunto?.uuids?.length ? invoice.pagoAsociado?.movimientoId : null;
    if (changesPayment) await releaseJointGroup(invoice);

    if (resetAuto) {
      if (invoice.pagoAsociado?.movimientoId) {
        await bankMovementRepo.releaseById(invoice.pagoAsociado.movimientoId);
      }
      if (invoice.egresoAsociado?.uuid) {
        await egresoService.releaseEgreso(invoice.egresoAsociado.uuid);
        invoice.egresoAsociado = null;
      }
      if (invoice.ingresoAsociado?.uuid) {
        await egresoService.releaseIngresoFromEgreso(invoice.ingresoAsociado.uuid, invoice.uuid);
        invoice.ingresoAsociado = null;
      }
      invoice.pagoAsociado = null;
      invoice.asignacionAutomatica = null;
      invoice.rechazoAsignacionAutomatica = false;
      invoice.editadoManualmente = false;
      if (invoice.estadoSat !== 'Cancelado') invoice.estadoPago = 'No Pagada';
      if (observaciones !== undefined && observaciones !== null) {
        invoice.observaciones = observaciones;
      }
      await invoiceRepo.save(invoice);

      await reconciliationService.runReconciliationForPeriod(invoice.periodo, invoice.entidad || DEFAULT_ENTIDAD);
      const updated = await invoiceRepo.findByUuid(uuid, { lean: true });
      return { resetAuto: true, invoice: updated };
    }

    if (desvincularPago && invoice.pagoAsociado?.movimientoId) {
      await bankMovementRepo.releaseById(invoice.pagoAsociado.movimientoId);
      invoice.pagoAsociado = null;
      invoice.estadoPago = 'No Pagada';
      invoice.editadoManualmente = false;
    }

    if (movimientoId) {
      const movement = await bankMovementRepo.findById(movimientoId);
      if (!movement) {
        throw httpError(404, 'Movimiento bancario no encontrado.');
      }
      await applyManualMovementLink(invoice, movement);
    } else if (pagoManual) {
      if (invoice.pagoAsociado?.movimientoId) {
        await bankMovementRepo.releaseById(invoice.pagoAsociado.movimientoId);
      }
      const monto = Number(pagoManual.monto || invoice.total);
      invoice.estadoPago = 'Pagada';
      invoice.editadoManualmente = true;
      invoice.fechaEdicionManual = clock();
      invoice.pagoAsociado = {
        movimientoId: null,
        banco: pagoManual.banco || 'Pago Manual / Directo',
        fechaPago: pagoManual.fechaPago || dateOnly(invoice.fechaEmision) || clock().toISOString().split('T')[0],
        montoRetiro: Number.isFinite(monto) ? monto : invoice.total,
        diferencia: Number.isFinite(monto) ? diffAmount(monto, invoice.total) : 0.0,
        conceptoBanco: pagoManual.concepto || 'Marcada como pagada manualmente',
        referencia: pagoManual.referencia || ''
      };
    } else if (estadoPago) {
      if (estadoPago !== 'Pagada' && invoice.pagoAsociado?.movimientoId) {
        await bankMovementRepo.releaseById(invoice.pagoAsociado.movimientoId);
        invoice.pagoAsociado = null;
      }
      invoice.estadoPago = estadoPago;
      invoice.editadoManualmente = true;
      invoice.fechaEdicionManual = clock();
    }

    if (observaciones !== undefined && observaciones !== null) {
      invoice.observaciones = observaciones;
    }

    // Marcada como pagada a mano sin cambiar de retiro: ya no es parte del pago conjunto, su pago no es el retiro
    if (
      jointMovementId &&
      invoice.estadoPago === 'Pagada' &&
      String(invoice.pagoAsociado?.movimientoId || '') === String(jointMovementId)
    ) {
      invoice.pagoAsociado = null;
    }

    await invoiceRepo.save(invoice);
    return { resetAuto: false, invoice };
  };

  /**
   * Marca como pagadas en efectivo varias facturas de Ingreso No Pagada (igual que la edicion manual
   * PATCH /invoice/:uuid con estadoPago 'Pagada'). Ignora las que no sean Ingreso No Pagada.
   */
  const bulkMarkPaidManual = async ({ uuids, nota } = {}) => {
    if (!Array.isArray(uuids) || uuids.length === 0) {
      throw httpError(400, 'Debe especificar la lista de uuids de las facturas.');
    }
    if (uuids.length > MAX_BULK_MANUAL_PAID) {
      throw httpError(400, `Solo se permiten ${MAX_BULK_MANUAL_PAID} facturas por solicitud.`);
    }
    if (nota !== undefined && nota !== null && typeof nota !== 'string') {
      throw httpError(400, 'La nota debe ser texto.');
    }

    const observaciones = (typeof nota === 'string' && nota.trim()) || DEFAULT_BULK_NOTE;
    const cleanUuids = Array.from(new Set(uuids.filter((u) => typeof u === 'string').map(normUuid).filter(Boolean)));

    let actualizadas = 0;
    for (const uuid of cleanUuids) {
      const invoice = await invoiceRepo.findByUuid(uuid);
      if (!invoice || (invoice.efecto || 'Ingreso') !== 'Ingreso') continue;
      if (invoice.estadoPago !== 'No Pagada' || invoice.estadoSat === 'Cancelado') continue;
      await updateInvoice(uuid, {
        estadoPago: 'Pagada',
        observaciones,
        // pagoAsociado debe quedar en null aunque hubiera un resto de un retiro ya liberado
        desvincularPago: Boolean(invoice.pagoAsociado?.movimientoId)
      });
      actualizadas++;
    }
    return { actualizadas };
  };

  return {
    applyManualMovementLink,
    linkManual,
    unlinkManual,
    updateBankMovement,
    createManualInvoice,
    updateInvoice,
    bulkMarkPaidManual
  };
};

const defaultService = createManualLinkService();

module.exports = {
  MAX_BULK_MANUAL_PAID,
  buildPagoFromMovement,
  createManualLinkService,
  ...defaultService
};
