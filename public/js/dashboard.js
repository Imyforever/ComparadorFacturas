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
  let currentFilter = 'all';
  let cachedInvoices = [];

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

  periodSelect.addEventListener('change', () => {
    currentPeriodo = periodSelect.value;
    cfdiStatus.innerHTML = '';
    bankStatus.innerHTML = '';
    loadData();
  });

  // Formateador de moneda
  const formatMoney = (val) =>
    '$' + Number(val || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // 2. Cargar datos del mes seleccionado desde MongoDB Atlas
  async function loadData() {
    invoiceRows.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:24px; color:var(--text-muted);">Cargando facturas desde MongoDB Atlas...</td></tr>`;

    try {
      const res = await fetch(`/api/reconciliation/data?periodo=${currentPeriodo}`);
      const data = await res.json();

      if (data.success) {
        cachedInvoices = data.invoices || [];
        updateSummary(data.summary);
        updateCfdiLockState(data.hasCfdiFile, data.summary.totalFacturas);
        renderBankStatements(data.bankStatements || []);
        applyFilterAndRender();
      } else {
        invoiceRows.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:24px; color:var(--error);">${data.message || 'Error cargando datos.'}</td></tr>`;
      }
    } catch (err) {
      invoiceRows.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:24px; color:var(--error);">Error de conexion con el servidor.</td></tr>`;
    }
  }

  // 3. Bloqueo de subida si ya existe archivo de facturas del mes
  function updateCfdiLockState(hasFile, totalInvoices) {
    if (hasFile) {
      btnSelectCfdi.disabled = true;
      btnSelectCfdi.textContent = `Facturas cargadas (${totalInvoices} comprobantes)`;
      btnReplaceCfdi.style.display = 'inline-block';
      cfdiStatus.innerHTML = `<span style="color:var(--text-muted); font-size:11px;">Solo se permite 1 archivo de facturas por mes. Bloqueado.</span>`;
    } else {
      btnSelectCfdi.disabled = false;
      btnSelectCfdi.textContent = 'Subir Facturas del SAT';
      btnReplaceCfdi.style.display = 'none';
      cfdiStatus.innerHTML = '';
    }
  }

  // 4. Reemplazar archivo de facturas existente
  btnReplaceCfdi.addEventListener('click', async () => {
    if (!confirm(`Desea eliminar las facturas cargadas del mes ${currentPeriodo} para subir un nuevo archivo?`)) {
      return;
    }

    try {
      const res = await fetch(`/api/reconciliation/cfdi?periodo=${currentPeriodo}`, {
        method: 'DELETE'
      });
      const data = await res.json();
      alert(data.message);
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
      if (currentFilter === 'canceladas' && inv.estadoPago !== 'Cancelada') return false;

      if (term) {
        const str = `${inv.uuid} ${inv.emisor} ${inv.rfcEmisor} ${inv.total}`.toLowerCase();
        return str.includes(term);
      }
      return true;
    });

    showingCount.textContent = `Mostrando ${filtered.length} de ${cachedInvoices.length} facturas`;

    if (filtered.length === 0) {
      invoiceRows.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:24px; color:var(--text-muted);">No se encontraron facturas con el criterio seleccionado.</td></tr>`;
      return;
    }

    invoiceRows.innerHTML = filtered
      .map((inv, index) => {
        let badgeHtml = '';
        if (inv.estadoPago === 'Pagada') {
          badgeHtml = `<span class="badge-paid">Pagada</span>`;
        } else if (inv.estadoPago === 'No Pagada') {
          badgeHtml = `<span class="badge-unpaid">No Pagada</span>`;
        } else if (inv.estadoPago === 'Cancelada') {
          badgeHtml = `<span class="badge-canceled">Cancelada</span>`;
        } else {
          badgeHtml = `<span class="badge-na">${inv.estadoPago}</span>`;
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

    try {
      const res = await fetch('/api/reconciliation/upload-cfdi', {
        method: 'POST',
        body: formData
      });
      const data = await res.json();

      if (res.ok && data.success) {
        cfdiStatus.innerHTML = `<span style="color:var(--primary); font-weight:600;">${data.message}</span>`;
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

  // 12. Subir N archivos de Estado de Cuenta con validacion de mes
  bankFilesInput.addEventListener('change', async () => {
    if (!bankFilesInput.files || bankFilesInput.files.length === 0) return;

    const files = bankFilesInput.files;
    bankStatus.innerHTML = `<span style="color:var(--info);">Validando y procesando ${files.length} archivo(s)...</span>`;

    const formData = new FormData();
    for (let i = 0; i < files.length; i++) {
      formData.append('bankPdfs', files[i]);
    }
    formData.append('periodo', currentPeriodo);

    try {
      const res = await fetch('/api/reconciliation/upload-bank', {
        method: 'POST',
        body: formData
      });
      const data = await res.json();

      if (res.ok && data.success) {
        bankStatus.innerHTML = `<span style="color:var(--primary); font-weight:600;">${data.message}</span>`;
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

  // 13. Exportar a CSV
  btnExportCsv.addEventListener('click', () => {
    window.location.href = `/api/reconciliation/export-csv?periodo=${currentPeriodo}`;
  });

  // Carga inicial
  loadData();
});
