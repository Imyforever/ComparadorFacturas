/**
 * Renderizado de resumen financiero, tabla detallada, vista agrupada y movimientos sin factura.
 */

import {
  escapeHtml,
  formatMoney,
  formatShortDate,
  getBankBadgeClass,
  sumCents,
  toCents,
  fromCents
} from './format.js';
import { FIELD_LABELS } from './search.js';

export function updateSummary(els, summary) {
  if (!summary) return;
  els.statTotalAmount.textContent = formatMoney(summary.montoTotal);
  els.statTotalCount.textContent = `${summary.totalFacturas} facturas`;

  if (els.statSmallAmount && els.statSmallCount) {
    els.statSmallAmount.textContent = formatMoney(summary.montoMenores50);
    els.statSmallCount.textContent = `${summary.menores50Count || 0} menores a $100`;
  }

  els.statPaidAmount.textContent = formatMoney(summary.montoPagado);
  els.statPaidCount.textContent = `${summary.pagadasCount} pagadas`;

  els.statUnpaidAmount.textContent = formatMoney(summary.montoNoPagado);
  els.statUnpaidCount.textContent = `${summary.noPagadasCount} pendientes`;

  els.statCanceledAmount.textContent = formatMoney(summary.montoCancelado);
  els.statCanceledCount.textContent = `${summary.canceladasCount} canceladas`;

  if (els.statUnmatchedAmount && els.statUnmatchedCount) {
    els.statUnmatchedAmount.textContent = formatMoney(summary.unmatchedBankMonto);
    els.statUnmatchedCount.textContent = `${summary.unmatchedBankCount || 0} sin factura`;
  }
}

export function updateActiveFilterBanner(els, { query, selectedField, filtered, totalCount }) {
  if (query) {
    if (els.btnClearSearch) els.btnClearSearch.style.display = 'block';
    if (els.activeFilterIndicator) {
      els.activeFilterIndicator.style.display = 'flex';
      if (els.indicatorField) els.indicatorField.textContent = FIELD_LABELS[selectedField] || selectedField;
      if (els.indicatorQuery) els.indicatorQuery.textContent = `"${query}"`;
      if (els.indicatorStats) {
        const filterTotal = sumCents(filtered, (f) => f.total);
        els.indicatorStats.textContent = `(${filtered.length} facturas · Total: ${formatMoney(filterTotal)})`;
      }
    }
  } else {
    if (els.btnClearSearch) els.btnClearSearch.style.display = 'none';
    if (els.activeFilterIndicator) els.activeFilterIndicator.style.display = 'none';
  }

  if (els.showingCount) {
    els.showingCount.textContent = `${filtered.length} de ${totalCount} facturas`;
  }
}

function buildStatusBadge(inv) {
  let badgeHtml;
  if (inv.estadoPago === 'Pagada') {
    badgeHtml = '<span class="badge-paid">Pagada</span>';
  } else if (inv.estadoPago === 'No Pagada') {
    badgeHtml = '<span class="badge-unpaid">No Pagada</span>';
  } else if (inv.estadoPago === 'En Revision') {
    badgeHtml = '<span class="badge-warning" style="background:#fef3c7; color:#b45309; padding:2px 6px; border-radius:2px; font-weight:600; font-size:11px;">En Revision</span>';
  } else if (inv.estadoPago === 'Cancelada') {
    badgeHtml = '<span class="badge-canceled">Cancelada</span>';
  } else {
    badgeHtml = `<span class="badge-na">${escapeHtml(inv.estadoPago || '')}</span>`;
  }

  if (inv.editadoManualmente) {
    badgeHtml += '<br><span class="manual-tag">Manual</span>';
  } else if (inv.asignacionAutomatica?.tipo === 'nota-credito-parcial') {
    badgeHtml += '<br><span class="auto-nc-tag">Auto NC</span>';
  }
  return badgeHtml;
}

