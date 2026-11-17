/**
 * Logica de Notas de Credito (Egresos SAT) asociadas a facturas.
 */

import { api } from './api.js';
import { state } from './state.js';
import { escapeHtml, formatMoney, formatShortDate, toCents, fromCents } from './format.js';

function getEgresoEls() {
  return {
    modalEgresoSection: document.getElementById('modal-egreso-section'),
    modalEgresoMatchBadge: document.getElementById('modal-egreso-match-badge'),
    modalLinkedEgresoCard: document.getElementById('modal-linked-egreso-card'),
    modalLinkedEgresoMonto: document.getElementById('modal-linked-egreso-monto'),
    modalLinkedEgresoFecha: document.getElementById('modal-linked-egreso-fecha'),
    modalLinkedEgresoUuid: document.getElementById('modal-linked-egreso-uuid'),
    modalEgresoCandidatesContainer: document.getElementById('modal-egreso-candidates-container'),
    modalEgresoSearchInput: document.getElementById('modal-egreso-search-input'),
    modalEgresoCandidatesList: document.getElementById('modal-egreso-candidates-list'),
    modalStatus: document.getElementById('modal-status')
  };
}

function setModalStatus(msg, colorVar, bold = false) {
  const { modalStatus } = getEgresoEls();
  if (!modalStatus) return;
  modalStatus.innerHTML = `<span style="color:${colorVar};${bold ? ' font-weight:600;' : ''}">${escapeHtml(msg)}</span>`;
}

export function renderEgresoSectionForInvoice(inv) {
  const els = getEgresoEls();
  if (!els.modalEgresoSection) return;

  if (inv.efecto === 'Egreso') {
    els.modalEgresoSection.style.display = 'none';
    return;
  }

  els.modalEgresoSection.style.display = 'block';
  const hasLinkedEgreso =
    Boolean(inv.egresoAsociado?.uuid) ||
    Boolean(inv.pagoAsociado?.banco && inv.pagoAsociado.banco.includes('Nota de Crédito'));

  if (hasLinkedEgreso && inv.estadoPago === 'Pagada') {
    const egUuid = inv.egresoAsociado?.uuid || inv.pagoAsociado?.referencia || '';
    const egTotal = inv.egresoAsociado?.total || inv.pagoAsociado?.montoRetiro || inv.total;
    const egFecha = inv.egresoAsociado?.fechaEmision || inv.pagoAsociado?.fechaPago || '-';
    const egEmisor = inv.egresoAsociado?.emisor || inv.emisor || '';

    if (els.modalLinkedEgresoCard) els.modalLinkedEgresoCard.style.display = 'block';
    if (els.modalLinkedEgresoMonto) els.modalLinkedEgresoMonto.textContent = formatMoney(egTotal);
    if (els.modalLinkedEgresoFecha) els.modalLinkedEgresoFecha.textContent = `Fecha: ${formatShortDate(egFecha)}`;
    if (els.modalLinkedEgresoUuid) els.modalLinkedEgresoUuid.textContent = `${egUuid} (${egEmisor})`;
    if (els.modalEgresoCandidatesContainer) els.modalEgresoCandidatesContainer.style.display = 'none';
    if (els.modalEgresoMatchBadge) {
      els.modalEgresoMatchBadge.className = 'badge-paid';
      els.modalEgresoMatchBadge.textContent = 'Nota de Crédito Vinculada';
    }
  } else {
    if (els.modalLinkedEgresoCard) els.modalLinkedEgresoCard.style.display = 'none';
    if (els.modalEgresoCandidatesContainer) els.modalEgresoCandidatesContainer.style.display = 'block';
    renderModalEgresoCandidates();
  }
}

