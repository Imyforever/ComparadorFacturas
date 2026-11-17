/**
 * Modal de edicion de factura, vinculacion con pago bancario por importe y restablecimiento.
 */

import { api } from './api.js';
import { state } from './state.js';
import {
  escapeHtml,
  formatMoney,
  formatShortDate,
  getBankBadgeClass,
  toCents,
  fromCents
} from './format.js';
import { renderEgresoSectionForInvoice } from './egresos.js';

function getEditModalEls() {
  return {
    editModal: document.getElementById('edit-invoice-modal'),
    modalEditTitle: document.getElementById('modal-edit-title'),
    modalEmisor: document.getElementById('modal-emisor'),
    modalUuid: document.getElementById('modal-uuid'),
    modalTotal: document.getElementById('modal-total'),
    modalFecha: document.getElementById('modal-fecha'),
    modalEfecto: document.getElementById('modal-efecto'),
    modalEstadoPago: document.getElementById('modal-estado-pago'),
    modalObservaciones: document.getElementById('modal-observaciones'),
    modalStatus: document.getElementById('modal-status'),
    btnResetAuto: document.getElementById('btn-reset-auto'),
    btnSaveInvoice: document.getElementById('btn-save-invoice'),
    modalCurrentBadge: document.getElementById('modal-current-badge'),
    btnQuickMarkPaid: document.getElementById('btn-quick-mark-paid'),
    modalBankMatchBadge: document.getElementById('modal-bank-match-badge'),
    modalLinkedPaymentCard: document.getElementById('modal-linked-payment-card'),
    modalLinkedBanco: document.getElementById('modal-linked-banco'),
    modalLinkedMonto: document.getElementById('modal-linked-monto'),
    modalLinkedFecha: document.getElementById('modal-linked-fecha'),
    modalLinkedConcepto: document.getElementById('modal-linked-concepto'),
    modalBankCandidatesSection: document.getElementById('modal-bank-candidates-section'),
    modalBankSearchInput: document.getElementById('modal-bank-search-input'),
    modalBankCandidatesList: document.getElementById('modal-bank-candidates-list'),
    modalEgresoSearchInput: document.getElementById('modal-egreso-search-input')
  };
}

function setModalStatus(msg, colorVar, bold = false) {
  const { modalStatus } = getEditModalEls();
  if (!modalStatus) return;
  modalStatus.innerHTML = `<span style="color:${colorVar};${bold ? ' font-weight:600;' : ''}">${escapeHtml(msg)}</span>`;
}

