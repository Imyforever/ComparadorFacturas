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

  const statTotalAmount = document.getElementById('stat-total-amount');
  const statTotalCount = document.getElementById('stat-total-count');
  const statPaidAmount = document.getElementById('stat-paid-amount');
  const statPaidCount = document.getElementById('stat-paid-count');
  const statUnpaidAmount = document.getElementById('stat-unpaid-amount');
  const statUnpaidCount = document.getElementById('stat-unpaid-count');
  const statCanceledAmount = document.getElementById('stat-canceled-amount');
  const statCanceledCount = document.getElementById('stat-canceled-count');

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
  let cachedInvoices = [];

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
          currentEntidad = cachedTabs[0]?.nombre || 'Personal';
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
        updateSummary(data.summary);
        updateCfdiLockState(data.hasCfdiFile, data.summary.totalFacturas);
        renderBankStatements(data.bankStatements || []);
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
      invoiceRows.innerHTML = `<tr><td colspan="11" style="text-align:center; padding:24px; color:var(--error);">Error de conexion con el servidor.</td></tr>`;
    }
  }

  // 4. Bloqueo de subida si ya existe archivo de facturas del mes y pestania
  function updateCfdiLockState(hasFile, totalInvoices) {
    if (hasFile) {
      btnSelectCfdi.disabled = true;
      btnSelectCfdi.textContent = `Facturas cargadas (${totalInvoices} comprobantes)`;
      btnReplaceCfdi.style.display = 'inline-block';
      cfdiStatus.innerHTML = `<span style="color:var(--text-muted); font-size:11px;">Solo se permite 1 archivo de facturas para "${currentEntidad}". Bloqueado.</span>`;
    } else {
      btnSelectCfdi.disabled = false;
      btnSelectCfdi.textContent = `Subir Facturas del SAT (${currentEntidad})`;
      btnReplaceCfdi.style.display = 'none';
      cfdiStatus.innerHTML = '';
    }
  }

  // 5. Reemplazar archivo de facturas existente
  btnReplaceCfdi.addEventListener('click', async () => {
    if (!confirm(`Desea eliminar las facturas cargadas de "${currentEntidad}" para el mes ${currentPeriodo} y subir un nuevo archivo?`)) {
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
      alert('Error al intentar eliminar facturas.');
    }
  });

  // 5. Renderizar lista de estados de cuenta subidos para el mes
  function renderBankStatements(statements) {
    if (!bankFilesList || !bankFilesCount) return;
    bankFilesCount.textContent = statements.length;

    if (!statements || statements.length === 0) {
      bankFilesList.innerHTML = `
        <div class="empty-statements">
          No se han subido estados de cuenta para este mes (${currentPeriodo}). Puede seleccionar uno o varios archivos PDF con el boton superior.
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
                  Movimientos procesados: <strong>${st.totalMovimientos}</strong> 
                  (${st.cargosCount} cargos / ${st.abonosCount} abonos) | 
                  Subido: ${uploadDate}
                </div>
              </div>
            </div>
            <button type="button" class="btn-delete-statement" onclick="deleteBankStatement('${st._id}', '${st.nombreArchivo}')" title="Eliminar este archivo y recalcular conciliacion">
              Eliminar Archivo
            </button>
          </div>
        `;
      })
      .join('');
  }

  // 6. Eliminar un archivo de estado de cuenta bancario
  window.deleteBankStatement = async (id, filename) => {
    if (
      !confirm(
        `Desea eliminar el estado de cuenta "${filename}" del mes ${currentPeriodo}?\nSus movimientos bancarios asociados seran removidos y la conciliacion se recalculara de inmediato.`
      )
    ) {
      return;
    }

    try {
      bankStatus.innerHTML = `<span style="color:var(--info);">Eliminando archivo y recalculando conciliacion...</span>`;
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
      bankStatus.innerHTML = `<span style="color:var(--error);">Error de conexion con el servidor.</span>`;
    }
  };

  // 7. Actualizar tarjetas de resumen
  function updateSummary(summary) {
    if (!summary) return;
    statTotalAmount.textContent = formatMoney(summary.montoTotal);
    statTotalCount.textContent = `${summary.totalFacturas} facturas registradas`;

    statPaidAmount.textContent = formatMoney(summary.montoPagado);
    statPaidCount.textContent = `${summary.pagadasCount} pagadas en banco`;

    statUnpaidAmount.textContent = formatMoney(summary.montoNoPagado);
    statUnpaidCount.textContent = `${summary.noPagadasCount} pendientes de pago`;

    statCanceledAmount.textContent = formatMoney(summary.montoCancelado);
    statCanceledCount.textContent = `${summary.canceladasCount} canceladas en SAT`;
  }

  // 8. Renderizar tabla con enumeracion (No.), filtro y buscador
  function applyFilterAndRender() {
    const term = (searchInput.value || '').trim().toLowerCase();

    let filtered = cachedInvoices.filter((inv) => {
      if (currentFilter === 'pagadas' && inv.estadoPago !== 'Pagada') return false;
      if (currentFilter === 'no_pagadas' && inv.estadoPago !== 'No Pagada') return false;
      if (currentFilter === 'egresos' && inv.efecto !== 'Egreso') return false;
      if (currentFilter === 'canceladas' && inv.estadoPago !== 'Cancelada') return false;

      if (term) {
        const str = `${inv.uuid} ${inv.emisor} ${inv.rfcEmisor} ${inv.total} ${inv.observaciones || ''}`.toLowerCase();
        return str.includes(term);
      }
      return true;
    });

    showingCount.textContent = `Mostrando ${filtered.length} de ${cachedInvoices.length} facturas`;

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
        if (inv.estadoPago === 'Pagada' && inv.pagoAsociado) {
          const p = inv.pagoAsociado;
          paymentDetailHtml = `
            <div class="payment-detail">
              <strong>Banco:</strong> ${p.banco || '-'} | <strong>Fecha:</strong> ${p.fechaPago || '-'} | <strong>Monto:</strong> ${formatMoney(p.montoRetiro)}<br>
              <strong>Concepto:</strong> ${p.conceptoBanco || p.banco || 'Retiro bancario'}
            </div>
          `;
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
              <button type="button" class="btn-action-small" onclick="openEditModal('${inv.uuid}')" title="Editar estado y agregar observaciones">
                Editar
              </button>
            </td>
          </tr>
        `;
      })
      .join('');
  }

  // 9. Cambiar pestanias de filtro
  document.querySelectorAll('.filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      applyFilterAndRender();
    });
  });

  // 10. Buscador en tiempo real
  searchInput.addEventListener('input', applyFilterAndRender);

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

  // 14. Logica de Modal para Editar Estado y Observaciones de una Factura
  let activeEditingUuid = null;
  const editModal = document.getElementById('edit-invoice-modal');
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

  window.openEditModal = (uuid) => {
    const inv = cachedInvoices.find((i) => i.uuid === uuid);
    if (!inv) return;

    activeEditingUuid = uuid;
    modalEmisor.textContent = inv.emisor || 'Sin emisor registrado';
    modalUuid.textContent = inv.uuid;
    modalTotal.textContent = formatMoney(inv.total);
    modalFecha.textContent = inv.fechaEmision ? inv.fechaEmision.split('T')[0] : '-';
    modalEfecto.textContent = inv.efecto || 'Ingreso';
    modalEstadoPago.value = inv.estadoPago || 'No Pagada';
    modalObservaciones.value = inv.observaciones || '';
    modalStatus.innerHTML = '';

    if (inv.editadoManualmente) {
      btnResetAuto.style.display = 'inline-block';
    } else {
      btnResetAuto.style.display = 'none';
    }

    editModal.classList.remove('hidden');
    setTimeout(() => {
      modalObservaciones.focus();
    }, 50);
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
    if (
      !confirm(
        `Desea eliminar la pestania "${tabName}" del mes ${currentPeriodo}?\nTodas las facturas y estados de cuenta asociados a esta pestania seran eliminados.`
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
          currentEntidad = 'Personal';
        }
        await loadTabs();
        loadData();
      } else {
        alert(data.message || 'Error al eliminar pestania.');
      }
    } catch (err) {
      alert('Error de conexion al eliminar pestania.');
    }
  };

  // Eventos de teclado y clic fuera de los modales
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (editModal && !editModal.classList.contains('hidden')) closeEditModal();
      if (createTabModal && !createTabModal.classList.contains('hidden')) closeCreateTabModal();
      if (renameTabModal && !renameTabModal.classList.contains('hidden')) closeRenameTabModal();
    }
    if (e.key === 'Enter') {
      if (createTabModal && !createTabModal.classList.contains('hidden')) {
        e.preventDefault();
        submitCreateTab();
      } else if (renameTabModal && !renameTabModal.classList.contains('hidden')) {
        e.preventDefault();
        submitRenameTab();
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

  // Carga inicial sincronizada
  (async () => {
    await loadTabs();
    loadData();
  })();
});
