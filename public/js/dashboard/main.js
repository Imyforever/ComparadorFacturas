/**
 * Punto de entrada del dashboard (modulo ES nativo).
 * Conecta sesion, estado, API, tablas, filtros, pestanias, subidas y modales.
 */

import { api } from './api.js';
import { initSession } from './session.js';
import { state } from './state.js';
import { escapeHtml } from './format.js';
import { filterInvoices, updateAnalyzedOptions } from './search.js';
import {
  renderDetailView,
  renderGroupedView,
  renderUnmatchedBankMovements,
  updateActiveFilterBanner,
  updateSummary
} from './tables.js';
import {
  closeCreateTabModal,
  closeRenameTabModal,
  initTabsEvents,
  loadTabs,
  openCreateTabModal,
  renderTabs,
  submitCreateTab,
  submitRenameTab
} from './tabs.js';
import { initUploads, renderBankStatements, updateCfdiLockState } from './uploads.js';
import {
  initEgresosEvents,
  renderModalEgresoCandidates,
  triggerAutoLinkEgresos,
  unlinkInvoiceEgreso
} from './egresos.js';
import {
  closeEditModal,
  initEditModalEvents,
  openEditModal,
  renderModalBankCandidates,
  resetInvoiceAuto,
  saveInvoiceEdit,
  setModalStateToPaid,
  unlinkInvoicePayment
} from './modals.js';
import {
  closeCompareModal,
  filterCompareCandidates,
  initManualLinksEvents,
  openCompareModal,
  renderCompareInvoiceList,
  submitSelectedInvoiceLink
} from './manualLinks.js';

const MONTH_NAMES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
];

function getDomEls() {
  return {
    periodSelect: document.getElementById('period-select'),
    invoiceRows: document.getElementById('invoice-rows'),
    groupedRows: document.getElementById('grouped-rows'),
    searchInput: document.getElementById('search-input'),
    showingCount: document.getElementById('showing-count'),
    filterFieldSelect: document.getElementById('filter-field-select'),
    filterAnalyzedSelect: document.getElementById('filter-analyzed-select'),
    labelAnalyzedSelect: document.getElementById('label-analyzed-select'),
    labelSearchInput: document.getElementById('label-search-input'),
    analyzedDatalist: document.getElementById('analyzed-datalist'),
    btnClearSearch: document.getElementById('btn-clear-search'),
    activeFilterIndicator: document.getElementById('active-filter-indicator'),
    indicatorField: document.getElementById('indicator-field'),
    indicatorQuery: document.getElementById('indicator-query'),
    indicatorStats: document.getElementById('indicator-stats'),
    btnClearBanner: document.getElementById('btn-clear-banner'),
    btnViewDetail: document.getElementById('btn-view-detail'),
    btnViewGrouped: document.getElementById('btn-view-grouped'),
    tableContainerDetail: document.getElementById('table-container-detail'),
    tableContainerGrouped: document.getElementById('table-container-grouped'),
    statTotalAmount: document.getElementById('stat-total-amount'),
    statTotalCount: document.getElementById('stat-total-count'),
    statSmallAmount: document.getElementById('stat-small-amount'),
    statSmallCount: document.getElementById('stat-small-count'),
    statPaidAmount: document.getElementById('stat-paid-amount'),
    statPaidCount: document.getElementById('stat-paid-count'),
    statUnpaidAmount: document.getElementById('stat-unpaid-amount'),
    statUnpaidCount: document.getElementById('stat-unpaid-count'),
    statCanceledAmount: document.getElementById('stat-canceled-amount'),
    statCanceledCount: document.getElementById('stat-canceled-count'),
    statUnmatchedAmount: document.getElementById('stat-unmatched-amount'),
    statUnmatchedCount: document.getElementById('stat-unmatched-count'),
    filterMinPrice: document.getElementById('filter-min-price'),
    filterMaxPrice: document.getElementById('filter-max-price'),
    btnClearPriceFilter: document.getElementById('btn-clear-price-filter'),
    unmatchedCountHeader: document.getElementById('unmatched-count-header'),
    unmatchedTotalBadge: document.getElementById('unmatched-total-badge'),
    unmatchedSearchInput: document.getElementById('unmatched-search-input'),
    unmatchedMinPrice: document.getElementById('unmatched-min-price'),
    unmatchedMaxPrice: document.getElementById('unmatched-max-price'),
    btnClearUnmatchedPrice: document.getElementById('btn-clear-unmatched-price'),
    btnToggleUnmatchedTable: document.getElementById('btn-toggle-unmatched-table'),
    unmatchedTableWrapper: document.getElementById('unmatched-table-wrapper'),
    unmatchedBankRows: document.getElementById('unmatched-bank-rows'),
    cfdiStatus: document.getElementById('cfdi-status'),
    bankStatus: document.getElementById('bank-status'),
    editModal: document.getElementById('edit-invoice-modal'),
    createTabModal: document.getElementById('create-tab-modal'),
    renameTabModal: document.getElementById('rename-tab-modal'),
    compareManualModal: document.getElementById('compare-manual-modal')
  };
}