export function renderModalBankCandidates() {
  const els = getEditModalEls();
  if (!state.activeEditingUuid || !els.modalBankCandidatesList) return;

  const inv = state.cachedInvoices.find((i) => i.uuid === state.activeEditingUuid);
  if (!inv) return;

  const query = (els.modalBankSearchInput?.value || '').trim().toLowerCase();
  const invCents = toCents(inv.total);

  let candidates = (state.cachedUnmatchedMovements || []).slice();
  if (query) {
    candidates = candidates.filter((m) => {
      const text = `${m.concepto || ''} ${m.banco || ''} ${m.monto || ''} ${m.fecha || ''} ${m.rfcDetectado || ''}`.toLowerCase();
      return text.includes(query);
    });
  }

  candidates.sort((a, b) => Math.abs(toCents(a.monto) - invCents) - Math.abs(toCents(b.monto) - invCents));
  const exactMatches = candidates.filter((m) => Math.abs(toCents(m.monto) - invCents) < 1);

  if (els.modalBankMatchBadge) {
    if (exactMatches.length > 0) {
      els.modalBankMatchBadge.className = 'badge-paid';
      els.modalBankMatchBadge.textContent = `${exactMatches.length} con importe exacto (${formatMoney(inv.total)})`;
    } else if (candidates.length > 0) {
      els.modalBankMatchBadge.className = 'badge-na';
      els.modalBankMatchBadge.textContent = `Buscando importe: ${formatMoney(inv.total)}`;
    } else {
      els.modalBankMatchBadge.className = 'badge-na';
      els.modalBankMatchBadge.textContent = 'Sin retiros disponibles';
    }
  }

  if (candidates.length === 0) {
    els.modalBankCandidatesList.innerHTML = `
      <div style="padding:14px; text-align:center; font-size:11.5px; color:var(--text-muted);">
        No se encontraron retiros bancarios disponibles en esta pestaña.
      </div>
    `;
    return;
  }

  els.modalBankCandidatesList.innerHTML = candidates
    .map((m) => {
      const diffCents = Math.abs(toCents(m.monto) - invCents);
      const isExact = diffCents < 1;
      const badgeBankClass = getBankBadgeClass(m.banco);
      const safeConcepto = escapeHtml(m.concepto || '');

      return `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 10px; border-bottom:1px solid #f3f4f6; gap:8px;">
          <div style="flex:1; min-width:0;">
            <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
              <span class="bank-badge ${badgeBankClass}" style="font-size:9.5px; padding:1px 5px;">${escapeHtml(m.banco || 'BANCO')}</span>
              <strong style="font-size:12px; color:var(--text-main);">${formatMoney(m.monto)}</strong>
              ${isExact ? '<span class="badge-paid" style="font-size:9.5px; padding:1px 4px;">Monto Exacto</span>' : `<span style="font-size:10.5px; color:var(--text-muted);">Dif: ${formatMoney(fromCents(diffCents))}</span>`}
              <span style="font-size:11px; color:var(--text-muted);">${escapeHtml(m.fecha || '')}</span>
            </div>
            <div style="font-size:11px; color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:2px;" title="${safeConcepto}">
              ${escapeHtml(m.concepto || 'Retiro bancario')}
            </div>
          </div>
          <button type="button" class="btn-action-small btn-action-primary" data-action="link-bank" data-mov-id="${escapeHtml(m._id)}" style="font-size:11px; padding:3px 8px; white-space:nowrap;">
            Vincular
          </button>
        </div>
      `;
    })
    .join('');
}

