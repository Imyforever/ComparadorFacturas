/**
 * Gestion de subida de CFDI, estados de cuenta bancarios, eliminacion y exportacion CSV.
 */

import { api } from './api.js';
import { state } from './state.js';
import { escapeHtml, formatDateTime, getBankBadgeClass } from './format.js';

function getUploadEls() {
  return {
    cfdiFileInput: document.getElementById('cfdi-file'),
    btnSelectCfdi: document.getElementById('btn-select-cfdi'),
    btnReplaceCfdi: document.getElementById('btn-replace-cfdi'),
    cfdiStatus: document.getElementById('cfdi-status'),
    bankFilesInput: document.getElementById('bank-files'),
    bankStatus: document.getElementById('bank-status'),
    bankFilesList: document.getElementById('bank-files-list'),
    bankFilesCount: document.getElementById('bank-files-count'),
    btnExportCsv: document.getElementById('btn-export-csv')
  };
}

function setStatusHtml(el, message, colorVar, bold = false) {
  if (!el) return;
  el.innerHTML = `<span style="color:${colorVar};${bold ? ' font-weight:600;' : ''}">${escapeHtml(message)}</span>`;
}

export function updateCfdiLockState(hasFile, totalInvoices) {
  const { btnSelectCfdi, btnReplaceCfdi, cfdiStatus } = getUploadEls();
  if (!btnSelectCfdi || !btnReplaceCfdi || !cfdiStatus) return;

  if (hasFile) {
    btnSelectCfdi.style.display = 'none';
    btnReplaceCfdi.style.display = 'inline-block';
    cfdiStatus.innerHTML = `<span style="color:var(--text-muted); font-size:11px;">1 archivo cargado (${Number(totalInvoices || 0)} facturas).</span>`;
  } else {
    btnSelectCfdi.style.display = 'inline-block';
    btnSelectCfdi.disabled = false;
    btnSelectCfdi.textContent = `+ Subir Facturas (${state.currentEntidad})`;
    btnReplaceCfdi.style.display = 'none';
    cfdiStatus.innerHTML = '';
  }
}

export function renderBankStatements(statements) {
  const { bankFilesList, bankFilesCount } = getUploadEls();
  if (!bankFilesList || !bankFilesCount) return;

  const list = statements || [];
  bankFilesCount.textContent = list.length;

  if (list.length === 0) {
    bankFilesList.innerHTML = `
      <div class="empty-statements">
        Sin estados de cuenta en este mes.
      </div>
    `;
    return;
  }

  bankFilesList.innerHTML = list
    .map((st) => {
      const badgeClass = getBankBadgeClass(st.banco);
      const uploadDate = formatDateTime(st.fechaSubida);
      const safeName = escapeHtml(st.nombreArchivo || '');

      return `
        <div class="bank-file-row">
          <div class="bank-file-info">
            <span class="bank-badge ${badgeClass}">${escapeHtml(st.banco || 'BANCO')}</span>
            <div>
              <div class="bank-file-name">${safeName}</div>
              <div class="bank-file-meta">
                ${st.cuenta ? `Cuenta: <strong>${escapeHtml(st.cuenta)}</strong> | ` : ''}
                Movimientos: <strong>${Number(st.totalMovimientos || 0)}</strong> 
                (${Number(st.cargosCount || 0)} cargos / ${Number(st.abonosCount || 0)} abonos) | 
                ${escapeHtml(uploadDate)}
              </div>
            </div>
          </div>
          <button type="button" class="btn-delete-statement" data-action="delete-statement" data-id="${escapeHtml(st._id)}" data-filename="${safeName}" title="Eliminar archivo">
            Eliminar
          </button>
        </div>
      `;
    })
    .join('');
}

