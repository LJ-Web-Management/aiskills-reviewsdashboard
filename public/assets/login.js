(() => {
  const form = document.getElementById('login-form');
  const errorBox = document.getElementById('login-error');
  const btn = document.getElementById('login-btn');
  const codeField = document.getElementById('code-field');
  const pwInput = form.elements.password;

  document.getElementById('pw-toggle').addEventListener('click', (e) => {
    const show = pwInput.type === 'password';
    pwInput.type = show ? 'text' : 'password';
    e.currentTarget.textContent = show ? 'Hide' : 'Show';
    e.currentTarget.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.classList.toggle('hidden', !msg);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = form.elements.email.value.trim();
    const password = pwInput.value;
    const code = form.elements.code.value.replace(/\s+/g, '');
    if (!email || !password) return showError('Enter your email and password.');
    showError('');
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email, password, code }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        window.location.replace('/');
        return;
      }
      if (data.totpRequired) {
        const first = codeField.classList.contains('hidden');
        codeField.classList.remove('hidden');
        form.elements.code.focus();
        if (!first || code) showError(data.error);
        else showError('');
        if (first) document.getElementById('login-sub').textContent = 'Two-factor authentication is on for this account.';
      } else {
        showError(data.error || 'Sign-in failed. Try again.');
        pwInput.select();
      }
    } catch {
      showError('Could not reach the server. Check your connection.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  });
})();