export function openEditModal(uuid, focusPayment = false) {
  const inv = state.cachedInvoices.find((i) => i.uuid === uuid);
  if (!inv) return;

  const els = getEditModalEls();
  state.activeEditingUuid = uuid;

  if (els.modalEditTitle) els.modalEditTitle.textContent = focusPayment ? 'Vincular Pago / Nota de Crédito' : 'Factura y Pago';
  if (els.modalEmisor) els.modalEmisor.textContent = inv.emisor || 'Sin emisor registrado';
  if (els.modalUuid) els.modalUuid.textContent = inv.uuid;
  if (els.modalTotal) els.modalTotal.textContent = formatMoney(inv.total);
  if (els.modalFecha) els.modalFecha.textContent = formatShortDate(inv.fechaEmision);
  if (els.modalEfecto) els.modalEfecto.textContent = inv.efecto || 'Ingreso';
  if (els.modalEstadoPago) els.modalEstadoPago.value = inv.estadoPago || 'No Pagada';
  if (els.modalObservaciones) els.modalObservaciones.value = inv.observaciones || '';
  if (els.modalStatus) els.modalStatus.innerHTML = '';
  if (els.modalBankSearchInput) els.modalBankSearchInput.value = '';
  if (els.modalEgresoSearchInput) els.modalEgresoSearchInput.value = '';

  if (els.modalCurrentBadge) {
    if (inv.estadoPago === 'Pagada') {
      els.modalCurrentBadge.className = 'badge-paid';
      els.modalCurrentBadge.textContent = 'Pagada';
    } else if (inv.estadoPago === 'No Pagada') {
      els.modalCurrentBadge.className = 'badge-unpaid';
      els.modalCurrentBadge.textContent = 'No Pagada';
    } else if (inv.estadoPago === 'Cancelada') {
      els.modalCurrentBadge.className = 'badge-canceled';
      els.modalCurrentBadge.textContent = 'Cancelada';
    } else {
      els.modalCurrentBadge.className = 'badge-na';
      els.modalCurrentBadge.textContent = inv.estadoPago || 'No Pagada';
    }
  }

  if (els.btnQuickMarkPaid) {
    els.btnQuickMarkPaid.style.display = inv.estadoPago === 'Pagada' ? 'none' : 'inline-block';
  }

  renderEgresoSectionForInvoice(inv);

  const hasLinkedBank =
    inv.pagoAsociado &&
    (inv.pagoAsociado.movimientoId || (inv.pagoAsociado.banco && !inv.pagoAsociado.banco.includes('Nota de Crédito')));

  if (hasLinkedBank && inv.estadoPago === 'Pagada') {
    if (els.modalLinkedPaymentCard) els.modalLinkedPaymentCard.style.display = 'block';
    if (els.modalLinkedBanco) els.modalLinkedBanco.textContent = inv.pagoAsociado.banco || 'BANCO';
    if (els.modalLinkedMonto) els.modalLinkedMonto.textContent = formatMoney(inv.pagoAsociado.montoRetiro || inv.total);
    if (els.modalLinkedFecha) els.modalLinkedFecha.textContent = `Fecha: ${inv.pagoAsociado.fechaPago || '-'}`;
    if (els.modalLinkedConcepto) els.modalLinkedConcepto.textContent = inv.pagoAsociado.conceptoBanco || 'Retiro bancario vinculado';
    if (els.modalBankCandidatesSection) els.modalBankCandidatesSection.style.display = 'none';
    if (els.modalBankMatchBadge) {
      els.modalBankMatchBadge.className = 'badge-paid';
      els.modalBankMatchBadge.textContent = 'Pago Vinculado';
    }
  } else {
    if (els.modalLinkedPaymentCard) els.modalLinkedPaymentCard.style.display = 'none';
    if (els.modalBankCandidatesSection) els.modalBankCandidatesSection.style.display = 'block';
    renderModalBankCandidates();
  }

  if (els.btnResetAuto) {
    els.btnResetAuto.style.display = inv.editadoManualmente ? 'inline-block' : 'none';
  }

  if (els.editModal) els.editModal.classList.remove('hidden');
  setTimeout(() => {
    if (focusPayment && els.modalBankSearchInput) {
      els.modalBankSearchInput.focus();
    } else if (els.modalObservaciones) {
      els.modalObservaciones.focus();
    }
  }, 50);
}

export function closeEditModal() {
  const { modalStatus, editModal } = getEditModalEls();
  state.activeEditingUuid = null;
  if (modalStatus) modalStatus.innerHTML = '';
  if (editModal) editModal.classList.add('hidden');
}

export async function linkInvoiceToBankMovement(movimientoId, onReloadAll) {
  if (!state.activeEditingUuid) return;
  const inv = state.cachedInvoices.find((i) => i.uuid === state.activeEditingUuid);
  const m = (state.cachedUnmatchedMovements || []).find((x) => String(x._id) === String(movimientoId));

  const confirmMsg = `¿Deseas vincular esta factura (${formatMoney(inv?.total)}) con el retiro bancario de ${formatMoney(m?.monto)}? La factura quedará registrada como "Pagada".`;
  if (!confirm(confirmMsg)) return;

  setModalStatus('Vinculando pago bancario...', 'var(--info)');

  try {
    const { ok, data } = await api.linkManual({
      movimientoId,
      invoiceUuid: state.activeEditingUuid,
      observaciones: 'Conciliado manualmente por coincidencia de importe'
    });

    if (ok && data.success) {
      closeEditModal();
      if (onReloadAll) await onReloadAll();
    } else {
      setModalStatus(data.message || 'Error al vincular.', 'var(--error)', true);
    }
  } catch {
    setModalStatus('Error de conexion con el servidor.', 'var(--error)');
  }
}

