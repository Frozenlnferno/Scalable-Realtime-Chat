import { useState } from 'react';
import AuthForm from '../components/AuthForm';
import { confirmRegistration, getAuthErrorMessage, getAuthenticatedSession, login, register } from '../services/authService';

export default function AuthPage({ onAuthenticated }) {
  const [mode, setMode] = useState('signin');
  const [confirmation, setConfirmation] = useState(false);
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  const switchMode = (nextMode) => {
    setMode(nextMode);
    setConfirmation(false);
    setError('');
    setSuccess('');
  };

  async function handleSubmit(values) {
    setError('');
    setSuccess('');
    setLoading(true);
    setEmail(values.email || email);

    try {
      if (confirmation) {
        await confirmRegistration(email, values.code);
        setConfirmation(false);
        setMode('signin');
        setSuccess('Your email is confirmed. You can now sign in.');
      } else if (mode === 'signup') {
        const result = await register(values.email, values.password);
        setEmail(values.email);

        if (result.nextStep?.signUpStep === 'CONFIRM_SIGN_UP') {
          setConfirmation(true);
        } else {
          setSuccess('Your account has been created. You can now sign in.');
        }
      } else {
        await login(values.email, values.password);
        onAuthenticated(await getAuthenticatedSession());
      }
    } catch (requestError) {
      setError(getAuthErrorMessage(requestError));
    } finally {
      setLoading(false);
    }
  }

  const title = confirmation
    ? 'Check your email'
    : mode === 'signup'
      ? 'Create your account'
      : 'Welcome back';

  const subtitle = confirmation
    ? `We sent a confirmation code to ${email}.`
    : mode === 'signup'
      ? 'Join us in just a few seconds.'
      : 'Sign in to continue where you left off.';

  return (
    <main className="page">
      <section className="auth-card" aria-labelledby="auth-title">
        <div className="brand-mark" aria-hidden="true">✦</div>
        <p className="eyebrow">YOUR ACCOUNT</p>
        <h1 id="auth-title">{title}</h1>
        <p className="subtitle">{subtitle}</p>

        <AuthForm
          mode={mode}
          confirmation={confirmation}
          email={email}
          loading={loading}
          error={error}
          success={success}
          onSubmit={handleSubmit}
        />

        {!confirmation && (
          <p className="switch">
            {mode === 'signup' ? 'Already have an account?' : 'New here?'}{' '}
            <button
              className="link-button"
              type="button"
              onClick={() => switchMode(mode === 'signup' ? 'signin' : 'signup')}
            >
              {mode === 'signup' ? 'Sign in' : 'Create an account'}
            </button>
          </p>
        )}
      </section>
    </main>
  );
}
