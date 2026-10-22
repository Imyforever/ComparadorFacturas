const { PDFParse } = require('pdf-parse');

/**
 * Parsea un archivo PDF de Consulta CFDI del SAT
 * @param {Buffer} pdfBuffer - Buffer del archivo PDF
 * @returns {Promise<{invoices: Array<Object>, detectedPeriod: string}>} Facturas parseadas y mes detectado
 */
const parseCfdiReport = async (pdfBuffer) => {
  const parser = new PDFParse({ data: pdfBuffer });
  const result = await parser.getText();
  const text = result.text;

  const blocks = text.split(/Folio Fiscal:\s*/i).filter((b) => b.trim().length > 0);
  const invoices = [];
  const periodCounts = {};

  for (const block of blocks) {
    const uuidMatch = block.match(/^([A-Fa-f0-9-]{36})/);
    if (!uuidMatch) continue;

    const uuid = uuidMatch[1].trim().toUpperCase();

    const rfcEmisorMatch = block.match(/RFC Emisor:\s*([A-Z0-9&Ñ]+)/i);
    const emisorMatch = block.match(/RFC Emisor:\s*[A-Z0-9&Ñ]+\s+Nombre o Razón Social:\s*([^\n\r\t]+)/i);

    const rfcReceptorMatch = block.match(/RFC Receptor:\s*([A-Z0-9&Ñ]+)/i);
    const receptorMatch = block.match(/RFC Receptor:\s*[A-Z0-9&Ñ]+\s+Nombre o Razón Social:\s*([^\n\r\t]+)/i);

    const fechaEmisionMatch = block.match(/Fecha Emisión:\s*(\S+)/i);
    const fechaCertMatch = block.match(/Fecha Certificación:\s*(\S+)/i);

    const totalMatch = block.match(/Total:\s*\$?([0-9,]+(?:\.[0-9]{2})?)/i);
    const pacMatch = block.match(/PAC que Certificó:\s*([^\n\r\t]+)/i);

    const estadoMatch = block.match(/Estado del Comprobante:\s*([^\n\r]+?)(?=\s*Efecto|\s*$)/i);
    const efectoMatch = block.match(/Efecto del Comprobante:\s*([^\n\r]+)/i);

    const rawFecha = fechaEmisionMatch ? fechaEmisionMatch[1].trim() : '';
    let periodo = '';
    if (rawFecha.length >= 7) {
      periodo = rawFecha.substring(0, 7); // Formato "2026-09"
      periodCounts[periodo] = (periodCounts[periodo] || 0) + 1;
    }

    const rawTotal = totalMatch ? parseFloat(totalMatch[1].replace(/,/g, '')) : 0;
    const rawEstado = estadoMatch ? estadoMatch[1].trim() : 'Vigente';
    const isCancelada = /cancelad/i.test(rawEstado);

    let rawEfecto = efectoMatch ? efectoMatch[1].trim() : 'Ingreso';
    let efectoNormalizado = 'Ingreso';
    if (/egreso/i.test(rawEfecto)) efectoNormalizado = 'Egreso';
    else if (/pago/i.test(rawEfecto)) efectoNormalizado = 'Pago';
    else if (/n[oó]mina/i.test(rawEfecto)) efectoNormalizado = 'Nomina';

    invoices.push({
      uuid,
      periodo: periodo || '2026-09',
      emisor: emisorMatch ? emisorMatch[1].trim() : (rfcEmisorMatch ? rfcEmisorMatch[1] : 'Emisor no identificado'),
      rfcEmisor: rfcEmisorMatch ? rfcEmisorMatch[1].trim().toUpperCase() : '',
      receptor: receptorMatch ? receptorMatch[1].trim() : '',
      rfcReceptor: rfcReceptorMatch ? rfcReceptorMatch[1].trim().toUpperCase() : '',
      fechaEmision: rawFecha,
      fechaCertificacion: fechaCertMatch ? fechaCertMatch[1].trim() : '',
      total: isNaN(rawTotal) ? 0 : rawTotal,
      pac: pacMatch ? pacMatch[1].trim() : '',
      estadoSat: isCancelada ? 'Cancelado' : 'Vigente',
      efecto: efectoNormalizado,
      estadoPago: isCancelada ? 'Cancelada' : 'No Pagada'
    });
  }

  // Determinar el periodo principal detectado
  let detectedPeriod = '';
  let maxCount = 0;
  for (const [p, count] of Object.entries(periodCounts)) {
    if (count > maxCount) {
      maxCount = count;
      detectedPeriod = p;
    }
  }

  return {
    invoices,
    detectedPeriod: detectedPeriod || '2026-09'
  };
};

module.exports = {
  parseCfdiReport
};
