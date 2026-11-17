/**
 * Gestion de pestanias / cuentas por mes (crear, renombrar, cambiar y eliminar).
 */

import { api } from './api.js';
import { state } from './state.js';
import { escapeHtml } from './format.js';

function getTabEls() {
  return {
    entityTabsList: document.getElementById('entity-tabs-list'),
    createTabModal: document.getElementById('create-tab-modal'),
    inputNewTabName: document.getElementById('input-new-tab-name'),
    createTabStatus: document.getElementById('create-tab-status'),
    btnSubmitCreateTab: document.getElementById('btn-submit-create-tab'),
    modalCreateTabPeriod: document.getElementById('modal-create-tab-period'),
    renameTabModal: document.getElementById('rename-tab-modal'),
    inputRenameTabName: document.getElementById('input-rename-tab-name'),
    renameTabStatus: document.getElementById('rename-tab-status'),
    btnSubmitRenameTab: document.getElementById('btn-submit-rename-tab'),
    modalRenameCurrentName: document.getElementById('modal-rename-current-name'),
    cfdiStatus: document.getElementById('cfdi-status'),
    bankStatus: document.getElementById('bank-status')
  };
}

function setStatusMsg(el, msg, colorVar = 'var(--error)', bold = false) {
  if (!el) return;
  el.innerHTML = `<span style="color:${colorVar};${bold ? ' font-weight:600;' : ''}">${escapeHtml(msg)}</span>`;
}

export function renderTabs() {
  const { entityTabsList } = getTabEls();
  if (!entityTabsList) return;

  const canDelete = state.cachedTabs.length > 1;
  entityTabsList.innerHTML = state.cachedTabs
    .map((tab) => {
      const isActive = tab.nombre === state.currentEntidad;
      const safeName = escapeHtml(tab.nombre);
      const count = Number(tab.facturasCount || 0);

      return `
        <div class="entity-tab ${isActive ? 'active' : ''}" data-action="switch-tab" data-tab="${safeName}">
          <span class="tab-label">${safeName}</span>
          <span class="tab-badge" title="${count} facturas en esta pestania">${count}</span>
          <div class="tab-actions-group">
            <button type="button" class="btn-tab-icon" data-action="rename-tab" data-tab="${safeName}" title="Renombrar esta pestania">
              Editar
            </button>
            ${
              canDelete
                ? `<button type="button" class="btn-tab-icon btn-tab-icon-delete" data-action="delete-tab" data-tab="${safeName}" title="Eliminar pestania">&times;</button>`
                : ''
            }
          </div>
        </div>
      `;
    })
    .join('');
}

export async function loadTabs() {
  try {
    const { data } = await api.tabs(state.currentPeriodo);
    if (data.success && Array.isArray(data.tabs)) {
      state.cachedTabs = data.tabs;
      if (!state.cachedTabs.some((t) => t.nombre === state.currentEntidad)) {
        state.currentEntidad = state.cachedTabs[0]?.nombre || '';
      }
      renderTabs();
    }
  } catch (err) {
    console.error('Error cargando pestanias:', err);
  }
}

export function switchEntityTab(tabName, onReload) {
  if (state.currentEntidad === tabName) return;
  state.currentEntidad = tabName;
  renderTabs();
  const { cfdiStatus, bankStatus } = getTabEls();
  if (cfdiStatus) cfdiStatus.innerHTML = '';
  if (bankStatus) bankStatus.innerHTML = '';
  if (onReload) onReload();
}

export function openCreateTabModal() {
  const { modalCreateTabPeriod, inputNewTabName, createTabStatus, createTabModal } = getTabEls();
  if (modalCreateTabPeriod) modalCreateTabPeriod.textContent = state.currentPeriodo;
  if (inputNewTabName) inputNewTabName.value = '';
  if (createTabStatus) createTabStatus.innerHTML = '';
  if (createTabModal) createTabModal.classList.remove('hidden');
  setTimeout(() => inputNewTabName?.focus(), 50);
}

export function closeCreateTabModal() {
  const { createTabModal } = getTabEls();
  if (createTabModal) createTabModal.classList.add('hidden');
}

