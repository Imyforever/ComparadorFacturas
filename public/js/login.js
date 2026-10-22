/**
 * Lógica del Login - Comparador de Facturas
 */

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('login-form');
  const emailInput = document.getElementById('email');
  const passwordInput = document.getElementById('password');
  const rememberInput = document.getElementById('remember-me');
  const btnTogglePassword = document.getElementById('btn-toggle-password');

  const btnSubmit = document.getElementById('btn-submit');
  const btnText = document.getElementById('btn-text');
  const spinner = document.getElementById('spinner');

  // Alternar visualización de contraseña
  btnTogglePassword.addEventListener('click', () => {
    const isPassword = passwordInput.getAttribute('type') === 'password';
    passwordInput.setAttribute('type', isPassword ? 'text' : 'password');
    btnTogglePassword.textContent = isPassword ? 'Ocultar' : 'Ver';
  });

  // Limpiar errores al escribir
  [emailInput, passwordInput].forEach((input) => {
    input.addEventListener('input', () => {
      const group = input.closest('.form-group');
      if (group && group.classList.contains('has-error')) {
        group.classList.remove('has-error');
        const errSpan = group.querySelector('.field-error');
        if (errSpan) errSpan.textContent = '';
      }
    });
  });

  function setError(groupId, errorId, message) {
    const group = document.getElementById(groupId);
    const errorSpan = document.getElementById(errorId);
    if (group) group.classList.add('has-error');
    if (errorSpan) errorSpan.textContent = message;
  }

  function clearErrors() {
    document.querySelectorAll('.form-group.has-error').forEach((el) => el.classList.remove('has-error'));
    document.querySelectorAll('.field-error').forEach((el) => (el.textContent = ''));
  }

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  // Envío del formulario
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors();

    const username = emailInput.value.trim();
    const password = passwordInput.value;
    const rememberMe = rememberInput.checked;

    let hasError = false;

    if (!username) {
      setError('group-email', 'error-email', 'El usuario es obligatorio.');
      hasError = true;
    }

    if (!password) {
      setError('group-password', 'error-password', 'La contrasena es obligatoria.');
      hasError = true;
    }

    if (hasError) return;

    // Estado de carga
    btnSubmit.disabled = true;
    spinner.classList.remove('hidden');
    btnText.textContent = 'Verificando...';

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, rememberMe })
      });

      const data = await response.json();

      if (response.ok && data.success) {
        showToast(data.message, 'success');
        localStorage.setItem('auth_token', data.token);
        localStorage.setItem('auth_user', JSON.stringify(data.user));

        btnText.textContent = 'Acceso concedido';
        setTimeout(() => {
          window.location.href = '/dashboard';
        }, 600);
      } else {
        showToast(data.message || 'Error de autenticación.', 'error');
        setError('group-password', 'error-password', data.message || 'Credenciales incorrectas.');
        resetButton();
      }
    } catch (err) {
      console.error(err);
      showToast('No fue posible conectar con el servidor.', 'error');
      resetButton();
    }

    function resetButton() {
      btnSubmit.disabled = false;
      spinner.classList.add('hidden');
      btnText.textContent = 'Iniciar Sesión';
    }
  });

  function showToast(message, type = 'info', duration = 3500) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;

    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('toast-hiding');
      setTimeout(() => {
        if (toast.parentElement) toast.remove();
      }, 250);
    }, duration);
  }
});