async function deleteBankStatement(id, filename, onReloadData) {
  if (!confirm(`¿Deseas eliminar el estado de cuenta "${filename}"?`)) {
    return;
  }

  const { bankStatus } = getUploadEls();
  try {
    setStatusHtml(bankStatus, 'Eliminando archivo...', 'var(--info)');
    const { data } = await api.deleteBankStatement(id);
    if (data.success) {
      setStatusHtml(bankStatus, data.message || 'Eliminado.', 'var(--primary)', true);
      if (onReloadData) onReloadData();
    } else {
      setStatusHtml(bankStatus, data.message || 'Error al eliminar.', 'var(--error)', true);
    }
  } catch {
    setStatusHtml(bankStatus, 'Error de conexion.', 'var(--error)');
  }
}

export function initUploads({ onReloadAll, onReloadData }) {
  const { cfdiFileInput, btnReplaceCfdi, cfdiStatus, bankFilesInput, bankStatus, bankFilesList, btnExportCsv } =
    getUploadEls();

  if (btnReplaceCfdi) {
    btnReplaceCfdi.addEventListener('click', async () => {
      if (!confirm(`¿Deseas eliminar las facturas de "${state.currentEntidad}" para subir un nuevo archivo?`)) {
        return;
      }

      try {
        const { data } = await api.deleteCfdi(state.currentPeriodo, state.currentEntidad);
        alert(data.message);
        if (onReloadAll) await onReloadAll();
      } catch {
        alert('Error al eliminar facturas.');
      }
    });
  }

  if (cfdiFileInput) {
    cfdiFileInput.addEventListener('change', async () => {
      if (!cfdiFileInput.files || cfdiFileInput.files.length === 0) return;

      const file = cfdiFileInput.files[0];
      setStatusHtml(cfdiStatus, 'Verificando periodo y procesando facturas...', 'var(--info)');

      const formData = new FormData();
      formData.append('cfdiPdf', file);
      formData.append('periodo', state.currentPeriodo);
      formData.append('entidad', state.currentEntidad);

      try {
        const { ok, data } = await api.uploadCfdi(formData);
        if (ok && data.success) {
          setStatusHtml(cfdiStatus, data.message || 'Archivo procesado.', 'var(--primary)', true);
          if (onReloadAll) await onReloadAll();
        } else {
          setStatusHtml(cfdiStatus, data.message || 'Error al procesar archivo.', 'var(--error)', true);
        }
      } catch {
        setStatusHtml(cfdiStatus, 'Error de conexion al subir archivo.', 'var(--error)');
      } finally {
        cfdiFileInput.value = '';
      }
    });
  }

  if (bankFilesInput) {
    bankFilesInput.addEventListener('change', async () => {
      if (!bankFilesInput.files || bankFilesInput.files.length === 0) return;

      const files = bankFilesInput.files;
      setStatusHtml(bankStatus, `Validando y procesando ${files.length} archivo(s)...`, 'var(--info)');

      const formData = new FormData();
      for (let i = 0; i < files.length; i++) {
        formData.append('bankPdfs', files[i]);
      }
      formData.append('periodo', state.currentPeriodo);
      formData.append('entidad', state.currentEntidad);

      try {
        const { ok, data } = await api.uploadBank(formData);
        if (ok && data.success) {
          setStatusHtml(bankStatus, data.message || 'Estados procesados.', 'var(--primary)', true);
          if (onReloadAll) await onReloadAll();
        } else {
          setStatusHtml(bankStatus, data.message || 'Error al procesar estados.', 'var(--error)', true);
        }
      } catch {
        setStatusHtml(bankStatus, 'Error de conexion al subir estados.', 'var(--error)');
      } finally {
        bankFilesInput.value = '';
      }
    });
  }

  if (bankFilesList) {
    bankFilesList.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action="delete-statement"]');
      if (!btn) return;
      const id = btn.dataset.id;
      const filename = btn.dataset.filename || '';
      if (id) {
        deleteBankStatement(id, filename, onReloadData);
      }
    });
  }

  if (btnExportCsv) {
    btnExportCsv.addEventListener('click', async () => {
      try {
        await api.exportCsv(state.currentPeriodo, state.currentEntidad);
      } catch (err) {
        alert(err.message || 'Error al exportar CSV.');
      }
    });
  }
}