export async function submitCreateTab(onReload) {
  const { inputNewTabName, createTabStatus, btnSubmitCreateTab } = getTabEls();
  const name = inputNewTabName?.value.trim() || '';
  if (!name) {
    setStatusMsg(createTabStatus, 'Ingrese un nombre para la pestania.');
    return;
  }

  setStatusMsg(createTabStatus, 'Creando pestania...', 'var(--info)');
  if (btnSubmitCreateTab) btnSubmitCreateTab.disabled = true;

  try {
    const { ok, data } = await api.createTab(state.currentPeriodo, name);
    if (ok && data.success) {
      state.currentEntidad = name;
      closeCreateTabModal();
      await loadTabs();
      if (onReload) onReload();
    } else {
      setStatusMsg(createTabStatus, data.message || 'Error al crear pestania.', 'var(--error)', true);
    }
  } catch {
    setStatusMsg(createTabStatus, 'Error de red al crear pestania.');
  } finally {
    if (btnSubmitCreateTab) btnSubmitCreateTab.disabled = false;
  }
}

export function openRenameTabModal(tabName) {
  const { modalRenameCurrentName, inputRenameTabName, renameTabStatus, renameTabModal } = getTabEls();
  state.activeRenamingTab = tabName;
  if (modalRenameCurrentName) modalRenameCurrentName.textContent = tabName;
  if (inputRenameTabName) inputRenameTabName.value = tabName;
  if (renameTabStatus) renameTabStatus.innerHTML = '';
  if (renameTabModal) renameTabModal.classList.remove('hidden');
  setTimeout(() => inputRenameTabName?.focus(), 50);
}

export function closeRenameTabModal() {
  const { renameTabModal } = getTabEls();
  state.activeRenamingTab = null;
  if (renameTabModal) renameTabModal.classList.add('hidden');
}

export async function submitRenameTab(onReload) {
  if (!state.activeRenamingTab) return;
  const { inputRenameTabName, renameTabStatus, btnSubmitRenameTab } = getTabEls();
  const newName = inputRenameTabName?.value.trim() || '';
  if (!newName) {
    setStatusMsg(renameTabStatus, 'El nombre no puede estar vacio.');
    return;
  }

  setStatusMsg(renameTabStatus, 'Renombrando pestania...', 'var(--info)');
  if (btnSubmitRenameTab) btnSubmitRenameTab.disabled = true;

  try {
    const { ok, data } = await api.renameTab({
      periodo: state.currentPeriodo,
      oldNombre: state.activeRenamingTab,
      newNombre: newName
    });

    if (ok && data.success) {
      if (state.currentEntidad === state.activeRenamingTab) {
        state.currentEntidad = newName;
      }
      closeRenameTabModal();
      await loadTabs();
      if (onReload) onReload();
    } else {
      setStatusMsg(renameTabStatus, data.message || 'Error al renombrar.', 'var(--error)', true);
    }
  } catch {
    setStatusMsg(renameTabStatus, 'Error de red al renombrar.');
  } finally {
    if (btnSubmitRenameTab) btnSubmitRenameTab.disabled = false;
  }
}

export async function deleteEntityTab(tabName, onReload) {
  if (state.cachedTabs.length <= 1) {
    alert('No se puede eliminar la unica pestana activa del mes. Debe haber al menos una pestana.');
    return;
  }

  if (
    !confirm(
      `¿Deseas eliminar la pestaña "${tabName}" del mes ${state.currentPeriodo}?\nTodas las facturas y estados de cuenta asociados a esta pestaña serán eliminados.`
    )
  ) {
    return;
  }

  try {
    const { data } = await api.deleteTab(state.currentPeriodo, tabName);
    if (data.success) {
      if (state.currentEntidad === tabName) {
        const remaining = state.cachedTabs.find((t) => t.nombre !== tabName);
        state.currentEntidad = remaining ? remaining.nombre : '';
      }
      await loadTabs();
      if (onReload) onReload();
    } else {
      alert(data.message || 'Error al eliminar pestana.');
    }
  } catch {
    alert('Error de conexion al eliminar pestana.');
  }
}

export function initTabsEvents(onReload) {
  const { entityTabsList } = getTabEls();
  if (!entityTabsList) return;

  entityTabsList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const tabName = btn.dataset.tab;
    if (!tabName) return;

    if (action === 'rename-tab') {
      e.stopPropagation();
      openRenameTabModal(tabName);
    } else if (action === 'delete-tab') {
      e.stopPropagation();
      deleteEntityTab(tabName, onReload);
    } else if (action === 'switch-tab') {
      switchEntityTab(tabName, onReload);
    }
  });
}