function buildPaymentDetailHtml(inv) {
  if (inv.estadoPago === 'Pagada') {
    if (inv.egresoAsociado?.uuid && inv.pagoAsociado?.movimientoId) {
      const uuid = escapeHtml(inv.egresoAsociado.uuid);
      const shortUuid = escapeHtml(inv.egresoAsociado.uuid.substring(0, 16));
      const p = inv.pagoAsociado;
      return `
        <div class="payment-detail" style="border-left: 3px solid #6366f1; padding-left: 6px;">
          <span style="font-size:10px; font-weight:700; background:#e0e7ff; color:#3730a3; padding:1px 5px; border-radius:2px;">Nota de Crédito</span>
          <span style="font-size:11.5px; font-weight:600; color:var(--text-main); margin-left:4px;">${formatMoney(inv.egresoAsociado.total || 0)}</span>
          <span style="font-size:10.5px; color:#4338ca; font-family:monospace; margin-left:4px;" title="${uuid}">${shortUuid}...</span><br>
          <strong>Banco:</strong> ${escapeHtml(p.banco || '-')} | <strong>Fecha:</strong> ${escapeHtml(p.fechaPago || '-')} | <strong>Retiro:</strong> ${formatMoney(p.montoRetiro || 0)}<br>
          <strong>Concepto:</strong> ${escapeHtml(p.conceptoBanco || 'Retiro bancario')}
        </div>
      `;
    }

    if (inv.egresoAsociado?.uuid) {
      const uuid = escapeHtml(inv.egresoAsociado.uuid);
      const shortUuid = escapeHtml(inv.egresoAsociado.uuid.substring(0, 16));
      return `
        <div class="payment-detail" style="border-left: 3px solid #6366f1; padding-left: 6px;">
          <span style="font-size:10px; font-weight:700; background:#e0e7ff; color:#3730a3; padding:1px 5px; border-radius:2px;">Nota de Crédito</span>
          <span style="font-size:11.5px; font-weight:600; color:var(--text-main); margin-left:4px;">${formatMoney(inv.egresoAsociado.total || inv.total)}</span><br>
          <span style="font-size:10.5px; color:#4338ca; font-family:monospace;" title="${uuid}">${shortUuid}...</span>
        </div>
      `;
    }

    if (inv.pagoAsociado && (inv.pagoAsociado.banco || inv.pagoAsociado.montoRetiro)) {
      const p = inv.pagoAsociado;
      if (p.banco && p.banco.includes('Nota de Crédito')) {
        const ref = escapeHtml(p.referencia || '');
        const shortRef = escapeHtml((p.referencia || '').substring(0, 16));
        return `
          <div class="payment-detail" style="border-left: 3px solid #6366f1; padding-left: 6px;">
            <span style="font-size:10px; font-weight:700; background:#e0e7ff; color:#3730a3; padding:1px 5px; border-radius:2px;">Nota de Crédito</span>
            <span style="font-size:11.5px; font-weight:600; color:var(--text-main); margin-left:4px;">${formatMoney(p.montoRetiro || inv.total)}</span><br>
            <span style="font-size:10.5px; color:#4338ca; font-family:monospace;" title="${ref}">${shortRef}...</span>
          </div>
        `;
      }

      return `
        <div class="payment-detail">
          <strong>Banco:</strong> ${escapeHtml(p.banco || '-')} | <strong>Fecha:</strong> ${escapeHtml(p.fechaPago || '-')} | <strong>Monto:</strong> ${formatMoney(p.montoRetiro || inv.total)}<br>
          <strong>Concepto:</strong> ${escapeHtml(p.conceptoBanco || p.banco || 'Retiro bancario')}
        </div>
      `;
    }

    return '<span style="color:var(--success); font-weight:600; font-size:11.5px;">Pagada (Manual)</span>';
  }

  if (inv.efecto === 'Egreso') {
    if (inv.ingresoAsociado?.uuid) {
      const uuid = escapeHtml(inv.ingresoAsociado.uuid);
      const shortUuid = escapeHtml(inv.ingresoAsociado.uuid.substring(0, 16));
      return `
        <div class="payment-detail" style="border-left: 3px solid #10b981; padding-left: 6px;">
          <span class="badge-paid" style="font-size:9.5px; padding:1px 5px;">Aplicada a Factura</span><br>
          <span style="font-size:10.5px; color:#065f46; font-family:monospace;" title="${uuid}">${shortUuid}...</span>
        </div>
      `;
    }
    return '<span style="color:var(--text-muted); font-size:11px;">Nota de Crédito disponible</span>';
  }

  if (inv.estadoSat === 'Cancelado') {
    return '<span style="color:var(--text-muted); font-size:11px;">Comprobante cancelado en SAT</span>';
  }

  return '<span style="color:var(--text-muted); font-size:11px;">Sin pago registrado</span>';
}

