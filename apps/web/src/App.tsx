import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from './auth/RequireAuth';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { MovementsPage } from './pages/MovementsPage';
import { NewSalePage } from './pages/NewSalePage';
import { ProductsPage } from './pages/ProductsPage';
import { SyncStatusPage } from './pages/SyncStatusPage';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<Layout />}>
          <Route index element={<ProductsPage />} />
          <Route path="sales/new" element={<NewSalePage />} />
          <Route path="movements" element={<MovementsPage />} />
          <Route path="sync" element={<SyncStatusPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