export async function unlinkInvoicePayment(onReloadAll) {
  if (!state.activeEditingUuid) return;
  if (!confirm('¿Deseas desvincular el pago bancario de esta factura? Pasará a estado "No Pagada".')) {
    return;
  }

  setModalStatus('Desvinculando pago...', 'var(--info)');

  try {
    const { ok, data } = await api.unlinkManual(state.activeEditingUuid);
    if (ok && data.success) {
      closeEditModal();
      if (onReloadAll) await onReloadAll();
    } else {
      setModalStatus(data.message || 'Error al desvincular.', 'var(--error)', true);
    }
  } catch {
    setModalStatus('Error de conexion con el servidor.', 'var(--error)');
  }
}

export async function saveInvoiceEdit({ onRender, onReloadData }) {
  if (!state.activeEditingUuid) return;

  const { modalEstadoPago, modalObservaciones, btnSaveInvoice } = getEditModalEls();
  const newEstado = modalEstadoPago.value;
  const newObservaciones = modalObservaciones.value.trim();

  setModalStatus('Guardando modificacion...', 'var(--info)');
  if (btnSaveInvoice) btnSaveInvoice.disabled = true;

  try {
    const { ok, data } = await api.updateInvoice(state.activeEditingUuid, {
      estadoPago: newEstado,
      observaciones: newObservaciones
    });

    if (ok && data.success) {
      const target = state.cachedInvoices.find((i) => i.uuid === state.activeEditingUuid);
      if (target) {
        target.estadoPago = newEstado;
        target.observaciones = newObservaciones;
        target.editadoManualmente = true;
        target.fechaEdicionManual = new Date();
      }
      if (onRender) onRender();
      closeEditModal();
      if (onReloadData) onReloadData();
    } else {
      setModalStatus(data.message || 'Error al guardar.', 'var(--error)', true);
    }
  } catch {
    setModalStatus('Error de conexion con el servidor.', 'var(--error)');
  } finally {
    if (btnSaveInvoice) btnSaveInvoice.disabled = false;
  }
}

export async function setModalStateToPaid(callbacks) {
  if (!state.activeEditingUuid) return;
  const { modalEstadoPago, modalCurrentBadge, btnQuickMarkPaid } = getEditModalEls();
  if (modalEstadoPago) modalEstadoPago.value = 'Pagada';
  if (modalCurrentBadge) {
    modalCurrentBadge.className = 'badge-paid';
    modalCurrentBadge.textContent = 'Pagada';
  }
  if (btnQuickMarkPaid) btnQuickMarkPaid.style.display = 'none';
  await saveInvoiceEdit(callbacks);
}

export async function resetInvoiceAuto(onReloadData) {
  if (!state.activeEditingUuid) return;

  if (!confirm('Desea restablecer esta factura al calculo automatico de conciliacion con los estados de cuenta bancarios?')) {
    return;
  }

  const { modalObservaciones, btnResetAuto } = getEditModalEls();
  setModalStatus('Restableciendo a automatico...', 'var(--info)');
  if (btnResetAuto) btnResetAuto.disabled = true;

  try {
    const { ok, data } = await api.updateInvoice(state.activeEditingUuid, {
      resetAuto: true,
      observaciones: modalObservaciones.value.trim()
    });

    if (ok && data.success) {
      closeEditModal();
      if (onReloadData) onReloadData();
    } else {
      setModalStatus(data.message || 'Error al restablecer.', 'var(--error)', true);
    }
  } catch {
    setModalStatus('Error de conexion al restablecer.', 'var(--error)');
  } finally {
    if (btnResetAuto) btnResetAuto.disabled = false;
  }
}

export function initEditModalEvents({ onReloadAll }) {
  const { modalBankCandidatesList } = getEditModalEls();
  if (!modalBankCandidatesList) return;

  modalBankCandidatesList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="link-bank"]');
    if (!btn) return;
    const movId = btn.dataset.movId;
    if (movId) {
      linkInvoiceToBankMovement(movId, onReloadAll);
    }
  });
}