export function renderDetailView(els, filtered) {
  if (els.tableContainerDetail) els.tableContainerDetail.style.display = 'block';
  if (els.tableContainerGrouped) els.tableContainerGrouped.style.display = 'none';

  if (filtered.length === 0) {
    els.invoiceRows.innerHTML = '<tr><td colspan="11" style="text-align:center; padding:24px; color:var(--text-muted);">No se encontraron facturas con el criterio seleccionado.</td></tr>';
    return;
  }

  els.invoiceRows.innerHTML = filtered
    .map((inv, index) => {
      const badgeHtml = buildStatusBadge(inv);
      const paymentDetailHtml = buildPaymentDetailHtml(inv);
      const safeObs = escapeHtml(inv.observaciones || '');
      const noteContent = inv.observaciones
        ? `<span class="note-text" title="${safeObs}">${safeObs}</span>`
        : '<span class="empty-note">Sin observaciones</span>';
      const safeUuid = escapeHtml(inv.uuid || '');
      const uuidLabel = inv.uuid ? `${escapeHtml(inv.uuid.substring(0, 18))}...` : '-';

      return `
        <tr>
          <td style="text-align:center; font-weight:600; color:var(--text-muted); font-size:11.5px;">${index + 1}</td>
          <td style="font-family:monospace; font-size:11px; word-break:break-all;" title="${safeUuid}">${uuidLabel}</td>
          <td><strong>${escapeHtml(inv.emisor || 'Sin emisor')}</strong></td>
          <td><code style="font-size:11px;">${escapeHtml(inv.rfcEmisor || '-')}</code></td>
          <td style="font-size:12px;">${escapeHtml(formatShortDate(inv.fechaEmision))}</td>
          <td style="text-align:right; font-weight:600;">${formatMoney(inv.total)}</td>
          <td style="font-size:11.5px;">${escapeHtml(inv.efecto || 'Ingreso')}</td>
          <td style="text-align:center;">${badgeHtml}</td>
          <td>${paymentDetailHtml}</td>
          <td>${noteContent}</td>
          <td style="text-align:center;">
            <button type="button" class="btn-action-small" data-action="edit-invoice" data-uuid="${safeUuid}" title="Editar estado y notas">
              Editar
            </button>
          </td>
        </tr>
      `;
    })
    .join('');
}

export function renderGroupedView(els, filteredInvoices) {
  if (els.tableContainerDetail) els.tableContainerDetail.style.display = 'none';
  if (els.tableContainerGrouped) els.tableContainerGrouped.style.display = 'block';

  const map = new Map();
  for (const inv of filteredInvoices) {
    const emisor = (inv.emisor || 'Sin Emisor').trim();
    if (!map.has(emisor)) {
      map.set(emisor, {
        emisor,
        rfcEmisor: inv.rfcEmisor || '-',
        count: 0,
        totalCents: 0,
        pagadasCount: 0,
        pagadasCents: 0,
        noPagadasCount: 0,
        noPagadasCents: 0,
        canceladasCount: 0
      });
    }
    const item = map.get(emisor);
    const montoCents = toCents(inv.total);
    item.count++;
    item.totalCents += montoCents;
    if (inv.estadoPago === 'Pagada') {
      item.pagadasCount++;
      item.pagadasCents += montoCents;
    } else if (inv.estadoPago === 'No Pagada') {
      item.noPagadasCount++;
      item.noPagadasCents += montoCents;
    } else if (inv.estadoPago === 'Cancelada') {
      item.canceladasCount++;
    }
  }

  const list = Array.from(map.values()).sort((a, b) => b.count - a.count || a.emisor.localeCompare(b.emisor));

  if (list.length === 0) {
    els.groupedRows.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:24px; color:var(--text-muted);">No se encontraron emisores analizados con el criterio actual.</td></tr>';
    return;
  }

  els.groupedRows.innerHTML = list
    .map((item, index) => {
      const safeEmisor = escapeHtml(item.emisor);
      return `
        <tr>
          <td style="text-align:center; font-weight:600; color:var(--text-muted); font-size:11.5px;">${index + 1}</td>
          <td><strong>${safeEmisor}</strong></td>
          <td><code style="font-size:11px;">${escapeHtml(item.rfcEmisor)}</code></td>
          <td style="text-align:center; font-weight:700; color:var(--primary); font-size:12.5px;">${item.count}</td>
          <td style="text-align:right; font-weight:700;">${formatMoney(fromCents(item.totalCents))}</td>
          <td>
            <span class="badge-paid">${item.pagadasCount}</span>
            <span style="font-size:11.5px; color:var(--text-muted); margin-left:4px;">(${formatMoney(fromCents(item.pagadasCents))})</span>
          </td>
          <td>
            <span class="badge-unpaid">${item.noPagadasCount}</span>
            <span style="font-size:11.5px; color:var(--text-muted); margin-left:4px;">(${formatMoney(fromCents(item.noPagadasCents))})</span>
          </td>
          <td style="text-align:center;">
            ${item.canceladasCount > 0 ? `<span class="badge-canceled">${item.canceladasCount}</span>` : '<span style="color:var(--text-muted); font-size:11px;">0</span>'}
          </td>
          <td style="text-align:center;">
            <button type="button" class="btn-action-small" data-action="filter-emisor" data-emisor="${safeEmisor}" title="Ver detalle de facturas analizadas de ${safeEmisor}">
              Ver Facturas
            </button>
          </td>
        </tr>
      `;
    })
    .join('');
}

