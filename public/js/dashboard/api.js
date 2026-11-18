/**
 * Cliente HTTP centralizado para el dashboard.
 * Unico modulo autorizado para ejecutar fetch() y gestionar el token Bearer.
 */

function getAuthToken() {
  return localStorage.getItem('auth_token') || '';
}

export function handleUnauthorized() {
  localStorage.removeItem('auth_token');
  localStorage.removeItem('auth_user');
  window.location.href = '/';
}

/**
 * Ejecuta una peticion a la API agregando Authorization Bearer y parseando JSON.
 * Ante 401 limpia la sesion y redirige al login.
 */
export async function apiFetch(path, options = {}) {
  const token = getAuthToken();
  const headers = new Headers(options.headers || {});

  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  if (options.body && !isFormData && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(path, {
    ...options,
    headers
  });

  if (res.status === 401) {
    handleUnauthorized();
    throw new Error('Sesion expirada.');
  }

  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }

  return { ok: res.ok, status: res.status, data };
}

export const api = {
  tabs(periodo) {
    return apiFetch(`/api/reconciliation/tabs?periodo=${encodeURIComponent(periodo)}`);
  },

  data(periodo, entidad) {
    return apiFetch(
      `/api/reconciliation/data?periodo=${encodeURIComponent(periodo)}&entidad=${encodeURIComponent(entidad)}`
    );
  },

  refresh(periodo, entidad) {
    return apiFetch('/api/reconciliation/refresh', {
      method: 'POST',
      body: JSON.stringify({ periodo, entidad })
    });
  },

  uploadCfdi(formData) {
    return apiFetch('/api/reconciliation/upload-cfdi', {
      method: 'POST',
      body: formData
    });
  },

  uploadBank(formData) {
    return apiFetch('/api/reconciliation/upload-bank', {
      method: 'POST',
      body: formData
    });
  },

  linkManual(payload) {
    return apiFetch('/api/reconciliation/link-manual', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  unlinkManual(invoiceUuid) {
    return apiFetch('/api/reconciliation/unlink-manual', {
      method: 'POST',
      body: JSON.stringify({ invoiceUuid })
    });
  },

  linkEgreso(payload) {
    return apiFetch('/api/reconciliation/link-egreso', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  unlinkEgreso(ingresoUuid) {
    return apiFetch('/api/reconciliation/unlink-egreso', {
      method: 'POST',
      body: JSON.stringify({ ingresoUuid })
    });
  },

  autoLinkEgresos(periodo, entidad) {
    return apiFetch('/api/reconciliation/auto-link-egresos', {
      method: 'POST',
      body: JSON.stringify({ periodo, entidad })
    });
  },

  undoAutoCreditNote(uuid) {
    return apiFetch('/api/reconciliation/undo-auto-nc', {
      method: 'POST',
      body: JSON.stringify({ uuid })
    });
  },

  bulkManualPaid(uuids, nota) {
    return apiFetch('/api/reconciliation/bulk-manual-paid', {
      method: 'POST',
      body: JSON.stringify({ uuids, nota })
    });
  },

  updateInvoice(uuid, payload) {
    return apiFetch(`/api/reconciliation/invoice/${encodeURIComponent(uuid)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload)
    });
  },

  deleteCfdi(periodo, entidad) {
    return apiFetch(
      `/api/reconciliation/cfdi?periodo=${encodeURIComponent(periodo)}&entidad=${encodeURIComponent(entidad)}`,
      { method: 'DELETE' }
    );
  },

  deleteBankStatement(id) {
    return apiFetch(`/api/reconciliation/bank-statement/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
  },

  updateBankMovement(id, payload) {
    return apiFetch(`/api/reconciliation/bank-movement/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload)
    });
  },

  renameTab(payload) {
    return apiFetch('/api/reconciliation/tabs/rename', {
      method: 'PATCH',
      body: JSON.stringify(payload)
    });
  },

  deleteTab(periodo, nombre) {
    return apiFetch(
      `/api/reconciliation/tabs?periodo=${encodeURIComponent(periodo)}&nombre=${encodeURIComponent(nombre)}`,
      { method: 'DELETE' }
    );
  },

  createTab(periodo, nombre) {
    return apiFetch('/api/reconciliation/tabs', {
      method: 'POST',
      body: JSON.stringify({ periodo, nombre })
    });
  },

  async exportCsv(periodo, entidad) {
    const token = getAuthToken();
    const headers = new Headers();
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }

    const url = `/api/reconciliation/export-csv?periodo=${encodeURIComponent(periodo)}&entidad=${encodeURIComponent(entidad)}`;
    const res = await fetch(url, { headers });

    if (res.status === 401) {
      handleUnauthorized();
      throw new Error('Sesion expirada.');
    }

    if (!res.ok) {
      let msg = 'Error al exportar CSV.';
      try {
        const errData = await res.json();
        if (errData?.message) msg = errData.message;
      } catch {
        // Ignorar si no es JSON
      }
      throw new Error(msg);
    }

    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = `conciliacion-${periodo}-${entidad}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
  }
};
