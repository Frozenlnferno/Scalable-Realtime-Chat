import { useEffect, useState } from 'react';
import AuthPage from '../pages/AuthPage';
import DashboardPage from '../pages/DashboardPage';
import { getAuthenticatedSession } from '../services/authService';

export default function App() {
  const [session, setSession] = useState();

  useEffect(() => {
    getAuthenticatedSession().then(setSession).catch(() => setSession(null));
  }, []);

  if (session === undefined) return <main className="page">Loading your account…</main>;
  if (!session) return <AuthPage onAuthenticated={setSession} />;
  return <DashboardPage session={session} onSignedOut={() => setSession(null)} />;
}
