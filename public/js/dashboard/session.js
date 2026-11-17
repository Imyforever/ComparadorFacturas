/**
 * Gestion de sesion en el navegador (token y usuario en localStorage).
 */

export function logout() {
  localStorage.removeItem('auth_token');
  localStorage.removeItem('auth_user');
  window.location.href = '/';
}

/**
 * Verifica que exista sesion valida en localStorage; si no, redirige al login.
 */
export function initSession() {
  const token = localStorage.getItem('auth_token');
  const userJson = localStorage.getItem('auth_user');

  if (!token || !userJson) {
    window.location.href = '/';
    return null;
  }

  let user;
  try {
    user = JSON.parse(userJson);
  } catch {
    window.location.href = '/';
    return null;
  }

  const userNameEl = document.getElementById('user-name');
  if (userNameEl) {
    userNameEl.textContent = user.username || 'admin';
  }

  const logoutBtn = document.getElementById('btn-logout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', logout);
  }

  return user;
}
