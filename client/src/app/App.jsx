import { useEffect, useState } from 'react';
import AuthPage from '../pages/AuthPage';
import DashboardPage from '../pages/DashboardPage';
import { getAuthenticatedSession } from '../services/authService';

export default function App() {
  const [session, setSession] = useState();

  useEffect(() => {
    getAuthenticatedSession().then(setSession).catch(() => setSession(null));
  }, []);

  useEffect(() => {
    if (session && window.location.pathname !== '/dashboard') {
      window.history.replaceState({}, '', '/dashboard');
    }
  }, [session]);

  function handleAuthenticated(authenticatedSession) {
    window.history.replaceState({}, '', '/dashboard');
    setSession(authenticatedSession);
  }

  function handleSignedOut() {
    window.history.replaceState({}, '', '/');
    setSession(null);
  }

  if (session === undefined) return <main className="page">Loading your account…</main>;
  if (!session) return <AuthPage onAuthenticated={handleAuthenticated} />;
  return <DashboardPage session={session} onSignedOut={handleSignedOut} />;
}
