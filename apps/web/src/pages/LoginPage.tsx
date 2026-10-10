import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { usePageTitle } from '../lib';

const DEMO_USERS = [
  ['admin@acme.test', 'admin', 'Acme Store'],
  ['operator@acme.test', 'operator', 'Acme Store'],
  ['admin@globex.test', 'admin', 'Globex Retail'],
  ['operator@globex.test', 'operator', 'Globex Retail'],
] as const;

export function LoginPage() {
  usePageTitle('Log in');
  const { user, login } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (user) return <Navigate to={(location.state as { from?: string } | null)?.from ?? '/'} replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await login(email.trim(), password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not log in. Please try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="login">
      <h1>StockSync</h1>
      <p className="muted">Log in to manage your products and register sales.</p>

      <form onSubmit={onSubmit} aria-describedby={error ? 'login-error' : undefined}>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error && (
          <p id="login-error" className="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={pending}>
          {pending ? 'Logging in…' : 'Log in'}
        </button>
      </form>

      <details className="demo">
        <summary>Demo users (development seed)</summary>
        <p className="muted small">
          Password for all: <code>password123</code>. Use one user per tenant to check that data is isolated.
        </p>
        <ul>
          {DEMO_USERS.map(([mail, role, tenant]) => (
            <li key={mail}>
              <button type="button" className="link" onClick={() => { setEmail(mail); setPassword('password123'); }}>
                {mail}
              </button>{' '}
              <span className="muted">
                {role} · {tenant}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </main>
  );
}