export function renderUnmatchedBankMovements(els, state) {
  if (!els.unmatchedBankRows) return;

  const query = (els.unmatchedSearchInput?.value || '').trim().toLowerCase();
  const paidMovementIds = new Set(
    state.cachedInvoices
      .filter((inv) => inv.estadoPago === 'Pagada' && inv.pagoAsociado?.movimientoId)
      .map((inv) => String(inv.pagoAsociado.movimientoId))
  );

  const minBankVal = parseFloat(els.unmatchedMinPrice?.value);
  const maxBankVal = parseFloat(els.unmatchedMaxPrice?.value);
  const hasMinBank = !isNaN(minBankVal) && minBankVal >= 0;
  const hasMaxBank = !isNaN(maxBankVal) && maxBankVal >= 0;

  if (els.btnClearUnmatchedPrice) {
    els.btnClearUnmatchedPrice.style.display = (hasMinBank || hasMaxBank) ? 'inline-block' : 'none';
  }

  const filtered = state.cachedUnmatchedMovements.filter((m) => {
    if (paidMovementIds.has(String(m._id))) return false;

    const mvCents = toCents(m.monto);
    if (mvCents < 10000) return false;
    const mvMonto = fromCents(mvCents);
    if (hasMinBank && mvMonto < minBankVal) return false;
    if (hasMaxBank && mvMonto > maxBankVal) return false;

    if (!query) return true;
    const str = `${m.fecha} ${m.banco} ${m.cuenta || ''} ${m.concepto} ${m.origenReferencia || ''} ${m.rfcDetectado || ''} ${m.monto} ${m.categoria || ''} ${m.observaciones || ''}`.toLowerCase();
    return str.includes(query);
  });

  const totalMonto = sumCents(filtered, (m) => m.monto);

  if (els.unmatchedCountHeader) {
    els.unmatchedCountHeader.textContent = filtered.length;
  }
  if (els.unmatchedTotalBadge) {
    els.unmatchedTotalBadge.textContent = formatMoney(totalMonto);
  }

  if (filtered.length === 0) {
    const emptyMsg = query
      ? 'No se encontraron pagos bancarios con el filtro ingresado.'
      : 'No hay pagos bancarios pendientes de factura para este mes y pestania.';
    els.unmatchedBankRows.innerHTML = `
      <tr>
        <td colspan="8" style="text-align: center; padding: 24px; color: var(--text-muted);">${emptyMsg}</td>
      </tr>
    `;
    return;
  }

  els.unmatchedBankRows.innerHTML = filtered
    .map((m, idx) => {
      const badgeClass = getBankBadgeClass(m.banco);
      const categoryTag = m.categoria
        ? `<div style="margin-top: 3px;"><span class="badge-warning" style="font-size: 10.5px; padding: 1px 5px; border-radius: 2px;">${escapeHtml(m.categoria)}</span></div>`
        : '';
      const noteText = m.observaciones
        ? `<div style="font-size: 11px; color: var(--info); font-style: italic; margin-top: 2px;">Nota: ${escapeHtml(m.observaciones)}</div>`
        : '';

      return `
        <tr>
          <td style="text-align:center; font-weight:600; color:var(--text-muted); font-size:11.5px;">${idx + 1}</td>
          <td style="font-size:12px;">${escapeHtml(m.fecha || '-')}</td>
          <td>
            <span class="bank-badge ${badgeClass}">${escapeHtml(m.banco || 'BANCO')}</span>
            <div style="font-size:10.5px; color:var(--text-muted); margin-top:2px;">${m.cuenta ? `Cta: ${escapeHtml(m.cuenta)}` : ''}</div>
          </td>
          <td>
            <strong>${escapeHtml(m.concepto || '-')}</strong>
            ${m.origenReferencia ? `<div style="font-size:11px; color:var(--text-muted);">Ref: ${escapeHtml(m.origenReferencia)}</div>` : ''}
            ${categoryTag}
            ${noteText}
          </td>
          <td><code style="font-size:11px;">${escapeHtml(m.rfcDetectado || '-')}</code></td>
          <td style="text-align:right; font-weight:700; color:var(--error); font-size:12.5px;">${formatMoney(m.monto)}</td>
          <td style="text-align:center;">
            <span class="badge-unpaid" style="font-size:11px;">Sin Factura SAT</span>
          </td>
          <td style="text-align:center;">
            <button type="button" class="btn-action-small btn-action-primary" data-action="compare-movement" data-mov-id="${escapeHtml(m._id)}" title="Vincular con una factura recibida">
              Vincular
            </button>
          </td>
        </tr>
      `;
    })
    .join('');
}

