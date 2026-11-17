/**
 * Servicio para el listado general y subida individual de facturas (/api/invoices).
 */

const defaultInvoiceRepo = require('../repositories/invoiceRepository');
const { uploadPdf: defaultUploadPdf } = require('../config/r2');
const { round2 } = require('../utils/money');
const { httpError } = require('../utils/errors');

const createInvoiceService = ({
  invoiceRepo = defaultInvoiceRepo,
  uploadPdf = defaultUploadPdf
} = {}) => {
  const memoryInvoices = [];

  const listInvoices = async () => {
    if (invoiceRepo.isConnected()) {
      const invoices = await invoiceRepo.findAllSorted();
      return { success: true, count: invoices.length, data: invoices };
    }
    return { success: true, count: memoryInvoices.length, data: memoryInvoices };
  };

  const uploadInvoicePdf = async ({ file, body = {} }) => {
    if (!file) {
      throw httpError(400, 'Debe adjuntar un archivo PDF.');
    }

    const uuid = String(body.uuid || body.folio || '').trim().toUpperCase();
    const emisor = String(body.emisor || '').trim();
    const rfcEmisor = String(body.rfcEmisor || '').trim().toUpperCase();
    const total = Number(body.total);
    const fechaEmision = String(body.fechaEmision || body.fecha || '').trim();

    const missing = [];
    if (!uuid) missing.push('uuid');
    if (!emisor) missing.push('emisor');
    if (!rfcEmisor) missing.push('rfcEmisor');
    if (!Number.isFinite(total)) missing.push('total');
    if (!/^\d{4}-\d{2}-\d{2}/.test(fechaEmision)) missing.push('fechaEmision (AAAA-MM-DD)');
    if (missing.length > 0) {
      throw httpError(400, `Faltan o son invalidos los campos: ${missing.join(', ')}.`);
    }

    const uploadResult = await uploadPdf(file);

    const data = {
      uuid,
      periodo: body.periodo || fechaEmision.substring(0, 7),
      entidad: body.entidad || 'Personal',
      emisor,
      rfcEmisor,
      total: round2(total),
      fechaEmision,
      observaciones: `PDF: ${uploadResult.url}`
    };

    if (invoiceRepo.isConnected()) {
      const existing = await invoiceRepo.findByUuid(uuid, { lean: true });
      if (existing) {
        throw httpError(409, `Ya existe una factura con el UUID ${uuid}.`);
      }
      const saved = await invoiceRepo.create(data);
      return {
        status: 201,
        body: {
          success: true,
          message: `Factura ${uuid} procesada y guardada exitosamente en ${uploadResult.storage.toUpperCase()}.`,
          invoice: saved
        }
      };
    }

    const memItem = { _id: `inv_${Date.now()}`, ...data, pdfUrl: uploadResult.url, storage: uploadResult.storage };
    memoryInvoices.unshift(memItem);

    return {
      status: 201,
      body: {
        success: true,
        message: `Factura procesada y guardada en memoria local (${uploadResult.storage}).`,
        invoice: memItem
      }
    };
  };

  return {
    listInvoices,
    uploadInvoicePdf
  };
};

const defaultService = createInvoiceService();

module.exports = {
  createInvoiceService,
  ...defaultService
};
