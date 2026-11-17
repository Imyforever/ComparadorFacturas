/**
 * Modal de comparacion y vinculacion manual de movimientos bancarios sin factura SAT.
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

function getCompareEls() {
  return {
    compareManualModal: document.getElementById('compare-manual-modal'),
    compareModalBanco: document.getElementById('compare-modal-banco'),
    compareModalConcepto: document.getElementById('compare-modal-concepto'),
    compareModalFecha: document.getElementById('compare-modal-fecha'),
    compareModalCuenta: document.getElementById('compare-modal-cuenta'),
    compareModalRfc: document.getElementById('compare-modal-rfc'),
    compareModalMonto: document.getElementById('compare-modal-monto'),
    compareSearchInput: document.getElementById('compare-search-input'),
    compareInvoiceRows: document.getElementById('compare-invoice-rows'),
    compareCommentInput: document.getElementById('compare-comment-input'),
    compareSelectedBadge: document.getElementById('compare-selected-badge'),
    compareSelectedPreview: document.getElementById('compare-selected-preview'),
    compareCommentBox: document.getElementById('compare-comment-box'),
    btnSaveCompareLink: document.getElementById('btn-save-compare-link'),
    compareStatus: document.getElementById('compare-status'),
    btnCompareSimilar: document.getElementById('btn-compare-similar'),
    btnCompareAll: document.getElementById('btn-compare-all')
  };
}

function setCompareStatus(msg, colorVar, bold = false) {
  const { compareStatus } = getCompareEls();
  if (!compareStatus) return;
  compareStatus.innerHTML = `<span style="color:${colorVar};${bold ? ' font-weight:600;' : ''}">${escapeHtml(msg)}</span>`;
}

export function renderCompareInvoiceList() {
  const els = getCompareEls();
  if (!state.activeCompareMovement || !els.compareInvoiceRows) return;

  const term = (els.compareSearchInput?.value || '').trim().toLowerCase();
  const bankCents = toCents(state.activeCompareMovement.monto);

  let candidates = state.cachedInvoices.filter((inv) => {
    if (inv.estadoPago === 'Cancelada' || inv.estadoPago === 'Pagada') return false;

    if (state.compareSimilarOnly) {
      const diffCents = Math.abs(toCents(inv.total) - bankCents);
      if (diffCents > 1000) return false;
    }

    if (term) {
      const str = `${inv.uuid} ${inv.emisor || ''} ${inv.rfcEmisor || ''} ${inv.total || ''} ${inv.fechaEmision || ''}`.toLowerCase();
      return str.includes(term);
    }

    return true;
  });

  candidates.sort((a, b) => Math.abs(toCents(a.total) - bankCents) - Math.abs(toCents(b.total) - bankCents));

  if (candidates.length === 0) {
    const safeTerm = escapeHtml(term);
    els.compareInvoiceRows.innerHTML = `
      <div style="text-align: center; padding: 26px 16px; color: var(--text-muted); background: #ffffff; border-radius: 4px; border: 1px dashed var(--border);">
        <div style="font-size: 13px; font-weight: 600; color: var(--text-main); margin-bottom: 4px;">
          ${term ? 'No se encontraron facturas con ese criterio' : `Sin facturas con monto similar (+- $10.00) a ${formatMoney(fromCents(bankCents))}`}
        </div>
        <div style="font-size: 11.5px; margin-bottom: 12px;">
          ${term ? `No hay coincidencias para "${safeTerm}".` : 'Puedes ver todas las facturas pendientes de este mes haciendo clic abajo:'}
        </div>
        <button type="button" class="btn-action-small" data-action="show-all-candidates" style="font-size: 11.5px;">
          Mostrar todas las facturas de este mes
        </button>
      </div>
    `;
    return;
  }

  els.compareInvoiceRows.innerHTML = candidates
    .map((inv) => {
      const isCurrentlyPaid = inv.estadoPago === 'Pagada';
      const isSelected = state.selectedCompareInvoiceUuid === inv.uuid;
      const diffCents = Math.abs(toCents(inv.total) - bankCents);

      let diffBadgeHtml;
      if (diffCents === 0) {
        diffBadgeHtml = '<span class="compare-candidate-diff diff-exact">Monto Exacto</span>';
      } else {
        const sign = toCents(inv.total) > bankCents ? '+' : '-';
        diffBadgeHtml = `<span class="compare-candidate-diff diff-near">Dif: ${sign}${formatMoney(fromCents(diffCents))}</span>`;
      }

      const dateStr = formatShortDate(inv.fechaEmision);
      const safeUuid = escapeHtml(inv.uuid);

      return `
        <div class="compare-candidate-card ${isSelected ? 'selected' : ''}" data-action="select-compare" data-uuid="${safeUuid}" title="Clic para seleccionar esta factura">
          <div class="compare-radio-circle">
            ${isSelected ? '<span style="font-size:11px; font-weight:700;">●</span>' : ''}
          </div>
          <div class="compare-candidate-left">
            <div class="compare-candidate-vendor">${escapeHtml(inv.emisor || 'Sin emisor')}</div>
            <div class="compare-candidate-meta">
              <span class="compare-candidate-rfc">RFC: ${escapeHtml(inv.rfcEmisor || '-')}</span>
              <span>Fecha: <strong>${escapeHtml(dateStr)}</strong></span>
              <span style="font-family: monospace;" title="${safeUuid}">Folio: ${escapeHtml(inv.uuid.substring(0, 16))}...</span>
              ${isCurrentlyPaid ? '<span class="badge-paid" style="font-size: 9.5px; padding: 1px 5px;">Ya Pagada</span>' : ''}
            </div>
          </div>
          <div class="compare-candidate-right">
            <div class="compare-candidate-amounts">
              <div class="compare-candidate-total">${formatMoney(inv.total)}</div>
              ${diffBadgeHtml}
            </div>
            <button type="button" class="compare-candidate-btn" data-action="select-compare" data-uuid="${safeUuid}">
              ${isSelected ? 'Seleccionada' : 'Seleccionar'}
            </button>
          </div>
        </div>
      `;
    })
    .join('');
}

export function openCompareModal(movimientoId) {
  const m = state.cachedUnmatchedMovements.find((x) => String(x._id) === String(movimientoId));
  if (!m) return;

  const els = getCompareEls();
  state.activeCompareMovement = m;
  state.compareSimilarOnly = true;
  state.selectedCompareInvoiceUuid = null;

  if (els.btnCompareSimilar) els.btnCompareSimilar.classList.add('active');
  if (els.btnCompareAll) els.btnCompareAll.classList.remove('active');

  const badgeClass = getBankBadgeClass(m.banco);
  if (els.compareModalBanco) {
    els.compareModalBanco.textContent = m.banco || 'BANCO';
    els.compareModalBanco.className = `bank-badge ${badgeClass}`;
  }

  if (els.compareModalConcepto) els.compareModalConcepto.textContent = m.concepto || '-';
  if (els.compareModalFecha) els.compareModalFecha.textContent = m.fecha || '-';
  if (els.compareModalCuenta) els.compareModalCuenta.textContent = m.cuenta || 'Principal';
  if (els.compareModalRfc) els.compareModalRfc.textContent = m.rfcDetectado || 'No detectado en banco';
  if (els.compareModalMonto) els.compareModalMonto.textContent = formatMoney(m.monto);

  if (els.compareSearchInput) els.compareSearchInput.value = '';
  if (els.compareCommentInput) els.compareCommentInput.value = '';
  if (els.compareStatus) els.compareStatus.innerHTML = '';

  if (els.compareSelectedBadge) {
    els.compareSelectedBadge.innerHTML = '<span style="color:var(--text-muted); font-style:italic;">Ninguna factura seleccionada</span>';
  }
  if (els.compareSelectedPreview) {
    els.compareSelectedPreview.innerHTML = 'Haz clic en una factura de arriba para seleccionarla y guardarla.';
  }
  if (els.compareCommentBox) els.compareCommentBox.classList.remove('active');
  if (els.btnSaveCompareLink) {
    els.btnSaveCompareLink.disabled = true;
    els.btnSaveCompareLink.textContent = 'Guardar y Marcar como Pagada';
  }

  renderCompareInvoiceList();
  if (els.compareManualModal) els.compareManualModal.classList.remove('hidden');
}

export function closeCompareModal() {
  const { compareStatus, compareManualModal } = getCompareEls();
  state.activeCompareMovement = null;
  state.selectedCompareInvoiceUuid = null;
  if (compareStatus) compareStatus.innerHTML = '';
  if (compareManualModal) compareManualModal.classList.add('hidden');
}

export function filterCompareCandidates(similarOnly) {
  const { btnCompareSimilar, btnCompareAll } = getCompareEls();
  state.compareSimilarOnly = similarOnly;
  if (similarOnly) {
    if (btnCompareSimilar) btnCompareSimilar.classList.add('active');
    if (btnCompareAll) btnCompareAll.classList.remove('active');
  } else {
    if (btnCompareAll) btnCompareAll.classList.add('active');
    if (btnCompareSimilar) btnCompareSimilar.classList.remove('active');
  }
  renderCompareInvoiceList();
}

export function selectCompareInvoice(uuid) {
  state.selectedCompareInvoiceUuid = uuid;
  const inv = state.cachedInvoices.find((i) => i.uuid === uuid);
  if (!inv) return;

  const els = getCompareEls();

  document.querySelectorAll('.compare-candidate-card').forEach((el) => {
    const isThis = el.dataset.uuid === uuid;
    el.classList.toggle('selected', isThis);
    const circle = el.querySelector('.compare-radio-circle');
    if (circle) circle.innerHTML = isThis ? '<span style="font-size:11px; font-weight:700;">●</span>' : '';
    const btn = el.querySelector('.compare-candidate-btn');
    if (btn) btn.textContent = isThis ? 'Seleccionada' : 'Seleccionar';
  });

  if (els.compareSelectedBadge) {
    els.compareSelectedBadge.innerHTML = '<span class="badge-paid" style="font-size:10.5px; padding:2px 7px;">Factura Seleccionada</span>';
  }

  if (els.compareSelectedPreview) {
    const safeUuid = escapeHtml(inv.uuid);
    els.compareSelectedPreview.innerHTML = `
      <div style="color:var(--text-main); font-weight:600; margin-top:2px;">
        <strong style="color:var(--primary); font-size:13px;">${escapeHtml(inv.emisor || 'Sin emisor')}</strong>
        <span style="margin: 0 6px; color:var(--text-muted);">|</span>
        Total: <strong style="color:var(--primary);">${formatMoney(inv.total)}</strong>
        <span style="margin: 0 6px; color:var(--text-muted);">|</span>
        <span style="color:var(--text-muted); font-size:11px; font-family:monospace;" title="${safeUuid}">Folio: ${escapeHtml(inv.uuid.substring(0, 16))}...</span>
      </div>
    `;
  }

  if (els.compareCommentBox) els.compareCommentBox.classList.add('active');
  if (els.btnSaveCompareLink) {
    els.btnSaveCompareLink.disabled = false;
    const firstName = (inv.emisor || 'Factura').split(' ')[0];
    els.btnSaveCompareLink.textContent = `Vincular a ${firstName} y Guardar como Pagada`;
  }
  if (els.compareCommentInput) els.compareCommentInput.focus();
}

export async function linkMovementToInvoice(movimientoId, invoiceUuid, customObservaciones = '', onReloadAll) {
  if (!state.activeCompareMovement) return;

  const targetInv = state.cachedInvoices.find((i) => i.uuid === invoiceUuid);
  if (targetInv?.estadoPago === 'Pagada') {
    if (!confirm(`La factura de "${targetInv?.emisor || 'proveedor'}" ya está marcada como "Pagada". ¿Deseas reasignarle este nuevo pago bancario?`)) {
      return;
    }
  }

  const { btnSaveCompareLink } = getCompareEls();
  setCompareStatus('Vinculando pago y guardando como Pagada (Manual)...', 'var(--info)', true);
  if (btnSaveCompareLink) btnSaveCompareLink.disabled = true;

  const obsToSend =
    customObservaciones ||
    `Vinculado manualmente a retiro bancario (${state.activeCompareMovement.banco || 'Banco'} - ${formatMoney(state.activeCompareMovement.monto)})`;

  try {
    const { ok, data } = await api.linkManual({
      movimientoId,
      invoiceUuid,
      observaciones: obsToSend
    });

    if (ok && data.success) {
      closeCompareModal();
      if (onReloadAll) await onReloadAll();
    } else {
      setCompareStatus(data.message || 'Error al vincular.', 'var(--error)', true);
      if (btnSaveCompareLink) btnSaveCompareLink.disabled = false;
    }
  } catch {
    setCompareStatus('Error de conexion con el servidor.', 'var(--error)');
    if (btnSaveCompareLink) btnSaveCompareLink.disabled = false;
  }
}

export function submitSelectedInvoiceLink(onReloadAll) {
  if (!state.activeCompareMovement) return;
  if (!state.selectedCompareInvoiceUuid) {
    alert('Por favor selecciona una factura de la lista.');
    return;
  }
  const { compareCommentInput } = getCompareEls();
  const comentario = compareCommentInput?.value.trim() || '';
  linkMovementToInvoice(state.activeCompareMovement._id, state.selectedCompareInvoiceUuid, comentario, onReloadAll);
}

export function initManualLinksEvents() {
  const { compareInvoiceRows, compareSearchInput } = getCompareEls();
  if (!compareInvoiceRows) return;

  compareInvoiceRows.addEventListener('click', (e) => {
    const showAllBtn = e.target.closest('[data-action="show-all-candidates"]');
    if (showAllBtn) {
      if (compareSearchInput) compareSearchInput.value = '';
      filterCompareCandidates(false);
      return;
    }

    const target = e.target.closest('[data-action="select-compare"]');
    if (!target) return;
    const uuid = target.dataset.uuid;
    if (uuid) {
      e.stopPropagation();
      selectCompareInvoice(uuid);
    }
  });
}