export function renderAutoCreditNoteSection(els, state) {
  if (!els.autoNcRows) return;

  const derived = (state.cachedInvoices || [])
    .filter((inv) => inv.asignacionAutomatica?.tipo === 'nota-credito-parcial' && inv.estadoPago === 'Pagada')
    .map((inv) => {
      const montoNota = Number(inv.egresoAsociado?.total || 0);
      const montoRetiro = Number(inv.pagoAsociado?.montoRetiro || 0);
      return {
        invoiceUuid: inv.uuid,
        emisor: inv.emisor,
        rfcEmisor: inv.rfcEmisor,
        facturaTotal: Number(inv.total || 0),
        creditNoteUuid: inv.egresoAsociado?.uuid || '',
        montoNota,
        fechaRetiro: inv.pagoAsociado?.fechaPago || '',
        conceptoRetiro: inv.pagoAsociado?.conceptoBanco || '',
        montoRetiro
      };
    });

  const items =
    Array.isArray(state.cachedAutoNcAssignments) && state.cachedAutoNcAssignments.length > 0
      ? state.cachedAutoNcAssignments
      : derived;

  if (els.autoNcCount) {
    els.autoNcCount.textContent = items.length;
  }

  if (items.length === 0) {
    els.autoNcRows.innerHTML = `
      <tr>
        <td colspan="6" style="text-align: center; padding: 16px; color: var(--text-muted);">
          Sin asignaciones automáticas con nota de crédito en este periodo.
        </td>
      </tr>
    `;
    return;
  }

  els.autoNcRows.innerHTML = items
    .map((item) => {
      const invUuid = String(item.invoiceUuid || '');
      const ncUuid = String(item.creditNoteUuid || '');
      const shortInvUuid = invUuid ? `${invUuid.substring(0, 8)}...` : '-';
      const shortNcUuid = ncUuid ? `${ncUuid.substring(0, 8)}...` : '-';
      const facturaCents = toCents(item.facturaTotal);
      const notaCents = toCents(item.montoNota);
      const retiroCents = toCents(item.montoRetiro);
      const sumaCents = notaCents + retiroCents;
      const cuadra = Math.abs(facturaCents - notaCents - retiroCents) < 5;
      const sumClass = cuadra ? 'auto-nc-sum-ok' : 'auto-nc-sum-diff';

      return `
        <tr>
          <td>
            <strong>${escapeHtml(item.emisor || 'Sin emisor')}</strong>
            <div style="font-size:10.5px; color:var(--text-muted);"><code>${escapeHtml(item.rfcEmisor || '-')}</code></div>
          </td>
          <td>
            <code style="font-size:11px;" title="${escapeHtml(invUuid)}">${escapeHtml(shortInvUuid)}</code>
            <div style="font-weight:700; color:var(--text-main); margin-top:2px;">${formatMoney(item.facturaTotal)}</div>
          </td>
          <td>
            <code style="font-size:11px;" title="${escapeHtml(ncUuid)}">${escapeHtml(shortNcUuid)}</code>
            <div style="font-weight:700; color:#3730a3; margin-top:2px;">${formatMoney(item.montoNota)}</div>
          </td>
          <td>
            <div style="font-size:11.5px;">
              <strong>${escapeHtml(item.fechaRetiro || '-')}</strong> · <strong>${formatMoney(item.montoRetiro)}</strong>
            </div>
            <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">
              ${escapeHtml(item.conceptoRetiro || 'Retiro bancario')}
            </div>
          </td>
          <td>
            <span class="${sumClass}">
              ${formatMoney(item.montoNota)} + ${formatMoney(item.montoRetiro)} = ${formatMoney(fromCents(sumaCents))}
            </span>
          </td>
          <td style="text-align:center;">
            <button type="button" class="btn-action-small btn-undo-auto-nc" data-action="undo-auto-nc" data-uuid="${escapeHtml(invUuid)}" title="Deshacer asignación automática y liberar nota y retiro">
              Deshacer
            </button>
          </td>
        </tr>
      `;
    })
    .join('');
}