function populateMonthSelector(periodSelect) {
  const now = new Date();
  const currentYear = now.getFullYear() < 2026 ? 2026 : now.getFullYear();
  const currentMonth = now.getMonth();

  periodSelect.innerHTML = '';
  const totalMonthsToGoBack = 24;

  for (let i = 0; i < totalMonthsToGoBack; i++) {
    const d = new Date(currentYear, currentMonth - i, 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const val = `${y}-${m}`;
    const label = `${MONTH_NAMES[d.getMonth()]} ${y}`;

    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = label;
    if (val === '2026-09') {
      opt.selected = true;
      state.currentPeriodo = val;
    }
    periodSelect.appendChild(opt);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  if (!initSession()) return;

  const els = getDomEls();
  populateMonthSelector(els.periodSelect);

  function applyFilterAndRender() {
    const query = (els.searchInput?.value || '').trim();
    const minPrice = parseFloat(els.filterMinPrice?.value);
    const maxPrice = parseFloat(els.filterMaxPrice?.value);
    const hasMinPrice = !isNaN(minPrice) && minPrice >= 0;
    const hasMaxPrice = !isNaN(maxPrice) && maxPrice >= 0;

    if (els.btnClearPriceFilter) {
      els.btnClearPriceFilter.style.display = hasMinPrice || hasMaxPrice ? 'inline-block' : 'none';
    }

    const filtered = filterInvoices(state.cachedInvoices, {
      currentFilter: state.currentFilter,
      selectedField: state.selectedField,
      query,
      minPrice,
      maxPrice
    });

    updateActiveFilterBanner(els, {
      query,
      selectedField: state.selectedField,
      filtered,
      totalCount: state.cachedInvoices.length
    });

    if (state.currentViewMode === 'grouped') {
      renderGroupedView(els, filtered);
    } else {
      renderDetailView(els, filtered);
    }
  }

  async function loadData() {
    els.invoiceRows.innerHTML = `<tr><td colspan="11" style="text-align:center; padding:24px; color:var(--text-muted);">Cargando facturas de "${escapeHtml(state.currentEntidad)}" desde MongoDB Atlas...</td></tr>`;

    try {
      const { data } = await api.data(state.currentPeriodo, state.currentEntidad);
      if (data.success) {
        state.cachedInvoices = data.invoices || [];
        state.cachedUnmatchedMovements = data.unmatchedBankMovements || [];
        updateSummary(els, data.summary);
        updateCfdiLockState(data.hasCfdiFile, data.summary?.totalFacturas || 0);
        renderBankStatements(data.bankStatements || []);
        renderUnmatchedBankMovements(els, state);
        updateAnalyzedOptions(els, state.cachedInvoices, state.selectedField);
        applyFilterAndRender();

        const tabObj = state.cachedTabs.find((t) => t.nombre === state.currentEntidad);
        if (tabObj && tabObj.facturasCount !== (data.summary?.totalFacturas || 0)) {
          tabObj.facturasCount = data.summary?.totalFacturas || 0;
          renderTabs();
        }
      } else {
        els.invoiceRows.innerHTML = `<tr><td colspan="11" style="text-align:center; padding:24px; color:var(--error);">${escapeHtml(data.message || 'Error cargando datos.')}</td></tr>`;
      }
    } catch (err) {
      console.error('Error cargando datos en dashboard:', err);
      const errMsg = err.message ? `Error: ${err.message}` : 'Error de conexion con el servidor.';
      els.invoiceRows.innerHTML = `<tr><td colspan="11" style="text-align:center; padding:24px; color:var(--error);">${escapeHtml(errMsg)}</td></tr>`;
    }
  }

  async function reloadAll() {
    await loadTabs();
    await loadData();
  }

  async function handleEgresoOrModalReload() {
    closeEditModal();
    await reloadAll();
  }

  // Periodo
  els.periodSelect.addEventListener('change', async () => {
    state.currentPeriodo = els.periodSelect.value;
    if (els.cfdiStatus) els.cfdiStatus.innerHTML = '';
    if (els.bankStatus) els.bankStatus.innerHTML = '';
    await reloadAll();
  });

  // Filtros y busqueda de facturas
  els.filterFieldSelect?.addEventListener('change', () => {
    state.selectedField = els.filterFieldSelect.value;
    updateAnalyzedOptions(els, state.cachedInvoices, state.selectedField);
    applyFilterAndRender();
  });

  els.filterAnalyzedSelect?.addEventListener('change', () => {
    els.searchInput.value = els.filterAnalyzedSelect.value;
    applyFilterAndRender();
  });

  els.searchInput?.addEventListener('input', () => {
    if (els.filterAnalyzedSelect) {
      const val = els.searchInput.value.trim();
      const hasMatch = Array.from(els.filterAnalyzedSelect.options).some(
        (o) => o.value && o.value.toLowerCase() === val.toLowerCase()
      );
      els.filterAnalyzedSelect.value = hasMatch ? val : '';
    }
    applyFilterAndRender();
  });

  els.btnClearSearch?.addEventListener('click', () => {
    els.searchInput.value = '';
    if (els.filterAnalyzedSelect) els.filterAnalyzedSelect.value = '';
    applyFilterAndRender();
    els.searchInput.focus();
  });

  els.btnClearBanner?.addEventListener('click', () => {
    els.searchInput.value = '';
    if (els.filterAnalyzedSelect) els.filterAnalyzedSelect.value = '';
    applyFilterAndRender();
  });

  els.filterMinPrice?.addEventListener('input', applyFilterAndRender);
  els.filterMaxPrice?.addEventListener('input', applyFilterAndRender);

  els.btnViewDetail?.addEventListener('click', () => {
    state.currentViewMode = 'detail';
    els.btnViewDetail.classList.add('active');
    els.btnViewGrouped?.classList.remove('active');
    applyFilterAndRender();
  });

  els.btnViewGrouped?.addEventListener('click', () => {
    state.currentViewMode = 'grouped';
    els.btnViewGrouped.classList.add('active');
    els.btnViewDetail?.classList.remove('active');
    applyFilterAndRender();
  });

  document.querySelectorAll('.filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.currentFilter = btn.dataset.filter;
      applyFilterAndRender();
    });
  });

  // Delegacion en tablas
  els.invoiceRows?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="edit-invoice"]');
    if (!btn) return;
    const uuid = btn.dataset.uuid;
    if (uuid) openEditModal(uuid);
  });

  els.groupedRows?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="filter-emisor"]');
    if (!btn) return;
    const emisorName = btn.dataset.emisor;
    if (!emisorName) return;

    state.selectedField = 'emisor';
    if (els.filterFieldSelect) els.filterFieldSelect.value = 'emisor';
    updateAnalyzedOptions(els, state.cachedInvoices, state.selectedField);
    if (els.searchInput) els.searchInput.value = emisorName;
    if (els.filterAnalyzedSelect) els.filterAnalyzedSelect.value = emisorName;
    state.currentViewMode = 'detail';
    els.btnViewDetail?.classList.add('active');
    els.btnViewGrouped?.classList.remove('active');
    applyFilterAndRender();
  });

  els.unmatchedBankRows?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="compare-movement"]');
    if (!btn) return;
    const movId = btn.dataset.movId;
    if (movId) openCompareModal(movId);
  });

  // Movimientos sin factura
  els.btnToggleUnmatchedTable?.addEventListener('click', () => {
    if (!els.unmatchedTableWrapper) return;
    const isHidden = els.unmatchedTableWrapper.style.display === 'none';
    els.unmatchedTableWrapper.style.display = isHidden ? 'block' : 'none';
    els.btnToggleUnmatchedTable.textContent = isHidden ? 'Ocultar' : 'Mostrar';
  });

  els.unmatchedSearchInput?.addEventListener('input', () => renderUnmatchedBankMovements(els, state));
  els.unmatchedMinPrice?.addEventListener('input', () => renderUnmatchedBankMovements(els, state));
  els.unmatchedMaxPrice?.addEventListener('input', () => renderUnmatchedBankMovements(els, state));

  // Teclado y clic fuera de modales
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (els.editModal && !els.editModal.classList.contains('hidden')) closeEditModal();
      if (els.createTabModal && !els.createTabModal.classList.contains('hidden')) closeCreateTabModal();
      if (els.renameTabModal && !els.renameTabModal.classList.contains('hidden')) closeRenameTabModal();
      if (els.compareManualModal && !els.compareManualModal.classList.contains('hidden')) closeCompareModal();
    }
    if (e.key === 'Enter') {
      if (els.createTabModal && !els.createTabModal.classList.contains('hidden')) {
        e.preventDefault();
        submitCreateTab(loadData);
      } else if (els.renameTabModal && !els.renameTabModal.classList.contains('hidden')) {
        e.preventDefault();
        submitRenameTab(loadData);
      } else if (
        els.compareManualModal &&
        !els.compareManualModal.classList.contains('hidden') &&
        state.selectedCompareInvoiceUuid
      ) {
        e.preventDefault();
        submitSelectedInvoiceLink(reloadAll);
      }
    }
  });

  els.editModal?.addEventListener('click', (e) => {
    if (e.target === els.editModal) closeEditModal();
  });
  els.createTabModal?.addEventListener('click', (e) => {
    if (e.target === els.createTabModal) closeCreateTabModal();
  });
  els.renameTabModal?.addEventListener('click', (e) => {
    if (e.target === els.renameTabModal) closeRenameTabModal();
  });
  els.compareManualModal?.addEventListener('click', (e) => {
    if (e.target === els.compareManualModal) closeCompareModal();
  });

  // Inicializar submodulos
  initTabsEvents(loadData);
  initUploads({ onReloadAll: reloadAll, onReloadData: loadData });
  initEgresosEvents(handleEgresoOrModalReload);
  initEditModalEvents({ onReloadAll: reloadAll });
  initManualLinksEvents();

  // Exponer manejadores referenciados en dashboard.html
  Object.assign(window, {
    openCreateTabModal,
    closeCreateTabModal,
    submitCreateTab: () => submitCreateTab(loadData),
    closeRenameTabModal,
    submitRenameTab: () => submitRenameTab(loadData),
    scrollToUnmatchedSection: () => {
      document.getElementById('unmatched-bank-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    clearInvoicePriceFilter: () => {
      if (els.filterMinPrice) els.filterMinPrice.value = '';
      if (els.filterMaxPrice) els.filterMaxPrice.value = '';
      if (els.btnClearPriceFilter) els.btnClearPriceFilter.style.display = 'none';
      applyFilterAndRender();
    },
    clearUnmatchedPriceFilter: () => {
      if (els.unmatchedMinPrice) els.unmatchedMinPrice.value = '';
      if (els.unmatchedMaxPrice) els.unmatchedMaxPrice.value = '';
      if (els.btnClearUnmatchedPrice) els.btnClearUnmatchedPrice.style.display = 'none';
      renderUnmatchedBankMovements(els, state);
    },
    closeEditModal,
    setModalStateToPaid: () => setModalStateToPaid({ onRender: applyFilterAndRender, onReloadData: loadData }),
    unlinkInvoiceEgreso: () => unlinkInvoiceEgreso(handleEgresoOrModalReload),
    renderModalEgresoCandidates,
    unlinkInvoicePayment: () => unlinkInvoicePayment(reloadAll),
    renderModalBankCandidates,
    resetInvoiceAuto: () => resetInvoiceAuto(loadData),
    saveInvoiceEdit: () => saveInvoiceEdit({ onRender: applyFilterAndRender, onReloadData: loadData }),
    closeCompareModal,
    filterCompareCandidates,
    renderCompareInvoiceList,
    submitSelectedInvoiceLink: () => submitSelectedInvoiceLink(reloadAll),
    triggerAutoLinkEgresos: () => triggerAutoLinkEgresos(reloadAll),
    triggerRefreshReconciliation: async () => {
      const btn = document.getElementById('btn-refresh-reconciliation');
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Actualizando...';
      }
      try {
        const { data } = await api.refresh(state.currentPeriodo, state.currentEntidad);
        if (data.success) {
          await loadData();
          if (btn) {
            btn.textContent = 'Actualizado';
            setTimeout(() => {
              btn.textContent = 'Actualizar';
              btn.disabled = false;
            }, 1800);
          }
        } else {
          alert(data.message || 'Error al actualizar la conciliacion.');
          if (btn) {
            btn.textContent = 'Actualizar';
            btn.disabled = false;
          }
        }
      } catch {
        alert('Error de conexion al actualizar.');
        if (btn) {
          btn.textContent = 'Actualizar';
          btn.disabled = false;
        }
      }
    }
  });

  reloadAll();
});
