/**
 * Liberacion de un pago conjunto (un retiro que liquido varias facturas del mismo proveedor).
 * Si el retiro se libera o una de las facturas se edita a mano, el grupo entero se libera.
 */

const createJointGroupReleaser = ({ invoiceRepo, bankMovementRepo }) => {
  const isJointInvoice = (invoice) =>
    Boolean(invoice && Array.isArray(invoice.pagoConjunto?.uuids) && invoice.pagoConjunto.uuids.length > 0);

  /**
   * Libera el retiro y las DEMAS facturas del grupo; deja a `invoice` sin pagoConjunto (el llamador decide
   * el resto de su estado y la guarda). Devuelve true si la factura era de un pago conjunto.
   */
  const releaseJointGroup = async (invoice) => {
    if (!isJointInvoice(invoice)) return false;
    const movId = invoice.pagoAsociado?.movimientoId;
    if (movId) {
      await invoiceRepo.releaseOtherInvoicesFromMovement(movId, invoice.uuid);
      await bankMovementRepo.releaseById(movId);
    }
    invoice.pagoConjunto = null;
    return true;
  };

  return { isJointInvoice, releaseJointGroup };
};

module.exports = { createJointGroupReleaser };
