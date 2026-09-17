import { useState } from 'react';

export default function AuthForm({ mode, confirmation, email, loading, error, success, onSubmit }) {
  const [form, setForm] = useState({
    email,
    password: '',
    confirmPassword: '',
    code: '',
  });
  const [validationError, setValidationError] = useState('');

  const update = (event) => {
    setForm({ ...form, [event.target.name]: event.target.value });
  };

  const submit = (event) => {
    event.preventDefault();
    setValidationError('');

    const missingRequiredField = !confirmation && (
      !form.email || !form.password || (mode === 'signup' && !form.confirmPassword)
    );

    if (missingRequiredField || (confirmation && !form.code)) {
      setValidationError('Please complete all required fields.');
      return;
    }
    if (mode === 'signup' && form.password !== form.confirmPassword) {
      setValidationError('Passwords do not match.');
      return;
    }

    onSubmit(form);
  };

  return (
    <form onSubmit={submit} noValidate>
      {!confirmation && (
        <label>
          Email
          <input name="email" type="email" autoComplete="email" value={form.email} onChange={update} placeholder="you@example.com" />
        </label>
      )}
      {!confirmation && (
        <label>
          Password
          <input name="password" type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} value={form.password} onChange={update} placeholder="••••••••" />
        </label>
      )}
      {mode === 'signup' && !confirmation && (
        <label>
          Confirm password
          <input name="confirmPassword" type="password" autoComplete="new-password" value={form.confirmPassword} onChange={update} placeholder="••••••••" />
        </label>
      )}
      {confirmation && (
        <label>
          Confirmation code
          <input name="code" inputMode="numeric" value={form.code} onChange={update} placeholder="Enter your code" />
        </label>
      )}
      {(validationError || error) && (
        <p className="message error" role="alert">{validationError || error}</p>
      )}
      {success && <p className="message success" role="status">{success}</p>}
      <button type="submit" disabled={loading}>
        {loading ? 'Please wait…' : confirmation ? 'Confirm email' : mode === 'signup' ? 'Create account' : 'Sign in'}
      </button>
    </form>
  );
}