export function renderModalEgresoCandidates() {
  const els = getEgresoEls();
  if (!state.activeEditingUuid || !els.modalEgresoCandidatesList) return;

  const inv = state.cachedInvoices.find((i) => i.uuid === state.activeEditingUuid);
  if (!inv || inv.efecto === 'Egreso') return;

  const query = (els.modalEgresoSearchInput?.value || '').trim().toLowerCase();
  const invCents = toCents(inv.total);

  let candidates = (state.cachedInvoices || []).filter(
    (i) => i.efecto === 'Egreso' && (!i.ingresoAsociado?.uuid || i.ingresoAsociado.uuid === inv.uuid)
  );

  if (query) {
    candidates = candidates.filter((e) => {
      const text = `${e.uuid || ''} ${e.emisor || ''} ${e.rfcEmisor || ''} ${e.total || ''} ${e.fechaEmision || ''}`.toLowerCase();
      return text.includes(query);
    });
  }

  candidates.sort((a, b) => {
    const rfcMatchA = a.rfcEmisor === inv.rfcEmisor ? 1 : 0;
    const rfcMatchB = b.rfcEmisor === inv.rfcEmisor ? 1 : 0;
    if (rfcMatchA !== rfcMatchB) return rfcMatchB - rfcMatchA;

    const diffA = Math.abs(toCents(a.total) - invCents);
    const diffB = Math.abs(toCents(b.total) - invCents);
    return diffA - diffB;
  });

  const exactMatches = candidates.filter(
    (e) => e.rfcEmisor === inv.rfcEmisor && Math.abs(toCents(e.total) - invCents) < 1
  );

  if (els.modalEgresoMatchBadge) {
    if (exactMatches.length > 0) {
      els.modalEgresoMatchBadge.className = 'badge-paid';
      els.modalEgresoMatchBadge.textContent = `${exactMatches.length} con proveedor e importe exacto (${formatMoney(inv.total)})`;
    } else if (candidates.length > 0) {
      els.modalEgresoMatchBadge.className = 'badge-na';
      els.modalEgresoMatchBadge.textContent = `${candidates.length} Notas de Crédito disponibles`;
    } else {
      els.modalEgresoMatchBadge.className = 'badge-na';
      els.modalEgresoMatchBadge.textContent = 'Sin notas de crédito disponibles';
    }
  }

  if (candidates.length === 0) {
    els.modalEgresoCandidatesList.innerHTML = `
      <div style="padding:12px; text-align:center; font-size:11.5px; color:var(--text-muted);">
        No se encontraron Notas de Crédito (Egresos) disponibles para vincular.
      </div>
    `;
    return;
  }

  els.modalEgresoCandidatesList.innerHTML = candidates
    .map((e) => {
      const diffCents = Math.abs(toCents(e.total) - invCents);
      const isExact = diffCents < 1 && e.rfcEmisor === inv.rfcEmisor;
      const isSameRfc = e.rfcEmisor === inv.rfcEmisor;
      const diffBadge = isExact
        ? '<span class="badge-paid" style="font-size:9.5px; padding:1px 4px;">Mismo Proveedor e Importe</span>'
        : isSameRfc
          ? '<span style="font-size:10px; color:#1e40af; background:#dbeafe; padding:1px 4px; border-radius:2px;">Mismo Proveedor</span>'
          : `<span style="font-size:10.5px; color:var(--text-muted);">Dif: ${formatMoney(fromCents(diffCents))}</span>`;

      return `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 10px; border-bottom:1px solid #f3f4f6; gap:8px;">
          <div style="flex:1; min-width:0;">
            <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
              <span class="badge-warning" style="font-size:9.5px; padding:1px 5px; border-radius:2px; background:#e0e7ff; color:#3730a3; font-weight:700;">EGRESO</span>
              <strong style="font-size:12px; color:var(--text-main);">${formatMoney(e.total)}</strong>
              ${diffBadge}
              <span style="font-size:11px; color:var(--text-muted);">${escapeHtml(formatShortDate(e.fechaEmision))}</span>
            </div>
            <div style="font-size:11px; color:var(--text-muted); font-family:monospace; margin-top:2px;">
              ${escapeHtml(e.uuid.substring(0, 20))}... (${escapeHtml(e.emisor || 'Sin emisor')})
            </div>
          </div>
          <button type="button" class="btn-action-small btn-action-primary" data-action="link-egreso" data-egreso-uuid="${escapeHtml(e.uuid)}" style="font-size:11px; padding:3px 8px; white-space:nowrap; background:#4338ca; border-color:#4338ca;">
            Vincular Egreso
          </button>
        </div>
      `;
    })
    .join('');
}

