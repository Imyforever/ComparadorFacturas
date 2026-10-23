/**
 * Logica del Panel de Conciliacion de Facturas vs Estados de Cuenta
 */

document.addEventListener('DOMContentLoaded', () => {
  const token = localStorage.getItem('auth_token');
  const userJson = localStorage.getItem('auth_user');

  // Verificacion de sesion
  if (!token || !userJson) {
    window.location.href = '/';
    return;
  }

  try {
    const user = JSON.parse(userJson);
    document.getElementById('user-name').textContent = user.username || 'admin';
  } catch (err) {
    window.location.href = '/';
    return;
  }

  // Cerrar sesion
  document.getElementById('btn-logout').addEventListener('click', () => {
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_user');
    window.location.href = '/';
  });

  // Elementos DOM
  const periodSelect = document.getElementById('period-select');
  const invoiceRows = document.getElementById('invoice-rows');
  const searchInput = document.getElementById('search-input');
  const showingCount = document.getElementById('showing-count');

  // Elementos de Filtro por Campo y Analizados
  const filterFieldSelect = document.getElementById('filter-field-select');
  const filterAnalyzedSelect = document.getElementById('filter-analyzed-select');
  const labelAnalyzedSelect = document.getElementById('label-analyzed-select');
  const labelSearchInput = document.getElementById('label-search-input');
  const analyzedDatalist = document.getElementById('analyzed-datalist');
  const btnClearSearch = document.getElementById('btn-clear-search');
  const activeFilterIndicator = document.getElementById('active-filter-indicator');
  const indicatorField = document.getElementById('indicator-field');
  const indicatorQuery = document.getElementById('indicator-query');
  const indicatorStats = document.getElementById('indicator-stats');
  const btnClearBanner = document.getElementById('btn-clear-banner');
  const btnViewDetail = document.getElementById('btn-view-detail');
  const btnViewGrouped = document.getElementById('btn-view-grouped');
  const tableContainerDetail = document.getElementById('table-container-detail');
  const tableContainerGrouped = document.getElementById('table-container-grouped');
  const groupedRows = document.getElementById('grouped-rows');

  const statTotalAmount = document.getElementById('stat-total-amount');
  const statTotalCount = document.getElementById('stat-total-count');
  const statPaidAmount = document.getElementById('stat-paid-amount');
  const statPaidCount = document.getElementById('stat-paid-count');
  const statUnpaidAmount = document.getElementById('stat-unpaid-amount');
  const statUnpaidCount = document.getElementById('stat-unpaid-count');
  const statCanceledAmount = document.getElementById('stat-canceled-amount');
  const statCanceledCount = document.getElementById('stat-canceled-count');
  const statUnmatchedAmount = document.getElementById('stat-unmatched-amount');
  const statUnmatchedCount = document.getElementById('stat-unmatched-count');

  // Elementos de Filtro por Rango de Precios en Facturas
  const filterMinPrice = document.getElementById('filter-min-price');
  const filterMaxPrice = document.getElementById('filter-max-price');
  const btnClearPriceFilter = document.getElementById('btn-clear-price-filter');

  // Elementos del Apartado de Pagos Bancarios no Encontrados en Facturas Recibidas
  const unmatchedCountHeader = document.getElementById('unmatched-count-header');
  const unmatchedTotalBadge = document.getElementById('unmatched-total-badge');
  const unmatchedSearchInput = document.getElementById('unmatched-search-input');
  const unmatchedMinPrice = document.getElementById('unmatched-min-price');
  const unmatchedMaxPrice = document.getElementById('unmatched-max-price');
  const btnClearUnmatchedPrice = document.getElementById('btn-clear-unmatched-price');
  const btnToggleUnmatchedTable = document.getElementById('btn-toggle-unmatched-table');
  const unmatchedTableWrapper = document.getElementById('unmatched-table-wrapper');
  const unmatchedBankRows = document.getElementById('unmatched-bank-rows');

  // Elementos del Modal de Comparacion Manual
  const compareManualModal = document.getElementById('compare-manual-modal');
  const compareModalBanco = document.getElementById('compare-modal-banco');
  const compareModalConcepto = document.getElementById('compare-modal-concepto');
  const compareModalFecha = document.getElementById('compare-modal-fecha');
  const compareModalCuenta = document.getElementById('compare-modal-cuenta');
  const compareModalRfc = document.getElementById('compare-modal-rfc');
  const compareModalMonto = document.getElementById('compare-modal-monto');
  const compareSearchInput = document.getElementById('compare-search-input');
  const compareInvoiceRows = document.getElementById('compare-invoice-rows');
  const compareCommentInput = document.getElementById('compare-comment-input');
  const compareSelectedBadge = document.getElementById('compare-selected-badge');
  const compareSelectedPreview = document.getElementById('compare-selected-preview');
  const compareCommentBox = document.getElementById('compare-comment-box');
  const btnSaveCompareLink = document.getElementById('btn-save-compare-link');
  const compareStatus = document.getElementById('compare-status');
  const btnCompareSimilar = document.getElementById('btn-compare-similar');
  const btnCompareAll = document.getElementById('btn-compare-all');
  let selectedCompareInvoiceUuid = null;

  const cfdiFileInput = document.getElementById('cfdi-file');
  const btnSelectCfdi = document.getElementById('btn-select-cfdi');
  const btnReplaceCfdi = document.getElementById('btn-replace-cfdi');
  const cfdiStatus = document.getElementById('cfdi-status');

  const bankFilesInput = document.getElementById('bank-files');
  const bankStatus = document.getElementById('bank-status');
  const bankFilesList = document.getElementById('bank-files-list');
  const bankFilesCount = document.getElementById('bank-files-count');
  const btnExportCsv = document.getElementById('btn-export-csv');

  const MONTH_NAMES = [
    'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
  ];

  let currentPeriodo = '2026-09';
  let currentEntidad = 'Personal';
  let cachedTabs = [];
  let currentFilter = 'all';
  let selectedField = 'emisor';
  let currentViewMode = 'detail';
  let cachedInvoices = [];
  let cachedUnmatchedMovements = [];
  let activeCompareMovement = null;
  let compareSimilarOnly = true;

  // Elementos de Pestanias / Cuentas
  const entityTabsList = document.getElementById('entity-tabs-list');
  const createTabModal = document.getElementById('create-tab-modal');
  const inputNewTabName = document.getElementById('input-new-tab-name');
  const createTabStatus = document.getElementById('create-tab-status');
  const btnSubmitCreateTab = document.getElementById('btn-submit-create-tab');
  const modalCreateTabPeriod = document.getElementById('modal-create-tab-period');

  const renameTabModal = document.getElementById('rename-tab-modal');
  const inputRenameTabName = document.getElementById('input-rename-tab-name');
  const renameTabStatus = document.getElementById('rename-tab-status');
  const btnSubmitRenameTab = document.getElementById('btn-submit-rename-tab');
  const modalRenameCurrentName = document.getElementById('modal-rename-current-name');

  // 1. Generar automaticamente todos los meses anteriores al actual
  function populateMonthSelector() {
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
        currentPeriodo = val;
      }
      periodSelect.appendChild(opt);
    }
  }

  populateMonthSelector();

  periodSelect.addEventListener('change', async () => {
    currentPeriodo = periodSelect.value;
    cfdiStatus.innerHTML = '';
    bankStatus.innerHTML = '';
    await loadTabs();
    loadData();
  });

  // Formateador de moneda
  const formatMoney = (val) =>
    '$' + Number(val || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // 2. Gestion de Pestanias / Cuentas por Mes (Personal, Empresa, etc.)
  async function loadTabs() {
    try {
      const res = await fetch(`/api/reconciliation/tabs?periodo=${currentPeriodo}`);
      const data = await res.json();
      if (data.success && Array.isArray(data.tabs)) {
        cachedTabs = data.tabs;
        if (!cachedTabs.some((t) => t.nombre === currentEntidad)) {
          currentEntidad = cachedTabs[0]?.nombre || '';
        }
        renderTabs();
      }
    } catch (err) {
      console.error('Error cargando pestanias:', err);
    }
  }

  function renderTabs() {
    if (!entityTabsList) return;

    entityTabsList.innerHTML = cachedTabs
      .map((tab) => {
        const isActive = tab.nombre === currentEntidad;
        const canDelete = cachedTabs.length > 1;

        return `
          <div class="entity-tab ${isActive ? 'active' : ''}" onclick="switchEntityTab('${tab.nombre}')">
            <span class="tab-label">${tab.nombre}</span>
            <span class="tab-badge" title="${tab.facturasCount || 0} facturas en esta pestania">${tab.facturasCount || 0}</span>
            <div class="tab-actions-group">
              <button type="button" class="btn-tab-icon" onclick="event.stopPropagation(); openRenameTabModal('${tab.nombre}')" title="Renombrar esta pestania">
                Editar
              </button>
              ${
                canDelete
                  ? `<button type="button" class="btn-tab-icon btn-tab-icon-delete" onclick="event.stopPropagation(); deleteEntityTab('${tab.nombre}')" title="Eliminar pestania">&times;</button>`
                  : ''
              }
            </div>
          </div>
        `;
      })
      .join('');
  }

  window.switchEntityTab = (tabName) => {
    if (currentEntidad === tabName) return;
    currentEntidad = tabName;
    renderTabs();
    cfdiStatus.innerHTML = '';
    bankStatus.innerHTML = '';
    loadData();
  };

  // 3. Cargar datos del mes y pestania seleccionada desde MongoDB Atlas
  async function loadData() {
    invoiceRows.innerHTML = `<tr><td colspan="11" style="text-align:center; padding:24px; color:var(--text-muted);">Cargando facturas de "${currentEntidad}" desde MongoDB Atlas...</td></tr>`;

    try {
      const res = await fetch(`/api/reconciliation/data?periodo=${currentPeriodo}&entidad=${encodeURIComponent(currentEntidad)}`);
      const data = await res.json();

      if (data.success) {
        cachedInvoices = data.invoices || [];
        cachedUnmatchedMovements = data.unmatchedBankMovements || [];
        updateSummary(data.summary);
        updateCfdiLockState(data.hasCfdiFile, data.summary.totalFacturas);
        renderBankStatements(data.bankStatements || []);
        renderUnmatchedBankMovements();
        updateAnalyzedOptions();
        applyFilterAndRender();

        // Actualizar contador de la pestania activa
        const tabObj = cachedTabs.find((t) => t.nombre === currentEntidad);
        if (tabObj && tabObj.facturasCount !== data.summary.totalFacturas) {
          tabObj.facturasCount = data.summary.totalFacturas;
          renderTabs();
        }
      } else {
        invoiceRows.innerHTML = `<tr><td colspan="11" style="text-align:center; padding:24px; color:var(--error);">${data.message || 'Error cargando datos.'}</td></tr>`;
      }
    } catch (err) {
      console.error('Error cargando datos en dashboard:', err);
      invoiceRows.innerHTML = `<tr><td colspan="11" style="text-align:center; padding:24px; color:var(--error);">${err.message ? `Error: ${err.message}` : 'Error de conexion con el servidor.'}</td></tr>`;
    }
  }

  // 4. Bloqueo de subida si ya existe archivo de facturas del mes y pestania
  function updateCfdiLockState(hasFile, totalInvoices) {
    if (hasFile) {
      btnSelectCfdi.style.display = 'none';
      btnReplaceCfdi.style.display = 'inline-block';
      cfdiStatus.innerHTML = `<span style="color:var(--text-muted); font-size:11px;">1 archivo cargado (${totalInvoices} facturas).</span>`;
    } else {
      btnSelectCfdi.style.display = 'inline-block';
      btnSelectCfdi.disabled = false;
      btnSelectCfdi.textContent = `+ Subir Facturas (${currentEntidad})`;
      btnReplaceCfdi.style.display = 'none';
      cfdiStatus.innerHTML = '';
    }
  }

  // 5. Reemplazar archivo de facturas existente
  btnReplaceCfdi.addEventListener('click', async () => {
    if (!confirm(`¿Deseas eliminar las facturas de "${currentEntidad}" para subir un nuevo archivo?`)) {
      return;
    }

    try {
      const res = await fetch(`/api/reconciliation/cfdi?periodo=${currentPeriodo}&entidad=${encodeURIComponent(currentEntidad)}`, {
        method: 'DELETE'
      });
      const data = await res.json();
      alert(data.message);
      await loadTabs();
      loadData();
    } catch (err) {
      alert('Error al eliminar facturas.');
    }
  });

  // 5. Renderizar lista de estados de cuenta subidos para el mes
  function renderBankStatements(statements) {
    if (!bankFilesList || !bankFilesCount) return;
    bankFilesCount.textContent = statements.length;

    if (!statements || statements.length === 0) {
      bankFilesList.innerHTML = `
        <div class="empty-statements">
          Sin estados de cuenta en este mes.
        </div>
      `;
      return;
    }

    bankFilesList.innerHTML = statements
      .map((st) => {
        let badgeClass = 'bank-badge-generic';
        if (/bbva/i.test(st.banco)) badgeClass = 'bank-badge-bbva';
        else if (/scotia/i.test(st.banco)) badgeClass = 'bank-badge-scotia';

        const uploadDate = st.fechaSubida
          ? new Date(st.fechaSubida).toLocaleString('es-MX', {
              day: '2-digit',
              month: '2-digit',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit'
            })
          : '-';

        return `
          <div class="bank-file-row">
            <div class="bank-file-info">
              <span class="bank-badge ${badgeClass}">${st.banco || 'BANCO'}</span>
              <div>
                <div class="bank-file-name">${st.nombreArchivo}</div>
                <div class="bank-file-meta">
                  ${st.cuenta ? `Cuenta: <strong>${st.cuenta}</strong> | ` : ''}
                  Movimientos: <strong>${st.totalMovimientos}</strong> 
                  (${st.cargosCount} cargos / ${st.abonosCount} abonos) | 
                  ${uploadDate}
                </div>
              </div>
            </div>
            <button type="button" class="btn-delete-statement" onclick="deleteBankStatement('${st._id}', '${st.nombreArchivo}')" title="Eliminar archivo">
              Eliminar
            </button>
          </div>
        `;
      })
      .join('');
  }

  // 6. Eliminar un archivo de estado de cuenta bancario
  window.deleteBankStatement = async (id, filename) => {
    if (!confirm(`¿Deseas eliminar el estado de cuenta "${filename}"?`)) {
      return;
    }

    try {
      bankStatus.innerHTML = `<span style="color:var(--info);">Eliminando archivo...</span>`;
      const res = await fetch(`/api/reconciliation/bank-statement/${id}`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (data.success) {
        bankStatus.innerHTML = `<span style="color:var(--primary); font-weight:600;">${data.message}</span>`;
        loadData();
      } else {
        bankStatus.innerHTML = `<span style="color:var(--error); font-weight:600;">${data.message || 'Error al eliminar.'}</span>`;
      }
    } catch (err) {
      bankStatus.innerHTML = `<span style="color:var(--error);">Error de conexión.</span>`;
    }
  };

  // 7. Actualizar tarjetas de resumen
  function updateSummary(summary) {
    if (!summary) return;
    statTotalAmount.textContent = formatMoney(summary.montoTotal);
    statTotalCount.textContent = `${summary.totalFacturas} facturas`;

    statPaidAmount.textContent = formatMoney(summary.montoPagado);
    statPaidCount.textContent = `${summary.pagadasCount} pagadas`;

    statUnpaidAmount.textContent = formatMoney(summary.montoNoPagado);
    statUnpaidCount.textContent = `${summary.noPagadasCount} pendientes`;

    statCanceledAmount.textContent = formatMoney(summary.montoCancelado);
    statCanceledCount.textContent = `${summary.canceladasCount} canceladas`;

    if (statUnmatchedAmount && statUnmatchedCount) {
      statUnmatchedAmount.textContent = formatMoney(summary.unmatchedBankMonto);
      statUnmatchedCount.textContent = `${summary.unmatchedBankCount || 0} sin factura`;
    }
  }

  // 8. Normalizacion y Comparacion Inteligente de Texto
  function normalizeStr(str) {
    if (!str) return '';
    return str
      .toString()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  }

  function matchesQuery(targetVal, query) {
    if (!query) return true;
    if (!targetVal) return false;

    const normTarget = normalizeStr(targetVal);
    const normQuery = normalizeStr(query);

    if (normTarget.includes(normQuery)) return true;

    // Comparacion compacta sin espacios ni simbolos (permite ej: "walmart" vs "NUEVA WAL MART DE MEXICO")
    const compactTarget = normTarget.replace(/[^a-z0-9]/g, '');
    const compactQuery = normQuery.replace(/[^a-z0-9]/g, '');
    if (compactQuery && compactTarget.includes(compactQuery)) return true;

    // Comparacion token por token
    const tokens = normQuery.split(/\s+/).filter(Boolean);
    if (tokens.length > 1 && tokens.every((tok) => normTarget.includes(tok))) {
      return true;
    }

    return false;
  }

  function checkFieldMatch(inv, field, query) {
    if (!query) return true;
    switch (field) {
      case 'emisor':
        return matchesQuery(inv.emisor, query);
      case 'rfcEmisor':
        return matchesQuery(inv.rfcEmisor, query);
      case 'uuid':
        return matchesQuery(inv.uuid, query);
      case 'estadoPago':
        return matchesQuery(inv.estadoPago, query);
      case 'banco':
        const bancoInfo = `${inv.pagoAsociado?.banco || ''} ${inv.pagoAsociado?.conceptoBanco || ''} ${inv.estadoPago === 'Pagada' ? 'Pagada' : ''}`;
        return matchesQuery(bancoInfo, query);
      case 'observaciones':
        return matchesQuery(inv.observaciones, query);
      case 'all':
      default:
        const allText = `${inv.uuid || ''} ${inv.emisor || ''} ${inv.rfcEmisor || ''} ${inv.total || ''} ${inv.estadoPago || ''} ${inv.pagoAsociado?.banco || ''} ${inv.observaciones || ''}`;
        return matchesQuery(allText, query);
    }
  }

  const FIELD_LABELS = {
    emisor: 'Proveedor',
    rfcEmisor: 'RFC',
    uuid: 'UUID',
    estadoPago: 'Estado',
    banco: 'Banco',
    observaciones: 'Notas',
    all: 'Todos'
  };

  // 9. Extraer Valores Analizados en Automatico para el Campo Seleccionado
  function getAnalyzedFieldValues(field) {
    const map = new Map();

    for (const inv of cachedInvoices) {
      let key = '';
      let secondary = '';

      if (field === 'emisor') {
        key = (inv.emisor || 'Sin Emisor').trim();
        secondary = inv.rfcEmisor || '';
      } else if (field === 'rfcEmisor') {
        key = (inv.rfcEmisor || 'Sin RFC').trim();
        secondary = inv.emisor || '';
      } else if (field === 'uuid') {
        key = (inv.uuid || '').trim();
      } else if (field === 'estadoPago') {
        key = (inv.estadoPago || 'No Pagada').trim();
      } else if (field === 'banco') {
        key = (inv.pagoAsociado?.banco || (inv.estadoPago === 'Pagada' ? 'Banco Conciliado' : 'Sin pago bancario')).trim();
      } else if (field === 'observaciones') {
        if (!inv.observaciones) continue;
        key = inv.observaciones.trim();
      } else {
        key = (inv.emisor || 'Sin Emisor').trim();
        secondary = inv.rfcEmisor || '';
      }

      if (!key) continue;

      if (!map.has(key)) {
        map.set(key, {
          name: key,
          secondary,
          count: 0,
          total: 0,
          pagadasCount: 0,
          pagadasMonto: 0,
          noPagadasCount: 0,
          noPagadasMonto: 0,
          canceladasCount: 0
        });
      }

      const item = map.get(key);
      const monto = Number(inv.total || 0);
      item.count++;
      item.total += monto;

      if (inv.estadoPago === 'Pagada') {
        item.pagadasCount++;
        item.pagadasMonto += monto;
      } else if (inv.estadoPago === 'No Pagada') {
        item.noPagadasCount++;
        item.noPagadasMonto += monto;
      } else if (inv.estadoPago === 'Cancelada') {
        item.canceladasCount++;
      }
    }

    return Array.from(map.values()).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  // 10. Actualizar Opciones del Selector de Analizados y Datalist
  function updateAnalyzedOptions() {
    const list = getAnalyzedFieldValues(selectedField);
    const fieldName = FIELD_LABELS[selectedField] || 'Campo';

    if (labelAnalyzedSelect) {
      labelAnalyzedSelect.textContent = `${fieldName}s (${list.length}):`;
    }
    if (labelSearchInput) {
      labelSearchInput.textContent = `Buscar:`;
    }

    if (searchInput) {
      if (selectedField === 'emisor') {
        searchInput.placeholder = 'Buscar proveedor...';
      } else if (selectedField === 'rfcEmisor') {
        searchInput.placeholder = 'Buscar RFC...';
      } else if (selectedField === 'uuid') {
        searchInput.placeholder = 'Buscar UUID...';
      } else {
        searchInput.placeholder = `Buscar ${fieldName.toLowerCase()}...`;
      }
    }

    if (filterAnalyzedSelect) {
      filterAnalyzedSelect.innerHTML = '';
      const defOpt = document.createElement('option');
      defOpt.value = '';
      defOpt.textContent = `-- Todos (${list.length}) --`;
      filterAnalyzedSelect.appendChild(defOpt);

      for (const item of list) {
        const opt = document.createElement('option');
        opt.value = item.name;
        opt.textContent = `${item.name} (${item.count} · ${formatMoney(item.total)})`;
        filterAnalyzedSelect.appendChild(opt);
      }
    }

    if (analyzedDatalist) {
      analyzedDatalist.innerHTML = '';
      for (const item of list) {
        const dataOpt = document.createElement('option');
        dataOpt.value = item.name;
        dataOpt.label = `${item.count} · ${formatMoney(item.total)}`;
        analyzedDatalist.appendChild(dataOpt);
      }
    }
  }

  // 11. Renderizar Vista Detallada de Facturas
  function renderDetailView(filtered) {
    if (tableContainerDetail) tableContainerDetail.style.display = 'block';
    if (tableContainerGrouped) tableContainerGrouped.style.display = 'none';

    if (filtered.length === 0) {
      invoiceRows.innerHTML = `<tr><td colspan="11" style="text-align:center; padding:24px; color:var(--text-muted);">No se encontraron facturas con el criterio seleccionado.</td></tr>`;
      return;
    }

    invoiceRows.innerHTML = filtered
      .map((inv, index) => {
        let badgeHtml = '';
        if (inv.estadoPago === 'Pagada') {
          badgeHtml = `<span class="badge-paid">Pagada</span>`;
        } else if (inv.estadoPago === 'No Pagada') {
          badgeHtml = `<span class="badge-unpaid">No Pagada</span>`;
        } else if (inv.estadoPago === 'En Revision') {
          badgeHtml = `<span class="badge-warning" style="background:#fef3c7; color:#b45309; padding:2px 6px; border-radius:2px; font-weight:600; font-size:11px;">En Revision</span>`;
        } else if (inv.estadoPago === 'Cancelada') {
          badgeHtml = `<span class="badge-canceled">Cancelada</span>`;
        } else {
          badgeHtml = `<span class="badge-na">${inv.estadoPago}</span>`;
        }

        if (inv.editadoManualmente) {
          badgeHtml += `<br><span class="manual-tag">Manual</span>`;
        }

        let paymentDetailHtml = '<span style="color:var(--text-muted); font-size:11px;">Sin pago registrado</span>';
        if (inv.estadoPago === 'Pagada') {
          if (inv.egresoAsociado && inv.egresoAsociado.uuid) {
            paymentDetailHtml = `
              <div class="payment-detail" style="border-left: 3px solid #6366f1; padding-left: 6px;">
                <span style="font-size:10px; font-weight:700; background:#e0e7ff; color:#3730a3; padding:1px 5px; border-radius:2px;">Nota de Crédito</span>
                <span style="font-size:11.5px; font-weight:600; color:var(--text-main); margin-left:4px;">${formatMoney(inv.egresoAsociado.total || inv.total)}</span><br>
                <span style="font-size:10.5px; color:#4338ca; font-family:monospace;" title="${inv.egresoAsociado.uuid}">${inv.egresoAsociado.uuid.substring(0, 16)}...</span>
              </div>
            `;
          } else if (inv.pagoAsociado && (inv.pagoAsociado.banco || inv.pagoAsociado.montoRetiro)) {
            const p = inv.pagoAsociado;
            const isEgresoPayment = p.banco && p.banco.includes('Nota de Crédito');
            if (isEgresoPayment) {
              paymentDetailHtml = `
                <div class="payment-detail" style="border-left: 3px solid #6366f1; padding-left: 6px;">
                  <span style="font-size:10px; font-weight:700; background:#e0e7ff; color:#3730a3; padding:1px 5px; border-radius:2px;">Nota de Crédito</span>
                  <span style="font-size:11.5px; font-weight:600; color:var(--text-main); margin-left:4px;">${formatMoney(p.montoRetiro || inv.total)}</span><br>
                  <span style="font-size:10.5px; color:#4338ca; font-family:monospace;" title="${p.referencia || ''}">${(p.referencia || '').substring(0, 16)}...</span>
                </div>
              `;
            } else {
              paymentDetailHtml = `
                <div class="payment-detail">
                  <strong>Banco:</strong> ${p.banco || '-'} | <strong>Fecha:</strong> ${p.fechaPago || '-'} | <strong>Monto:</strong> ${formatMoney(p.montoRetiro || inv.total)}<br>
                  <strong>Concepto:</strong> ${p.conceptoBanco || p.banco || 'Retiro bancario'}
                </div>
              `;
            }
          } else {
            paymentDetailHtml = '<span style="color:var(--success); font-weight:600; font-size:11.5px;">✓ Pagada (Manual)</span>';
          }
        } else if (inv.efecto === 'Egreso') {
          if (inv.ingresoAsociado && inv.ingresoAsociado.uuid) {
            paymentDetailHtml = `
              <div class="payment-detail" style="border-left: 3px solid #10b981; padding-left: 6px;">
                <span class="badge-paid" style="font-size:9.5px; padding:1px 5px;">Aplicada a Factura</span><br>
                <span style="font-size:10.5px; color:#065f46; font-family:monospace;" title="${inv.ingresoAsociado.uuid}">${inv.ingresoAsociado.uuid.substring(0, 16)}...</span>
              </div>
            `;
          } else {
            paymentDetailHtml = '<span style="color:var(--text-muted); font-size:11px;">Nota de Crédito disponible</span>';
          }
        } else if (inv.estadoSat === 'Cancelado') {
          paymentDetailHtml = '<span style="color:var(--text-muted); font-size:11px;">Comprobante cancelado en SAT</span>';
        }

        const noteContent = inv.observaciones
          ? `<span class="note-text" title="${inv.observaciones}">${inv.observaciones}</span>`
          : `<span class="empty-note">Sin observaciones</span>`;

        return `
          <tr>
            <td style="text-align:center; font-weight:600; color:var(--text-muted); font-size:11.5px;">${index + 1}</td>
            <td style="font-family:monospace; font-size:11px; word-break:break-all;" title="${inv.uuid}">
              ${inv.uuid ? inv.uuid.substring(0, 18) + '...' : '-'}
            </td>
            <td><strong>${inv.emisor || 'Sin emisor'}</strong></td>
            <td><code style="font-size:11px;">${inv.rfcEmisor || '-'}</code></td>
            <td style="font-size:12px;">${inv.fechaEmision ? inv.fechaEmision.split('T')[0] : '-'}</td>
            <td style="text-align:right; font-weight:600;">${formatMoney(inv.total)}</td>
            <td style="font-size:11.5px;">${inv.efecto || 'Ingreso'}</td>
            <td style="text-align:center;">${badgeHtml}</td>
            <td>${paymentDetailHtml}</td>
            <td>${noteContent}</td>
            <td style="text-align:center;">
              <button type="button" class="btn-action-small" onclick="openEditModal('${inv.uuid}')" title="Editar estado y notas">
                Editar
              </button>
            </td>
          </tr>
        `;
      })
      .join('');
  }

  // 12. Renderizar Vista Agrupada por Emisor Analizado
  function renderGroupedView(filteredInvoices) {
    if (tableContainerDetail) tableContainerDetail.style.display = 'none';
    if (tableContainerGrouped) tableContainerGrouped.style.display = 'block';

    const map = new Map();
    for (const inv of filteredInvoices) {
      const emisor = (inv.emisor || 'Sin Emisor').trim();
      if (!map.has(emisor)) {
        map.set(emisor, {
          emisor,
          rfcEmisor: inv.rfcEmisor || '-',
          count: 0,
          total: 0,
          pagadasCount: 0,
          pagadasMonto: 0,
          noPagadasCount: 0,
          noPagadasMonto: 0,
          canceladasCount: 0
        });
      }
      const item = map.get(emisor);
      const monto = Number(inv.total || 0);
      item.count++;
      item.total += monto;
      if (inv.estadoPago === 'Pagada') {
        item.pagadasCount++;
        item.pagadasMonto += monto;
      } else if (inv.estadoPago === 'No Pagada') {
        item.noPagadasCount++;
        item.noPagadasMonto += monto;
      } else if (inv.estadoPago === 'Cancelada') {
        item.canceladasCount++;
      }
    }

    const list = Array.from(map.values()).sort((a, b) => b.count - a.count || a.emisor.localeCompare(b.emisor));

    if (list.length === 0) {
      groupedRows.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:24px; color:var(--text-muted);">No se encontraron emisores analizados con el criterio actual.</td></tr>`;
      return;
    }

    groupedRows.innerHTML = list
      .map((item, index) => {
        const safeName = item.emisor.replace(/'/g, "\\'");
        return `
          <tr>
            <td style="text-align:center; font-weight:600; color:var(--text-muted); font-size:11.5px;">${index + 1}</td>
            <td><strong>${item.emisor}</strong></td>
            <td><code style="font-size:11px;">${item.rfcEmisor}</code></td>
            <td style="text-align:center; font-weight:700; color:var(--primary); font-size:12.5px;">${item.count}</td>
            <td style="text-align:right; font-weight:700;">${formatMoney(item.total)}</td>
            <td>
              <span class="badge-paid">${item.pagadasCount}</span>
              <span style="font-size:11.5px; color:var(--text-muted); margin-left:4px;">(${formatMoney(item.pagadasMonto)})</span>
            </td>
            <td>
              <span class="badge-unpaid">${item.noPagadasCount}</span>
              <span style="font-size:11.5px; color:var(--text-muted); margin-left:4px;">(${formatMoney(item.noPagadasMonto)})</span>
            </td>
            <td style="text-align:center;">
              ${item.canceladasCount > 0 ? `<span class="badge-canceled">${item.canceladasCount}</span>` : '<span style="color:var(--text-muted); font-size:11px;">0</span>'}
            </td>
            <td style="text-align:center;">
              <button type="button" class="btn-action-small" onclick="filterByEmisor('${safeName}')" title="Ver detalle de facturas analizadas de ${item.emisor}">
                Ver Facturas
              </button>
            </td>
          </tr>
        `;
      })
      .join('');
  }

  // 13. Aplicar Filtro y Renderizar
  function applyFilterAndRender() {
    const query = (searchInput?.value || '').trim();
    const minPriceVal = parseFloat(filterMinPrice?.value);
    const maxPriceVal = parseFloat(filterMaxPrice?.value);
    const hasMinPrice = !isNaN(minPriceVal) && minPriceVal >= 0;
    const hasMaxPrice = !isNaN(maxPriceVal) && maxPriceVal >= 0;

    if (btnClearPriceFilter) {
      btnClearPriceFilter.style.display = (hasMinPrice || hasMaxPrice) ? 'inline-block' : 'none';
    }

    // Filtrar facturas
    const filtered = cachedInvoices.filter((inv) => {
      if (currentFilter === 'pagadas' && inv.estadoPago !== 'Pagada') return false;
      if (currentFilter === 'no_pagadas' && inv.estadoPago !== 'No Pagada') return false;
      if (currentFilter === 'egresos' && inv.efecto !== 'Egreso') return false;
      if (currentFilter === 'canceladas' && inv.estadoPago !== 'Cancelada') return false;

      const invTotal = Number(inv.total || 0);
      if (hasMinPrice && invTotal < minPriceVal) return false;
      if (hasMaxPrice && invTotal > maxPriceVal) return false;

      if (query) {
        return checkFieldMatch(inv, selectedField, query);
      }
      return true;
    });

    // Control del banner de filtro activo y boton limpiar
    if (query) {
      if (btnClearSearch) btnClearSearch.style.display = 'block';
      if (activeFilterIndicator) {
        activeFilterIndicator.style.display = 'flex';
        if (indicatorField) indicatorField.textContent = FIELD_LABELS[selectedField] || selectedField;
        if (indicatorQuery) indicatorQuery.textContent = `"${query}"`;

        let filterPaid = 0;
        let filterUnpaid = 0;
        let filterTotal = 0;
        for (const f of filtered) {
          filterTotal += Number(f.total || 0);
          if (f.estadoPago === 'Pagada') filterPaid++;
          else if (f.estadoPago === 'No Pagada') filterUnpaid++;
        }
        if (indicatorStats) {
          indicatorStats.textContent = `(${filtered.length} facturas · Total: ${formatMoney(filterTotal)})`;
        }
      }
    } else {
      if (btnClearSearch) btnClearSearch.style.display = 'none';
      if (activeFilterIndicator) activeFilterIndicator.style.display = 'none';
    }

    if (showingCount) {
      showingCount.textContent = `${filtered.length} de ${cachedInvoices.length} facturas`;
    }

    // Renderizar segun vista activa
    if (currentViewMode === 'grouped') {
      renderGroupedView(filtered);
    } else {
      renderDetailView(filtered);
    }
  }

  // 14. Eventos de Filtro por Campo y Analizados
  if (filterFieldSelect) {
    filterFieldSelect.addEventListener('change', () => {
      selectedField = filterFieldSelect.value;
      updateAnalyzedOptions();
      applyFilterAndRender();
    });
  }

  if (filterAnalyzedSelect) {
    filterAnalyzedSelect.addEventListener('change', () => {
      searchInput.value = filterAnalyzedSelect.value;
      applyFilterAndRender();
    });
  }

  if (searchInput) {
    searchInput.addEventListener('input', () => {
      // Sincronizar el select de analizados si coincide exactamente
      if (filterAnalyzedSelect) {
        const val = searchInput.value.trim();
        const hasMatch = Array.from(filterAnalyzedSelect.options).some((o) => o.value && o.value.toLowerCase() === val.toLowerCase());
        if (hasMatch) {
          filterAnalyzedSelect.value = val;
        } else {
          filterAnalyzedSelect.value = '';
        }
      }
      applyFilterAndRender();
    });
  }

  if (btnClearSearch) {
    btnClearSearch.addEventListener('click', () => {
      searchInput.value = '';
      if (filterAnalyzedSelect) filterAnalyzedSelect.value = '';
      applyFilterAndRender();
      searchInput.focus();
    });
  }

  if (btnClearBanner) {
    btnClearBanner.addEventListener('click', () => {
      searchInput.value = '';
      if (filterAnalyzedSelect) filterAnalyzedSelect.value = '';
      applyFilterAndRender();
    });
  }

  // Eventos de filtro por rango de importes en Facturas
  if (filterMinPrice) {
    filterMinPrice.addEventListener('input', () => {
      applyFilterAndRender();
    });
  }
  if (filterMaxPrice) {
    filterMaxPrice.addEventListener('input', () => {
      applyFilterAndRender();
    });
  }

  window.clearInvoicePriceFilter = () => {
    if (filterMinPrice) filterMinPrice.value = '';
    if (filterMaxPrice) filterMaxPrice.value = '';
    if (btnClearPriceFilter) btnClearPriceFilter.style.display = 'none';
    applyFilterAndRender();
  };

  // Alternar Modos de Vista
  if (btnViewDetail) {
    btnViewDetail.addEventListener('click', () => {
      currentViewMode = 'detail';
      btnViewDetail.classList.add('active');
      if (btnViewGrouped) btnViewGrouped.classList.remove('active');
      applyFilterAndRender();
    });
  }

  if (btnViewGrouped) {
    btnViewGrouped.addEventListener('click', () => {
      currentViewMode = 'grouped';
      btnViewGrouped.classList.add('active');
      if (btnViewDetail) btnViewDetail.classList.remove('active');
      applyFilterAndRender();
    });
  }

  // Accion rapida desde vista agrupada para filtrar por emisor
  window.filterByEmisor = (emisorName) => {
    selectedField = 'emisor';
    if (filterFieldSelect) filterFieldSelect.value = 'emisor';
    updateAnalyzedOptions();
    if (searchInput) searchInput.value = emisorName;
    if (filterAnalyzedSelect) filterAnalyzedSelect.value = emisorName;
    currentViewMode = 'detail';
    if (btnViewDetail) btnViewDetail.classList.add('active');
    if (btnViewGrouped) btnViewGrouped.classList.remove('active');
    applyFilterAndRender();
  };

  // Pestanias de estado SAT (Todas, Pagadas, No Pagadas, Egresos, Canceladas)
  document.querySelectorAll('.filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      applyFilterAndRender();
    });
  });

  // 11. Subir archivo SAT Consulta CFDI con validacion de mes
  cfdiFileInput.addEventListener('change', async () => {
    if (!cfdiFileInput.files || cfdiFileInput.files.length === 0) return;

    const file = cfdiFileInput.files[0];
    cfdiStatus.innerHTML = `<span style="color:var(--info);">Verificando periodo y procesando facturas...</span>`;

    const formData = new FormData();
    formData.append('cfdiPdf', file);
    formData.append('periodo', currentPeriodo);
    formData.append('entidad', currentEntidad);

    try {
      const res = await fetch('/api/reconciliation/upload-cfdi', {
        method: 'POST',
        body: formData
      });
      const data = await res.json();

      if (res.ok && data.success) {
        cfdiStatus.innerHTML = `<span style="color:var(--primary); font-weight:600;">${data.message}</span>`;
        await loadTabs();
        loadData();
      } else {
        cfdiStatus.innerHTML = `<span style="color:var(--error); font-weight:600;">${data.message || 'Error al procesar archivo.'}</span>`;
      }
    } catch (err) {
      cfdiStatus.innerHTML = `<span style="color:var(--error);">Error de conexion al subir archivo.</span>`;
    } finally {
      cfdiFileInput.value = '';
    }
  });

  // 12. Subir N archivos de Estado de Cuenta con validacion de mes y pestania
  bankFilesInput.addEventListener('change', async () => {
    if (!bankFilesInput.files || bankFilesInput.files.length === 0) return;

    const files = bankFilesInput.files;
    bankStatus.innerHTML = `<span style="color:var(--info);">Validando y procesando ${files.length} archivo(s)...</span>`;

    const formData = new FormData();
    for (let i = 0; i < files.length; i++) {
      formData.append('bankPdfs', files[i]);
    }
    formData.append('periodo', currentPeriodo);
    formData.append('entidad', currentEntidad);

    try {
      const res = await fetch('/api/reconciliation/upload-bank', {
        method: 'POST',
        body: formData
      });
      const data = await res.json();

      if (res.ok && data.success) {
        bankStatus.innerHTML = `<span style="color:var(--primary); font-weight:600;">${data.message}</span>`;
        await loadTabs();
        loadData();
      } else {
        bankStatus.innerHTML = `<span style="color:var(--error); font-weight:600;">${data.message || 'Error al procesar estados.'}</span>`;
      }
    } catch (err) {
      bankStatus.innerHTML = `<span style="color:var(--error);">Error de conexion al subir estados.</span>`;
    } finally {
      bankFilesInput.value = '';
    }
  });

  // 13. Exportar a CSV por periodo y pestania
  btnExportCsv.addEventListener('click', () => {
    window.location.href = `/api/reconciliation/export-csv?periodo=${currentPeriodo}&entidad=${encodeURIComponent(currentEntidad)}`;
  });

  // 14. Logica de Modal para Editar Estado, Vincular por Importe y Observaciones de una Factura
  let activeEditingUuid = null;
  const editModal = document.getElementById('edit-invoice-modal');
  const modalEditTitle = document.getElementById('modal-edit-title');
  const modalEmisor = document.getElementById('modal-emisor');
  const modalUuid = document.getElementById('modal-uuid');
  const modalTotal = document.getElementById('modal-total');
  const modalFecha = document.getElementById('modal-fecha');
  const modalEfecto = document.getElementById('modal-efecto');
  const modalEstadoPago = document.getElementById('modal-estado-pago');
  const modalObservaciones = document.getElementById('modal-observaciones');
  const modalStatus = document.getElementById('modal-status');
  const btnResetAuto = document.getElementById('btn-reset-auto');
  const btnSaveInvoice = document.getElementById('btn-save-invoice');
  const modalQuickPayBar = document.getElementById('modal-quick-pay-bar');
  const modalCurrentBadge = document.getElementById('modal-current-badge');
  const btnQuickMarkPaid = document.getElementById('btn-quick-mark-paid');
  const modalBankMatchBadge = document.getElementById('modal-bank-match-badge');
  const modalLinkedPaymentCard = document.getElementById('modal-linked-payment-card');
  const modalLinkedBanco = document.getElementById('modal-linked-banco');
  const modalLinkedMonto = document.getElementById('modal-linked-monto');
  const modalLinkedFecha = document.getElementById('modal-linked-fecha');
  const modalLinkedConcepto = document.getElementById('modal-linked-concepto');
  const modalBankCandidatesSection = document.getElementById('modal-bank-candidates-section');
  const modalBankSearchInput = document.getElementById('modal-bank-search-input');
  const modalBankCandidatesList = document.getElementById('modal-bank-candidates-list');

  // Elementos de la seccion de Notas de Credito (Egresos)
  const modalEgresoSection = document.getElementById('modal-egreso-section');
  const modalEgresoMatchBadge = document.getElementById('modal-egreso-match-badge');
  const modalLinkedEgresoCard = document.getElementById('modal-linked-egreso-card');
  const modalLinkedEgresoMonto = document.getElementById('modal-linked-egreso-monto');
  const modalLinkedEgresoFecha = document.getElementById('modal-linked-egreso-fecha');
  const modalLinkedEgresoUuid = document.getElementById('modal-linked-egreso-uuid');
  const modalEgresoCandidatesContainer = document.getElementById('modal-egreso-candidates-container');
  const modalEgresoSearchInput = document.getElementById('modal-egreso-search-input');
  const modalEgresoCandidatesList = document.getElementById('modal-egreso-candidates-list');

  window.openEditModal = (uuid, focusPayment = false) => {
    const inv = cachedInvoices.find((i) => i.uuid === uuid);
    if (!inv) return;

    activeEditingUuid = uuid;
    if (modalEditTitle) modalEditTitle.textContent = focusPayment ? 'Vincular Pago / Nota de Crédito' : 'Factura y Pago';
    if (modalEmisor) modalEmisor.textContent = inv.emisor || 'Sin emisor registrado';
    if (modalUuid) modalUuid.textContent = inv.uuid;
    if (modalTotal) modalTotal.textContent = formatMoney(inv.total);
    if (modalFecha) modalFecha.textContent = inv.fechaEmision ? String(inv.fechaEmision).split('T')[0] : '-';
    if (modalEfecto) modalEfecto.textContent = inv.efecto || 'Ingreso';
    if (modalEstadoPago) modalEstadoPago.value = inv.estadoPago || 'No Pagada';
    if (modalObservaciones) modalObservaciones.value = inv.observaciones || '';
    if (modalStatus) modalStatus.innerHTML = '';
    if (modalBankSearchInput) modalBankSearchInput.value = '';
    if (modalEgresoSearchInput) modalEgresoSearchInput.value = '';

    // Badge de estado actual en barra rapida
    if (modalCurrentBadge) {
      if (inv.estadoPago === 'Pagada') {
        modalCurrentBadge.className = 'badge-paid';
        modalCurrentBadge.textContent = 'Pagada';
      } else if (inv.estadoPago === 'No Pagada') {
        modalCurrentBadge.className = 'badge-unpaid';
        modalCurrentBadge.textContent = 'No Pagada';
      } else if (inv.estadoPago === 'Cancelada') {
        modalCurrentBadge.className = 'badge-canceled';
        modalCurrentBadge.textContent = 'Cancelada';
      } else {
        modalCurrentBadge.className = 'badge-na';
        modalCurrentBadge.textContent = inv.estadoPago || 'No Pagada';
      }
    }

    if (btnQuickMarkPaid) {
      btnQuickMarkPaid.style.display = inv.estadoPago === 'Pagada' ? 'none' : 'inline-block';
    }

    // Gestion de seccion de Notas de Credito (Egresos)
    if (inv.efecto === 'Egreso') {
      if (modalEgresoSection) modalEgresoSection.style.display = 'none';
    } else {
      if (modalEgresoSection) modalEgresoSection.style.display = 'block';

      const hasLinkedEgreso = (inv.egresoAsociado && inv.egresoAsociado.uuid) || (inv.pagoAsociado?.banco && inv.pagoAsociado.banco.includes('Nota de Crédito'));
      if (hasLinkedEgreso && inv.estadoPago === 'Pagada') {
        const egUuid = inv.egresoAsociado?.uuid || inv.pagoAsociado?.referencia || '';
        const egTotal = inv.egresoAsociado?.total || inv.pagoAsociado?.montoRetiro || inv.total;
        const egFecha = inv.egresoAsociado?.fechaEmision || inv.pagoAsociado?.fechaPago || '-';
        const egEmisor = inv.egresoAsociado?.emisor || inv.emisor || '';

        if (modalLinkedEgresoCard) modalLinkedEgresoCard.style.display = 'block';
        if (modalLinkedEgresoMonto) modalLinkedEgresoMonto.textContent = formatMoney(egTotal);
        if (modalLinkedEgresoFecha) modalLinkedEgresoFecha.textContent = `Fecha: ${String(egFecha).split('T')[0]}`;
        if (modalLinkedEgresoUuid) modalLinkedEgresoUuid.textContent = `${egUuid} (${egEmisor})`;
        if (modalEgresoCandidatesContainer) modalEgresoCandidatesContainer.style.display = 'none';
        if (modalEgresoMatchBadge) {
          modalEgresoMatchBadge.className = 'badge-paid';
          modalEgresoMatchBadge.textContent = 'Nota de Crédito Vinculada';
        }
      } else {
        if (modalLinkedEgresoCard) modalLinkedEgresoCard.style.display = 'none';
        if (modalEgresoCandidatesContainer) modalEgresoCandidatesContainer.style.display = 'block';
        renderModalEgresoCandidates();
      }
    }

    // Comprobar si ya tiene un pago bancario vinculado
    const hasLinkedBank = inv.pagoAsociado && (inv.pagoAsociado.movimientoId || (inv.pagoAsociado.banco && !inv.pagoAsociado.banco.includes('Nota de Crédito')));
    if (hasLinkedBank && inv.estadoPago === 'Pagada') {
      if (modalLinkedPaymentCard) modalLinkedPaymentCard.style.display = 'block';
      if (modalLinkedBanco) modalLinkedBanco.textContent = inv.pagoAsociado.banco || 'BANCO';
      if (modalLinkedMonto) modalLinkedMonto.textContent = formatMoney(inv.pagoAsociado.montoRetiro || inv.total);
      if (modalLinkedFecha) modalLinkedFecha.textContent = `Fecha: ${inv.pagoAsociado.fechaPago || '-'}`;
      if (modalLinkedConcepto) modalLinkedConcepto.textContent = inv.pagoAsociado.conceptoBanco || 'Retiro bancario vinculado';
      if (modalBankCandidatesSection) modalBankCandidatesSection.style.display = 'none';
      if (modalBankMatchBadge) {
        modalBankMatchBadge.className = 'badge-paid';
        modalBankMatchBadge.textContent = 'Pago Vinculado';
      }
    } else {
      if (modalLinkedPaymentCard) modalLinkedPaymentCard.style.display = 'none';
      if (modalBankCandidatesSection) modalBankCandidatesSection.style.display = 'block';
      renderModalBankCandidates();
    }

    if (inv.editadoManualmente) {
      btnResetAuto.style.display = 'inline-block';
    } else {
      btnResetAuto.style.display = 'none';
    }

    editModal.classList.remove('hidden');
    setTimeout(() => {
      if (focusPayment && modalBankSearchInput) {
        modalBankSearchInput.focus();
      } else if (modalObservaciones) {
        modalObservaciones.focus();
      }
    }, 50);
  };

  window.openLinkPaymentModal = (uuid) => {
    window.openEditModal(uuid, true);
  };

  // Renderizar candidatos de Notas de Credito (Egresos)
  window.renderModalEgresoCandidates = () => {
    if (!activeEditingUuid || !modalEgresoCandidatesList) return;
    const inv = cachedInvoices.find((i) => i.uuid === activeEditingUuid);
    if (!inv || inv.efecto === 'Egreso') return;

    const query = (modalEgresoSearchInput?.value || '').trim().toLowerCase();
    const invTotal = Number(inv.total || 0);

    // Filtrar facturas de tipo Egreso (Notas de Credito) de la misma pestania
    let candidates = (cachedInvoices || []).filter(
      (i) => i.efecto === 'Egreso' && (!i.ingresoAsociado?.uuid || i.ingresoAsociado.uuid === inv.uuid)
    );

    if (query) {
      candidates = candidates.filter((e) => {
        const text = `${e.uuid || ''} ${e.emisor || ''} ${e.rfcEmisor || ''} ${e.total || ''} ${e.fechaEmision || ''}`.toLowerCase();
        return text.includes(query);
      });
    }

    // Ordenar: primero los de igual RFC emisor, luego por cercania de importe
    candidates.sort((a, b) => {
      const rfcMatchA = a.rfcEmisor === inv.rfcEmisor ? 1 : 0;
      const rfcMatchB = b.rfcEmisor === inv.rfcEmisor ? 1 : 0;
      if (rfcMatchA !== rfcMatchB) return rfcMatchB - rfcMatchA;

      const diffA = Math.abs(Number(a.total || 0) - invTotal);
      const diffB = Math.abs(Number(b.total || 0) - invTotal);
      return diffA - diffB;
    });

    const exactMatches = candidates.filter(
      (e) => e.rfcEmisor === inv.rfcEmisor && Math.abs(Number(e.total || 0) - invTotal) < 0.01
    );

    if (modalEgresoMatchBadge) {
      if (exactMatches.length > 0) {
        modalEgresoMatchBadge.className = 'badge-paid';
        modalEgresoMatchBadge.textContent = `${exactMatches.length} con proveedor e importe exacto (${formatMoney(invTotal)})`;
      } else if (candidates.length > 0) {
        modalEgresoMatchBadge.className = 'badge-na';
        modalEgresoMatchBadge.textContent = `${candidates.length} Notas de Crédito disponibles`;
      } else {
        modalEgresoMatchBadge.className = 'badge-na';
        modalEgresoMatchBadge.textContent = 'Sin notas de crédito disponibles';
      }
    }

    if (candidates.length === 0) {
      modalEgresoCandidatesList.innerHTML = `
        <div style="padding:12px; text-align:center; font-size:11.5px; color:var(--text-muted);">
          No se encontraron Notas de Crédito (Egresos) disponibles para vincular.
        </div>
      `;
      return;
    }

    modalEgresoCandidatesList.innerHTML = candidates
      .map((e) => {
        const diff = Math.abs(Number(e.total || 0) - invTotal);
        const isExact = diff < 0.01 && e.rfcEmisor === inv.rfcEmisor;
        const isSameRfc = e.rfcEmisor === inv.rfcEmisor;

        return `
          <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 10px; border-bottom:1px solid #f3f4f6; gap:8px;">
            <div style="flex:1; min-width:0;">
              <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                <span class="badge-warning" style="font-size:9.5px; padding:1px 5px; border-radius:2px; background:#e0e7ff; color:#3730a3; font-weight:700;">EGRESO</span>
                <strong style="font-size:12px; color:var(--text-main);">${formatMoney(e.total)}</strong>
                ${isExact ? '<span class="badge-paid" style="font-size:9.5px; padding:1px 4px;">Mismo Proveedor e Importe</span>' : (isSameRfc ? '<span style="font-size:10px; color:#1e40af; background:#dbeafe; padding:1px 4px; border-radius:2px;">Mismo Proveedor</span>' : `<span style="font-size:10.5px; color:var(--text-muted);">Dif: $${diff.toFixed(2)}</span>`)}
                <span style="font-size:11px; color:var(--text-muted);">${e.fechaEmision ? String(e.fechaEmision).split('T')[0] : ''}</span>
              </div>
              <div style="font-size:11px; color:var(--text-muted); font-family:monospace; margin-top:2px;">
                ${e.uuid.substring(0, 20)}... (${e.emisor || 'Sin emisor'})
              </div>
            </div>
            <button type="button" class="btn-action-small btn-action-primary" onclick="linkInvoiceToEgreso('${e.uuid}')" style="font-size:11px; padding:3px 8px; white-space:nowrap; background:#4338ca; border-color:#4338ca;">
              Vincular Egreso
            </button>
          </div>
        `;
      })
      .join('');
  };

  window.linkInvoiceToEgreso = async (egresoUuid) => {
    if (!activeEditingUuid) return;
    const inv = cachedInvoices.find((i) => i.uuid === activeEditingUuid);
    const eg = cachedInvoices.find((i) => i.uuid === egresoUuid);

    const confirmMsg = `¿Deseas vincular esta factura de Ingreso (${formatMoney(inv?.total)}) con la Nota de Crédito / Egreso (${formatMoney(eg?.total)})?\nLa factura quedará registrada como "Pagada".`;
    if (!confirm(confirmMsg)) return;

    if (modalStatus) modalStatus.innerHTML = '<span style="color:var(--info);">Vinculando con Nota de Crédito...</span>';

    try {
      const res = await fetch('/api/reconciliation/link-egreso', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ingresoUuid: activeEditingUuid,
          egresoUuid,
          observaciones: `Amortizada con Nota de Crédito ${egresoUuid.substring(0, 8)}...`
        })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        closeEditModal();
        await loadTabs();
        loadData();
      } else {
        if (modalStatus) modalStatus.innerHTML = `<span style="color:var(--error); font-weight:600;">${data.message || 'Error al vincular con Egreso.'}</span>`;
      }
    } catch (err) {
      if (modalStatus) modalStatus.innerHTML = '<span style="color:var(--error);">Error de conexión con el servidor.</span>';
    }
  };

  window.unlinkInvoiceEgreso = async () => {
    if (!activeEditingUuid) return;
    if (!confirm('¿Deseas desvincular la Nota de Crédito de esta factura? Pasará a estado "No Pagada".')) {
      return;
    }

    if (modalStatus) modalStatus.innerHTML = '<span style="color:var(--info);">Desvinculando Nota de Crédito...</span>';

    try {
      const res = await fetch('/api/reconciliation/unlink-egreso', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ingresoUuid: activeEditingUuid
        })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        closeEditModal();
        await loadTabs();
        loadData();
      } else {
        if (modalStatus) modalStatus.innerHTML = `<span style="color:var(--error); font-weight:600;">${data.message || 'Error al desvincular.'}</span>`;
      }
    } catch (err) {
      if (modalStatus) modalStatus.innerHTML = '<span style="color:var(--error);">Error de conexión con el servidor.</span>';
    }
  };

  window.triggerAutoLinkEgresos = async () => {
    if (
      !confirm(
        `¿Deseas auto-vincular todas las facturas de Ingreso con sus Notas de Crédito (Egresos) de monto y proveedor idénticos para "${currentEntidad}" en el periodo ${currentPeriodo}?\n\nLas facturas con coincidencia exacta quedarán registradas como "Pagadas".`
      )
    ) {
      return;
    }

    const btn = document.getElementById('btn-auto-link-egresos');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '⏳ Vinculando...';
    }

    try {
      const res = await fetch('/api/reconciliation/auto-link-egresos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          periodo: currentPeriodo,
          entidad: currentEntidad
        })
      });

      const data = await res.json();
      if (data.success) {
        alert(data.message);
        await loadTabs();
        loadData();
      } else {
        alert(data.message || 'Error al auto-vincular Notas de Crédito.');
      }
    } catch (err) {
      alert('Error de conexión al auto-vincular.');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '⚡ Auto-vincular Notas de Crédito';
      }
    }
  };

  window.renderModalBankCandidates = () => {
    if (!activeEditingUuid || !modalBankCandidatesList) return;
    const inv = cachedInvoices.find((i) => i.uuid === activeEditingUuid);
    if (!inv) return;

    const query = (modalBankSearchInput?.value || '').trim().toLowerCase();
    const invTotal = Number(inv.total || 0);

    // Filtrar retiros disponibles
    let candidates = (cachedUnmatchedMovements || []).slice();

    if (query) {
      candidates = candidates.filter((m) => {
        const text = `${m.concepto || ''} ${m.banco || ''} ${m.monto || ''} ${m.fecha || ''} ${m.rfcDetectado || ''}`.toLowerCase();
        return text.includes(query);
      });
    }

    // Ordenar por diferencia con el importe de la factura
    candidates.sort((a, b) => {
      const diffA = Math.abs(Number(a.monto || 0) - invTotal);
      const diffB = Math.abs(Number(b.monto || 0) - invTotal);
      return diffA - diffB;
    });

    const exactMatches = candidates.filter((m) => Math.abs(Number(m.monto || 0) - invTotal) < 0.01);

    if (modalBankMatchBadge) {
      if (exactMatches.length > 0) {
        modalBankMatchBadge.className = 'badge-paid';
        modalBankMatchBadge.textContent = `${exactMatches.length} con importe exacto (${formatMoney(invTotal)})`;
      } else if (candidates.length > 0) {
        modalBankMatchBadge.className = 'badge-na';
        modalBankMatchBadge.textContent = `Buscando importe: ${formatMoney(invTotal)}`;
      } else {
        modalBankMatchBadge.className = 'badge-na';
        modalBankMatchBadge.textContent = 'Sin retiros disponibles';
      }
    }

    if (candidates.length === 0) {
      modalBankCandidatesList.innerHTML = `
        <div style="padding:14px; text-align:center; font-size:11.5px; color:var(--text-muted);">
          No se encontraron retiros bancarios disponibles en esta pestaña.
        </div>
      `;
      return;
    }

    modalBankCandidatesList.innerHTML = candidates
      .map((m) => {
        const diff = Math.abs(Number(m.monto || 0) - invTotal);
        const isExact = diff < 0.01;
        let badgeBankClass = 'bank-badge-generic';
        if (/bbva/i.test(m.banco)) badgeBankClass = 'bank-badge-bbva';
        else if (/scotia/i.test(m.banco)) badgeBankClass = 'bank-badge-scotia';

        return `
          <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 10px; border-bottom:1px solid #f3f4f6; gap:8px;">
            <div style="flex:1; min-width:0;">
              <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                <span class="bank-badge ${badgeBankClass}" style="font-size:9.5px; padding:1px 5px;">${m.banco || 'BANCO'}</span>
                <strong style="font-size:12px; color:var(--text-main);">${formatMoney(m.monto)}</strong>
                ${isExact ? '<span class="badge-paid" style="font-size:9.5px; padding:1px 4px;">Monto Exacto</span>' : `<span style="font-size:10.5px; color:var(--text-muted);">Dif: $${diff.toFixed(2)}</span>`}
                <span style="font-size:11px; color:var(--text-muted);">${m.fecha || ''}</span>
              </div>
              <div style="font-size:11px; color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:2px;" title="${m.concepto || ''}">
                ${m.concepto || 'Retiro bancario'}
              </div>
            </div>
            <button type="button" class="btn-action-small btn-action-primary" onclick="linkInvoiceToBankMovement('${m._id}')" style="font-size:11px; padding:3px 8px; white-space:nowrap;">
              Vincular
            </button>
          </div>
        `;
      })
      .join('');
  };

  window.linkInvoiceToBankMovement = async (movimientoId) => {
    if (!activeEditingUuid) return;
    const inv = cachedInvoices.find((i) => i.uuid === activeEditingUuid);
    const m = (cachedUnmatchedMovements || []).find((x) => String(x._id) === String(movimientoId));

    const confirmMsg = `¿Deseas vincular esta factura (${formatMoney(inv?.total)}) con el retiro bancario de ${formatMoney(m?.monto)}? La factura quedará registrada como "Pagada".`;
    if (!confirm(confirmMsg)) return;

    if (modalStatus) modalStatus.innerHTML = '<span style="color:var(--info);">Vinculando pago bancario...</span>';

    try {
      const res = await fetch('/api/reconciliation/link-manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          movimientoId,
          invoiceUuid: activeEditingUuid,
          observaciones: 'Conciliado manualmente por coincidencia de importe'
        })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        closeEditModal();
        await loadTabs();
        loadData();
      } else {
        if (modalStatus) modalStatus.innerHTML = `<span style="color:var(--error); font-weight:600;">${data.message || 'Error al vincular.'}</span>`;
      }
    } catch (err) {
      if (modalStatus) modalStatus.innerHTML = '<span style="color:var(--error);">Error de conexión con el servidor.</span>';
    }
  };

  window.setModalStateToPaid = async () => {
    if (!activeEditingUuid) return;
    if (modalEstadoPago) modalEstadoPago.value = 'Pagada';
    if (modalCurrentBadge) {
      modalCurrentBadge.className = 'badge-paid';
      modalCurrentBadge.textContent = 'Pagada';
    }
    if (btnQuickMarkPaid) btnQuickMarkPaid.style.display = 'none';
    await saveInvoiceEdit();
  };

  window.unlinkInvoicePayment = async () => {
    if (!activeEditingUuid) return;
    if (!confirm('¿Deseas desvincular el pago bancario de esta factura? Pasará a estado "No Pagada".')) {
      return;
    }

    if (modalStatus) modalStatus.innerHTML = '<span style="color:var(--info);">Desvinculando pago...</span>';

    try {
      const res = await fetch('/api/reconciliation/unlink-manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          invoiceUuid: activeEditingUuid
        })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        closeEditModal();
        await loadTabs();
        loadData();
      } else {
        if (modalStatus) modalStatus.innerHTML = `<span style="color:var(--error); font-weight:600;">${data.message || 'Error al desvincular.'}</span>`;
      }
    } catch (err) {
      if (modalStatus) modalStatus.innerHTML = '<span style="color:var(--error);">Error de conexión con el servidor.</span>';
    }
  };

  window.closeEditModal = () => {
    activeEditingUuid = null;
    modalStatus.innerHTML = '';
    editModal.classList.add('hidden');
  };

  window.saveInvoiceEdit = async () => {
    if (!activeEditingUuid) return;

    const newEstado = modalEstadoPago.value;
    const newObservaciones = modalObservaciones.value.trim();

    modalStatus.innerHTML = '<span style="color:var(--info);">Guardando modificacion...</span>';
    btnSaveInvoice.disabled = true;

    try {
      const res = await fetch(`/api/reconciliation/invoice/${activeEditingUuid}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          estadoPago: newEstado,
          observaciones: newObservaciones
        })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        // Actualizar datos en memoria
        const target = cachedInvoices.find((i) => i.uuid === activeEditingUuid);
        if (target) {
          target.estadoPago = newEstado;
          target.observaciones = newObservaciones;
          target.editadoManualmente = true;
          target.fechaEdicionManual = new Date();
        }

        applyFilterAndRender();
        closeEditModal();
        // Sincronizar totales de resumen con backend
        loadData();
      } else {
        modalStatus.innerHTML = `<span style="color:var(--error); font-weight:600;">${data.message || 'Error al guardar.'}</span>`;
      }
    } catch (err) {
      modalStatus.innerHTML = `<span style="color:var(--error);">Error de conexion con el servidor.</span>`;
    } finally {
      btnSaveInvoice.disabled = false;
    }
  };

  window.resetInvoiceAuto = async () => {
    if (!activeEditingUuid) return;

    if (!confirm('Desea restablecer esta factura al calculo automatico de conciliacion con los estados de cuenta bancarios?')) {
      return;
    }

    modalStatus.innerHTML = '<span style="color:var(--info);">Restableciendo a automatico...</span>';
    btnResetAuto.disabled = true;

    try {
      const res = await fetch(`/api/reconciliation/invoice/${activeEditingUuid}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resetAuto: true,
          observaciones: modalObservaciones.value.trim()
        })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        closeEditModal();
        loadData();
      } else {
        modalStatus.innerHTML = `<span style="color:var(--error); font-weight:600;">${data.message || 'Error al restablecer.'}</span>`;
      }
    } catch (err) {
      modalStatus.innerHTML = `<span style="color:var(--error);">Error de conexion al restablecer.</span>`;
    } finally {
      btnResetAuto.disabled = false;
    }
  };

  // 15. Gestion de Modales para Crear, Renombrar y Eliminar Pestanias
  window.openCreateTabModal = () => {
    modalCreateTabPeriod.textContent = currentPeriodo;
    inputNewTabName.value = '';
    createTabStatus.innerHTML = '';
    createTabModal.classList.remove('hidden');
    setTimeout(() => inputNewTabName.focus(), 50);
  };

  window.closeCreateTabModal = () => {
    createTabModal.classList.add('hidden');
  };

  window.submitCreateTab = async () => {
    const name = inputNewTabName.value.trim();
    if (!name) {
      createTabStatus.innerHTML = '<span style="color:var(--error);">Ingrese un nombre para la pestania.</span>';
      return;
    }

    createTabStatus.innerHTML = '<span style="color:var(--info);">Creando pestania...</span>';
    btnSubmitCreateTab.disabled = true;

    try {
      const res = await fetch('/api/reconciliation/tabs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ periodo: currentPeriodo, nombre: name })
      });
      const data = await res.json();

      if (res.ok && data.success) {
        currentEntidad = name;
        closeCreateTabModal();
        await loadTabs();
        loadData();
      } else {
        createTabStatus.innerHTML = `<span style="color:var(--error); font-weight:600;">${data.message || 'Error al crear pestania.'}</span>`;
      }
    } catch (err) {
      createTabStatus.innerHTML = '<span style="color:var(--error);">Error de red al crear pestania.</span>';
    } finally {
      btnSubmitCreateTab.disabled = false;
    }
  };

  let activeRenamingTab = null;

  window.openRenameTabModal = (tabName) => {
    activeRenamingTab = tabName;
    modalRenameCurrentName.textContent = tabName;
    inputRenameTabName.value = tabName;
    renameTabStatus.innerHTML = '';
    renameTabModal.classList.remove('hidden');
    setTimeout(() => inputRenameTabName.focus(), 50);
  };

  window.closeRenameTabModal = () => {
    activeRenamingTab = null;
    renameTabModal.classList.add('hidden');
  };

  window.submitRenameTab = async () => {
    if (!activeRenamingTab) return;
    const newName = inputRenameTabName.value.trim();
    if (!newName) {
      renameTabStatus.innerHTML = '<span style="color:var(--error);">El nombre no puede estar vacio.</span>';
      return;
    }

    renameTabStatus.innerHTML = '<span style="color:var(--info);">Renombrando pestania...</span>';
    btnSubmitRenameTab.disabled = true;

    try {
      const res = await fetch('/api/reconciliation/tabs/rename', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          periodo: currentPeriodo,
          oldNombre: activeRenamingTab,
          newNombre: newName
        })
      });
      const data = await res.json();

      if (res.ok && data.success) {
        if (currentEntidad === activeRenamingTab) {
          currentEntidad = newName;
        }
        closeRenameTabModal();
        await loadTabs();
        loadData();
      } else {
        renameTabStatus.innerHTML = `<span style="color:var(--error); font-weight:600;">${data.message || 'Error al renombrar.'}</span>`;
      }
    } catch (err) {
      renameTabStatus.innerHTML = '<span style="color:var(--error);">Error de red al renombrar.</span>';
    } finally {
      btnSubmitRenameTab.disabled = false;
    }
  };

  window.deleteEntityTab = async (tabName) => {
    if (cachedTabs.length <= 1) {
      alert('No se puede eliminar la única pestaña activa del mes. Debe haber al menos una pestaña.');
      return;
    }

    if (
      !confirm(
        `¿Deseas eliminar la pestaña "${tabName}" del mes ${currentPeriodo}?\nTodas las facturas y estados de cuenta asociados a esta pestaña serán eliminados.`
      )
    ) {
      return;
    }

    try {
      const res = await fetch(
        `/api/reconciliation/tabs?periodo=${currentPeriodo}&nombre=${encodeURIComponent(tabName)}`,
        { method: 'DELETE' }
      );
      const data = await res.json();
      if (data.success) {
        if (currentEntidad === tabName) {
          const remaining = cachedTabs.find((t) => t.nombre !== tabName);
          currentEntidad = remaining ? remaining.nombre : '';
        }
        await loadTabs();
        loadData();
      } else {
        alert(data.message || 'Error al eliminar pestaña.');
      }
    } catch (err) {
      alert('Error de conexión al eliminar pestaña.');
    }
  };

  // ================= APARTADO DE PAGOS BANCARIOS NO ENCONTRADOS EN SAT =================
  window.scrollToUnmatchedSection = () => {
    const el = document.getElementById('unmatched-bank-section');
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  if (btnToggleUnmatchedTable) {
    btnToggleUnmatchedTable.addEventListener('click', () => {
      if (unmatchedTableWrapper) {
        const isHidden = unmatchedTableWrapper.style.display === 'none';
        unmatchedTableWrapper.style.display = isHidden ? 'block' : 'none';
        btnToggleUnmatchedTable.textContent = isHidden ? 'Ocultar' : 'Mostrar';
      }
    });
  }

  if (unmatchedSearchInput) {
    unmatchedSearchInput.addEventListener('input', () => {
      renderUnmatchedBankMovements();
    });
  }

  if (unmatchedMinPrice) {
    unmatchedMinPrice.addEventListener('input', () => {
      renderUnmatchedBankMovements();
    });
  }

  if (unmatchedMaxPrice) {
    unmatchedMaxPrice.addEventListener('input', () => {
      renderUnmatchedBankMovements();
    });
  }

  window.clearUnmatchedPriceFilter = () => {
    if (unmatchedMinPrice) unmatchedMinPrice.value = '';
    if (unmatchedMaxPrice) unmatchedMaxPrice.value = '';
    if (btnClearUnmatchedPrice) btnClearUnmatchedPrice.style.display = 'none';
    renderUnmatchedBankMovements();
  };

  function renderUnmatchedBankMovements() {
    if (!unmatchedBankRows) return;

    const query = (unmatchedSearchInput?.value || '').trim().toLowerCase();

    // 1. Obtener conjunto de movimientos asignados a facturas pagadas (exclusión estricta)
    const paidMovementIds = new Set(
      cachedInvoices
        .filter((inv) => inv.estadoPago === 'Pagada' && inv.pagoAsociado?.movimientoId)
        .map((inv) => String(inv.pagoAsociado.movimientoId))
    );

    // 2. Valores de rango de precio
    const minBankVal = parseFloat(unmatchedMinPrice?.value);
    const maxBankVal = parseFloat(unmatchedMaxPrice?.value);
    const hasMinBank = !isNaN(minBankVal) && minBankVal >= 0;
    const hasMaxBank = !isNaN(maxBankVal) && maxBankVal >= 0;

    if (btnClearUnmatchedPrice) {
      btnClearUnmatchedPrice.style.display = (hasMinBank || hasMaxBank) ? 'inline-block' : 'none';
    }

    const filtered = cachedUnmatchedMovements.filter((m) => {
      // Si este movimiento ya fue asignado como pago de una factura pagada, NUNCA mostrarlo
      if (paidMovementIds.has(String(m._id))) return false;

      const mvMonto = Number(m.monto || 0);
      if (hasMinBank && mvMonto < minBankVal) return false;
      if (hasMaxBank && mvMonto > maxBankVal) return false;

      if (!query) return true;
      const str = `${m.fecha} ${m.banco} ${m.cuenta || ''} ${m.concepto} ${m.origenReferencia || ''} ${m.rfcDetectado || ''} ${m.monto} ${m.categoria || ''} ${m.observaciones || ''}`.toLowerCase();
      return str.includes(query);
    });

    const totalMonto = filtered.reduce((acc, m) => acc + (m.monto || 0), 0);

    if (unmatchedCountHeader) {
      unmatchedCountHeader.textContent = filtered.length;
    }
    if (unmatchedTotalBadge) {
      unmatchedTotalBadge.textContent = formatMoney(totalMonto);
    }

    if (filtered.length === 0) {
      unmatchedBankRows.innerHTML = `
        <tr>
          <td colspan="8" style="text-align: center; padding: 24px; color: var(--text-muted);">
            ${query ? 'No se encontraron pagos bancarios con el filtro ingresado.' : 'No hay pagos bancarios pendientes de factura para este mes y pestania.'}
          </td>
        </tr>
      `;
      return;
    }

    unmatchedBankRows.innerHTML = filtered
      .map((m, idx) => {
        let badgeClass = 'bank-badge-generic';
        if (/bbva/i.test(m.banco)) badgeClass = 'bank-badge-bbva';
        else if (/scotia/i.test(m.banco)) badgeClass = 'bank-badge-scotia';

        const categoryTag = m.categoria
          ? `<div style="margin-top: 3px;"><span class="badge-warning" style="font-size: 10.5px; padding: 1px 5px; border-radius: 2px;">${m.categoria}</span></div>`
          : '';

        const noteText = m.observaciones
          ? `<div style="font-size: 11px; color: var(--info); font-style: italic; margin-top: 2px;">Nota: ${m.observaciones}</div>`
          : '';

        return `
          <tr>
            <td style="text-align:center; font-weight:600; color:var(--text-muted); font-size:11.5px;">${idx + 1}</td>
            <td style="font-size:12px;">${m.fecha || '-'}</td>
            <td>
              <span class="bank-badge ${badgeClass}">${m.banco || 'BANCO'}</span>
              <div style="font-size:10.5px; color:var(--text-muted); margin-top:2px;">${m.cuenta ? `Cta: ${m.cuenta}` : ''}</div>
            </td>
            <td>
              <strong>${m.concepto || '-'}</strong>
              ${m.origenReferencia ? `<div style="font-size:11px; color:var(--text-muted);">Ref: ${m.origenReferencia}</div>` : ''}
              ${categoryTag}
              ${noteText}
            </td>
            <td><code style="font-size:11px;">${m.rfcDetectado || '-'}</code></td>
            <td style="text-align:right; font-weight:700; color:var(--error); font-size:12.5px;">${formatMoney(m.monto)}</td>
            <td style="text-align:center;">
              <span class="badge-unpaid" style="font-size:11px;">Sin Factura SAT</span>
            </td>
            <td style="text-align:center;">
              <button type="button" class="btn-action-small btn-action-primary" onclick="openCompareModal('${m._id}')" title="Vincular con una factura recibida">
                Vincular
              </button>
            </td>
          </tr>
        `;
      })
      .join('');
  }

  // ================= MODAL DE COMPARACION / VINCULACION MANUAL =================
  window.openCompareModal = (movimientoId) => {
    const m = cachedUnmatchedMovements.find((x) => String(x._id) === String(movimientoId));
    if (!m) return;

    activeCompareMovement = m;
    compareSimilarOnly = true;
    selectedCompareInvoiceUuid = null;

    if (btnCompareSimilar) btnCompareSimilar.classList.add('active');
    if (btnCompareAll) btnCompareAll.classList.remove('active');

    let badgeClass = 'bank-badge-generic';
    if (/bbva/i.test(m.banco)) badgeClass = 'bank-badge-bbva';
    else if (/scotia/i.test(m.banco)) badgeClass = 'bank-badge-scotia';

    if (compareModalBanco) {
      compareModalBanco.textContent = m.banco || 'BANCO';
      compareModalBanco.className = `bank-badge ${badgeClass}`;
    }

    if (compareModalConcepto) compareModalConcepto.textContent = m.concepto || '-';
    if (compareModalFecha) compareModalFecha.textContent = m.fecha || '-';
    if (compareModalCuenta) compareModalCuenta.textContent = m.cuenta || 'Principal';
    if (compareModalRfc) compareModalRfc.textContent = m.rfcDetectado || 'No detectado en banco';
    if (compareModalMonto) compareModalMonto.textContent = formatMoney(m.monto);

    if (compareSearchInput) compareSearchInput.value = '';
    if (compareCommentInput) compareCommentInput.value = '';
    if (compareStatus) compareStatus.innerHTML = '';

    if (compareSelectedBadge) {
      compareSelectedBadge.innerHTML = '<span style="color:var(--text-muted); font-style:italic;">Ninguna factura seleccionada</span>';
    }
    if (compareSelectedPreview) {
      compareSelectedPreview.innerHTML = '💡 Haz clic en una factura de arriba para seleccionarla y guardarla.';
    }
    if (compareCommentBox) {
      compareCommentBox.classList.remove('active');
    }
    if (btnSaveCompareLink) {
      btnSaveCompareLink.disabled = true;
      btnSaveCompareLink.textContent = '✓ Guardar y Marcar como Pagada';
    }

    renderCompareInvoiceList();
    if (compareManualModal) compareManualModal.classList.remove('hidden');
  };

  window.closeCompareModal = () => {
    activeCompareMovement = null;
    selectedCompareInvoiceUuid = null;
    if (compareStatus) compareStatus.innerHTML = '';
    if (compareManualModal) compareManualModal.classList.add('hidden');
  };

  window.filterCompareCandidates = (similarOnly) => {
    compareSimilarOnly = similarOnly;
    if (similarOnly) {
      if (btnCompareSimilar) btnCompareSimilar.classList.add('active');
      if (btnCompareAll) btnCompareAll.classList.remove('active');
    } else {
      if (btnCompareAll) btnCompareAll.classList.add('active');
      if (btnCompareSimilar) btnCompareSimilar.classList.remove('active');
    }
    renderCompareInvoiceList();
  };

  window.selectCompareInvoice = (uuid) => {
    selectedCompareInvoiceUuid = uuid;
    const inv = cachedInvoices.find((i) => i.uuid === uuid);
    if (!inv) return;

    // Actualizar clases y marcas en las tarjetas
    document.querySelectorAll('.compare-candidate-card').forEach((el) => {
      const isThis = el.dataset.uuid === uuid;
      if (isThis) {
        el.classList.add('selected');
        const circle = el.querySelector('.compare-radio-circle');
        if (circle) circle.innerHTML = '<span style="font-size:11px; font-weight:700;">✓</span>';
        const btn = el.querySelector('.compare-candidate-btn');
        if (btn) btn.textContent = '✓ Seleccionada';
      } else {
        el.classList.remove('selected');
        const circle = el.querySelector('.compare-radio-circle');
        if (circle) circle.innerHTML = '';
        const btn = el.querySelector('.compare-candidate-btn');
        if (btn) btn.textContent = 'Seleccionar';
      }
    });

    if (compareSelectedBadge) {
      compareSelectedBadge.innerHTML = '<span class="badge-paid" style="font-size:10.5px; padding:2px 7px;">Factura Seleccionada</span>';
    }

    if (compareSelectedPreview) {
      compareSelectedPreview.innerHTML = `
        <div style="color:var(--text-main); font-weight:600; margin-top:2px;">
          <strong style="color:var(--primary); font-size:13px;">${inv.emisor || 'Sin emisor'}</strong>
          <span style="margin: 0 6px; color:var(--text-muted);">|</span>
          Total: <strong style="color:var(--primary);">${formatMoney(inv.total)}</strong>
          <span style="margin: 0 6px; color:var(--text-muted);">|</span>
          <span style="color:var(--text-muted); font-size:11px; font-family:monospace;" title="${inv.uuid}">Folio: ${inv.uuid.substring(0, 16)}...</span>
        </div>
      `;
    }

    if (compareCommentBox) {
      compareCommentBox.classList.add('active');
    }

    if (btnSaveCompareLink) {
      btnSaveCompareLink.disabled = false;
      const firstName = (inv.emisor || 'Factura').split(' ')[0];
      btnSaveCompareLink.textContent = `✓ Vincular a ${firstName} y Guardar como Pagada`;
    }

    if (compareCommentInput) {
      compareCommentInput.focus();
    }
  };

  window.renderCompareInvoiceList = () => {
    if (!activeCompareMovement || !compareInvoiceRows) return;

    const term = (compareSearchInput?.value || '').trim().toLowerCase();
    const bankMonto = Number(activeCompareMovement.monto || 0);

    let candidates = cachedInvoices.filter((inv) => {
      // Excluir facturas canceladas
      if (inv.estadoPago === 'Cancelada') return false;

      // Si el usuario escribe una busqueda, buscar en todas las facturas
      if (term) {
        const str = `${inv.uuid} ${inv.emisor || ''} ${inv.rfcEmisor || ''} ${inv.total || ''} ${inv.fechaEmision || ''}`.toLowerCase();
        return str.includes(term);
      }

      // Si solo similar, buscar dentro del 15% o coincidencia en RFC o nombre
      if (compareSimilarOnly) {
        const diff = Math.abs((inv.total || 0) - bankMonto);
        const ratio = bankMonto > 0 ? diff / bankMonto : 1;
        const isRfcMatch = activeCompareMovement.rfcDetectado && activeCompareMovement.rfcDetectado === inv.rfcEmisor;
        const isNameMatch = matchesQuery(inv.emisor, activeCompareMovement.concepto);

        if (ratio > 0.15 && !isRfcMatch && !isNameMatch) {
          return false;
        }
      }

      return true;
    });

    candidates.sort((a, b) => {
      const diffA = Math.abs((a.total || 0) - bankMonto);
      const diffB = Math.abs((b.total || 0) - bankMonto);
      return diffA - diffB;
    });

    if (candidates.length === 0) {
      compareInvoiceRows.innerHTML = `
        <div style="text-align: center; padding: 26px 16px; color: var(--text-muted); background: #ffffff; border-radius: 4px; border: 1px dashed var(--border);">
          <div style="font-size: 13px; font-weight: 600; color: var(--text-main); margin-bottom: 4px;">
            ${term ? 'No se encontraron facturas con ese criterio' : `Sin facturas con monto similar a ${formatMoney(bankMonto)}`}
          </div>
          <div style="font-size: 11.5px; margin-bottom: 12px;">
            ${term ? `No hay coincidencias para "${term}".` : 'Puedes ver todas las facturas pendientes de este mes haciendo clic abajo:'}
          </div>
          <button type="button" class="btn-action-small" onclick="filterCompareCandidates(false); if(compareSearchInput) compareSearchInput.value='';" style="font-size: 11.5px;">
            Mostrar todas las facturas de este mes
          </button>
        </div>
      `;
      return;
    }

    compareInvoiceRows.innerHTML = candidates
      .map((inv) => {
        const isCurrentlyPaid = inv.estadoPago === 'Pagada';
        const isSelected = selectedCompareInvoiceUuid === inv.uuid;
        const diff = Math.round(Math.abs((inv.total || 0) - bankMonto) * 100) / 100;

        let diffBadgeHtml = '';
        if (diff === 0) {
          diffBadgeHtml = '<span class="compare-candidate-diff diff-exact">✓ Monto Exacto</span>';
        } else {
          const sign = (inv.total || 0) > bankMonto ? '+' : '-';
          diffBadgeHtml = `<span class="compare-candidate-diff diff-near">Dif: ${sign}${formatMoney(diff)}</span>`;
        }

        const dateStr = inv.fechaEmision ? String(inv.fechaEmision).split('T')[0] : '-';

        return `
          <div class="compare-candidate-card ${isSelected ? 'selected' : ''}" data-uuid="${inv.uuid}" onclick="selectCompareInvoice('${inv.uuid}')" title="Clic para seleccionar esta factura">
            <div class="compare-radio-circle">
              ${isSelected ? '<span style="font-size:11px; font-weight:700;">✓</span>' : ''}
            </div>
            <div class="compare-candidate-left">
              <div class="compare-candidate-vendor">${inv.emisor || 'Sin emisor'}</div>
              <div class="compare-candidate-meta">
                <span class="compare-candidate-rfc">RFC: ${inv.rfcEmisor || '-'}</span>
                <span>Fecha: <strong>${dateStr}</strong></span>
                <span style="font-family: monospace;" title="${inv.uuid}">Folio: ${inv.uuid.substring(0, 16)}...</span>
                ${isCurrentlyPaid ? '<span class="badge-paid" style="font-size: 9.5px; padding: 1px 5px;">Ya Pagada</span>' : ''}
              </div>
            </div>
            <div class="compare-candidate-right">
              <div class="compare-candidate-amounts">
                <div class="compare-candidate-total">${formatMoney(inv.total)}</div>
                ${diffBadgeHtml}
              </div>
              <button type="button" class="compare-candidate-btn" onclick="event.stopPropagation(); selectCompareInvoice('${inv.uuid}')">
                ${isSelected ? '✓ Seleccionada' : 'Seleccionar'}
              </button>
            </div>
          </div>
        `;
      })
      .join('');
  };

  window.submitSelectedInvoiceLink = () => {
    if (!activeCompareMovement) return;
    if (!selectedCompareInvoiceUuid) {
      alert('Por favor selecciona una factura de la lista.');
      return;
    }
    const comentario = compareCommentInput?.value.trim() || '';
    linkMovementToInvoice(activeCompareMovement._id, selectedCompareInvoiceUuid, comentario);
  };

  window.linkMovementToInvoice = async (movimientoId, invoiceUuid, customObservaciones = '') => {
    if (!activeCompareMovement) return;

    const targetInv = cachedInvoices.find((i) => i.uuid === invoiceUuid);
    const isCurrentlyPaid = targetInv?.estadoPago === 'Pagada';

    if (isCurrentlyPaid) {
      if (!confirm(`La factura de "${targetInv?.emisor || 'proveedor'}" ya está marcada como "Pagada". ¿Deseas reasignarle este nuevo pago bancario?`)) {
        return;
      }
    }

    if (compareStatus) {
      compareStatus.innerHTML = '<span style="color:var(--info); font-weight:600;">⚡ Vinculando pago y guardando como Pagada (Manual)...</span>';
    }
    if (btnSaveCompareLink) btnSaveCompareLink.disabled = true;

    const obsToSend = customObservaciones || `Vinculado manualmente a retiro bancario (${activeCompareMovement.banco || 'Banco'} - ${formatMoney(activeCompareMovement.monto)})`;

    try {
      const res = await fetch('/api/reconciliation/link-manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          movimientoId,
          invoiceUuid,
          observaciones: obsToSend
        })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        closeCompareModal();
        await loadTabs();
        await loadData();
      } else {
        if (compareStatus) {
          compareStatus.innerHTML = `<span style="color:var(--error); font-weight:600;">${data.message || 'Error al vincular.'}</span>`;
        }
        if (btnSaveCompareLink) btnSaveCompareLink.disabled = false;
      }
    } catch (err) {
      if (compareStatus) {
        compareStatus.innerHTML = `<span style="color:var(--error);">Error de conexión con el servidor.</span>`;
      }
      if (btnSaveCompareLink) btnSaveCompareLink.disabled = false;
    }
  };

  window.saveBankClarification = async () => {
    if (!activeCompareMovement) return;

    const categoria = compareCategorySelect?.value || '';
    const observaciones = compareNoteInput?.value.trim() || '';

    if (!categoria && !observaciones) {
      alert('Seleccione una categoria o ingrese una nota aclaratoria para este pago bancario.');
      return;
    }

    if (compareStatus) compareStatus.innerHTML = '<span style="color:var(--info);">Guardando aclaracion...</span>';

    try {
      const res = await fetch(`/api/reconciliation/bank-movement/${activeCompareMovement._id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categoria, observaciones })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        closeCompareModal();
        loadData();
      } else {
        if (compareStatus) compareStatus.innerHTML = `<span style="color:var(--error); font-weight:600;">${data.message || 'Error al guardar.'}</span>`;
      }
    } catch (err) {
      if (compareStatus) compareStatus.innerHTML = `<span style="color:var(--error);">Error de conexion con el servidor.</span>`;
    }
  };

  // Eventos de teclado y clic fuera de los modales
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (editModal && !editModal.classList.contains('hidden')) closeEditModal();
      if (createTabModal && !createTabModal.classList.contains('hidden')) closeCreateTabModal();
      if (renameTabModal && !renameTabModal.classList.contains('hidden')) closeRenameTabModal();
      if (compareManualModal && !compareManualModal.classList.contains('hidden')) closeCompareModal();
    }
    if (e.key === 'Enter') {
      if (createTabModal && !createTabModal.classList.contains('hidden')) {
        e.preventDefault();
        submitCreateTab();
      } else if (renameTabModal && !renameTabModal.classList.contains('hidden')) {
        e.preventDefault();
        submitRenameTab();
      } else if (compareManualModal && !compareManualModal.classList.contains('hidden') && selectedCompareInvoiceUuid) {
        e.preventDefault();
        submitSelectedInvoiceLink();
      }
    }
  });

  if (editModal) {
    editModal.addEventListener('click', (e) => {
      if (e.target === editModal) closeEditModal();
    });
  }

  if (createTabModal) {
    createTabModal.addEventListener('click', (e) => {
      if (e.target === createTabModal) closeCreateTabModal();
    });
  }

  if (renameTabModal) {
    renameTabModal.addEventListener('click', (e) => {
      if (e.target === renameTabModal) closeRenameTabModal();
    });
  }

  if (compareManualModal) {
    compareManualModal.addEventListener('click', (e) => {
      if (e.target === compareManualModal) closeCompareModal();
    });
  }

  // Boton Recalcular Conciliacion
  window.triggerRefreshReconciliation = async () => {
    const btn = document.getElementById('btn-refresh-reconciliation');
    const icon = document.getElementById('refresh-icon');
    if (btn) btn.disabled = true;
    if (icon) icon.classList.add('spin-animation');

    try {
      const res = await fetch('/api/reconciliation/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ periodo: currentPeriodo, entidad: currentEntidad })
      });
      const data = await res.json();
      if (data.success) {
        await loadData();
        if (btn) {
          const prev = btn.innerHTML;
          btn.innerHTML = '✓ ¡Conciliación Sincronizada!';
          setTimeout(() => {
            btn.innerHTML = prev;
            btn.disabled = false;
          }, 2000);
        }
      } else {
        alert(data.message || 'Error al recalcular la conciliación.');
        if (btn) btn.disabled = false;
      }
    } catch (err) {
      console.error('Error refrescando:', err);
      alert('Error de conexión al recalcular la conciliación.');
      if (btn) btn.disabled = false;
    } finally {
      if (icon) icon.classList.remove('spin-animation');
    }
  };

  // Carga inicial sincronizada
  (async () => {
    await loadTabs();
    loadData();
  })();
});
