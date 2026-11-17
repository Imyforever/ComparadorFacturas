/**
 * Servicio de exportacion de conciliacion y movimientos sin factura a formato CSV.
 */

const defaultInvoiceRepo = require('../repositories/invoiceRepository');
const defaultBankMovementRepo = require('../repositories/bankMovementRepository');
const { readPeriodo, readEntidad, sortMovementsDesc, filterUnmatchedMovements } = require('./reconciliationService');
const { csvText, csvMoney } = require('../utils/csv');
const { safeAsciiFileName } = require('../utils/text');

const buildReconciliationCsv = ({ invoices = [], rawBankMovements = [] }) => {
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

  const sortedMovements = sortMovementsDesc([...rawBankMovements]);
  const unmatchedBankMovements = filterUnmatchedMovements(sortedMovements, invoices);

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

  return csvSections.join('\r\n');
};

const createExportService = ({
  invoiceRepo = defaultInvoiceRepo,
  bankMovementRepo = defaultBankMovementRepo
} = {}) => {
  const exportPeriodCsv = async ({ periodo: rawPeriodo, entidad: rawEntidad }) => {
    const periodo = readPeriodo(rawPeriodo);
    const entidad = readEntidad(rawEntidad);

    const [invoices, rawBankMovements] = await Promise.all([
      invoiceRepo.findByPeriodAndEntity(periodo, entidad, { sortByFecha: true }),
      bankMovementRepo.findRetirosInScope(periodo, entidad)
    ]);

    const csvContent = buildReconciliationCsv({ invoices, rawBankMovements });
    const fileName = `Conciliacion_${entidad}_${periodo}.csv`;
    const asciiName = safeAsciiFileName(fileName);

    return {
      fileName,
      asciiName,
      csvContent: `\uFEFF${csvContent}`
    };
  };

  return {
    exportPeriodCsv
  };
};

const defaultService = createExportService();

module.exports = {
  buildReconciliationCsv,
  createExportService,
  ...defaultService
};
