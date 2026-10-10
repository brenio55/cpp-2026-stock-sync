import { useEffect, useRef } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

export function Layout() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const main = useRef<HTMLElement>(null);

  // On navigation, move focus to the content so keyboard and screen-reader users start at the new page.
  useEffect(() => {
    main.current?.focus();
  }, [location.pathname]);

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="app-header">
        <div className="brand">StockSync</div>
        <nav aria-label="Main">
          <NavLink to="/" end>
            Products
          </NavLink>
          <NavLink to="/sales/new">New sale</NavLink>
          <NavLink to="/movements">Stock history</NavLink>
          <NavLink to="/sync">Sync status</NavLink>
        </nav>
        <div className="user">
          <span>
            {user?.email} <span className="badge">{user?.role}</span>
            <span className="muted"> · {user?.tenant.name}</span>
          </span>
          <button type="button" className="secondary" onClick={logout}>
            Log out
          </button>
        </div>
      </header>
      <main id="main" ref={main} tabIndex={-1}>
        <Outlet />
      </main>
    </>
  );
}
