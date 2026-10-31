import { lazy, Suspense } from 'react';
import type { ReactNode } from 'react';
import { matchPath, useLocation } from './router';
import type { Params } from './router';
import { MeProvider } from './hooks/useMe';
import { Header } from './components/Header';
import { Ticker } from './components/Ticker';
import { RequireAuth } from './components/RequireAuth';
import { ToastProvider } from './components/Toasts';
import { ChaosPanel } from './devtools/ChaosPanel';
import { CHAOS_PANEL } from './config';
import { Home } from './pages/Home';
import { Login } from './pages/Login';
import { NotFound } from './pages/NotFound';
import { OfferPage } from './pages/OfferPage';
import { Shop } from './pages/Shop';
import { HrPanel } from './pages/HrPanel';
import { Market } from './pages/Market';
import { Wishlist } from './pages/Wishlist';
import { Premium } from './pages/Premium';
import { Registry } from './pages/Registry';
import { Picks } from './pages/Picks';
import { Analytics } from './pages/Analytics';
import { Family } from './pages/Family';

const Album = lazy(() => import('./pages/Album').then((m) => ({ default: m.Album })));
const Auction = lazy(() => import('./pages/Auction').then((m) => ({ default: m.Auction })));

/* Таблица маршрутов: первый подошедший шаблон и рисуется. Новые страницы — сюда.
   Закрытые — в RequireAuth: гость уходит на вход, HR-панель — только для роли hr */
const ROUTES: { path: string; page: (params: Params) => ReactNode }[] = [
  { path: '/', page: () => <Home /> },
  { path: '/login', page: () => <Login /> },
  { path: '/offers/:id', page: (p) => <OfferPage id={p.id} /> },
  { path: '/shop', page: () => <Shop /> },
  { path: '/hr', page: () => <RequireAuth role="hr"><HrPanel /></RequireAuth> },
  { path: '/album', page: () => <RequireAuth><Album /></RequireAuth> },
  { path: '/market', page: () => <Market /> },
  { path: '/wishlist', page: () => <RequireAuth><Wishlist /></RequireAuth> },
  { path: '/auction', page: () => <Auction /> },
  { path: '/premium', page: () => <RequireAuth><Premium /></RequireAuth> },
  { path: '/registry', page: () => <Registry /> },
  { path: '/picks', page: () => <Picks /> },
  { path: '/analytics', page: () => <Analytics /> },
  { path: '/family', page: () => <Family /> },
];

function Page() {
  const { path } = useLocation();
  for (const route of ROUTES) {
    const params = matchPath(route.path, path);
    if (params) return route.page(params);
  }
  return <NotFound />;
}

export function App() {
  return (
    <MeProvider>
      <ToastProvider>
        <Header />
        <Ticker />
        <main className="main">
          <Suspense fallback={<p className="center muted small">Загружаем…</p>}><Page /></Suspense>
        </main>
        {CHAOS_PANEL && <ChaosPanel />}
      </ToastProvider>
    </MeProvider>
  );
}