export async function linkInvoiceToEgreso(egresoUuid, onLinked) {
  if (!state.activeEditingUuid) return;
  const inv = state.cachedInvoices.find((i) => i.uuid === state.activeEditingUuid);
  const eg = state.cachedInvoices.find((i) => i.uuid === egresoUuid);

  const confirmMsg = `¿Deseas vincular esta factura de Ingreso (${formatMoney(inv?.total)}) con la Nota de Crédito / Egreso (${formatMoney(eg?.total)})?\nLa factura quedará registrada como "Pagada".`;
  if (!confirm(confirmMsg)) return;

  setModalStatus('Vinculando con Nota de Credito...', 'var(--info)');

  try {
    const { ok, data } = await api.linkEgreso({
      ingresoUuid: state.activeEditingUuid,
      egresoUuid,
      observaciones: `Amortizada con Nota de Crédito ${egresoUuid.substring(0, 8)}...`
    });

    if (ok && data.success) {
      if (onLinked) await onLinked();
    } else {
      setModalStatus(data.message || 'Error al vincular con Egreso.', 'var(--error)', true);
    }
  } catch {
    setModalStatus('Error de conexion con el servidor.', 'var(--error)');
  }
}

export async function unlinkInvoiceEgreso(onUnlinked) {
  if (!state.activeEditingUuid) return;
  if (!confirm('¿Deseas desvincular la Nota de Crédito de esta factura? Pasará a estado "No Pagada".')) {
    return;
  }

  setModalStatus('Desvinculando Nota de Credito...', 'var(--info)');

  try {
    const { ok, data } = await api.unlinkEgreso(state.activeEditingUuid);
    if (ok && data.success) {
      if (onUnlinked) await onUnlinked();
    } else {
      setModalStatus(data.message || 'Error al desvincular.', 'var(--error)', true);
    }
  } catch {
    setModalStatus('Error de conexion con el servidor.', 'var(--error)');
  }
}

export async function triggerAutoLinkEgresos(onSuccess) {
  if (
    !confirm(
      `¿Deseas auto-vincular todas las facturas de Ingreso con sus Notas de Crédito (Egresos) de monto y proveedor idénticos para "${state.currentEntidad}" en el periodo ${state.currentPeriodo}?\n\nLas facturas con coincidencia exacta quedarán registradas como "Pagadas".`
    )
  ) {
    return;
  }

  const btn = document.getElementById('btn-auto-link-egresos');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Vinculando...';
  }

  try {
    const { data } = await api.autoLinkEgresos(state.currentPeriodo, state.currentEntidad);
    if (data.success) {
      alert(data.message);
      if (onSuccess) await onSuccess();
    } else {
      alert(data.message || 'Error al auto-vincular Notas de Credito.');
    }
  } catch {
    alert('Error de conexion al auto-vincular.');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Auto-vincular Notas de Crédito';
    }
  }
}

export function initEgresosEvents(onLinked) {
  const { modalEgresoCandidatesList } = getEgresoEls();
  if (!modalEgresoCandidatesList) return;

  modalEgresoCandidatesList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="link-egreso"]');
    if (!btn) return;
    const egresoUuid = btn.dataset.egresoUuid;
    if (egresoUuid) {
      linkInvoiceToEgreso(egresoUuid, onLinked);
    }
  });
}
