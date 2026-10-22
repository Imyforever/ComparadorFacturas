const { PDFParse } = require('pdf-parse');

/**
 * Extrae el texto de un PDF y libera los recursos de pdf.js al terminar.
 * Sin destroy() cada archivo procesado deja memoria retenida en el proceso.
 * @param {Buffer} pdfBuffer
 * @returns {Promise<string>}
 */
const extractPdfText = async (pdfBuffer) => {
  const parser = new PDFParse({ data: pdfBuffer });
  try {
    const result = await parser.getText();
    return result.text || '';
  } finally {
    try {
      await parser.destroy();
    } catch (_) {
      // Ignorar errores al liberar recursos
    }
  }
};

module.exports = { extractPdfText };
