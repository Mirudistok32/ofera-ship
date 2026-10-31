import { useSyncExternalStore } from 'react';
import type { MouseEvent, ReactNode } from 'react';

/* Свой роутер на History API: адрес — внешнее хранилище, компоненты подписываются на popstate.
   Снимок — строка pathname + search: одинаковый адрес не перерисовывает подписчиков */

export type Params = { [name: string]: string };
type NavigateOptions = { replace?: boolean };

const NAVIGATE = 'quest:navigate';

function subscribe(onChange: () => void) {
  window.addEventListener('popstate', onChange);
  window.addEventListener(NAVIGATE, onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(NAVIGATE, onChange);
  };
}

const snapshot = () => location.pathname + location.search;

export function navigate(to: string, { replace = false }: NavigateOptions = {}) {
  if (to === snapshot()) return;
  if (replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  window.dispatchEvent(new Event(NAVIGATE));   // pushState сам popstate не шлёт
}

export function useLocation() {
  const href = useSyncExternalStore(subscribe, snapshot);
  const url = new URL(href, location.origin);
  return { path: url.pathname, search: url.searchParams };
}

/* '/offers/:id' и '/offers/o00042' → { id: 'o00042' }; не подошёл — null */
export function matchPath(pattern: string, path: string): Params | null {
  const want = pattern.split('/');
  const got = path.split('/');
  if (want.length !== got.length) return null;
  const params: Params = {};
  for (let i = 0; i < want.length; i++) {
    if (want[i].startsWith(':')) params[want[i].slice(1)] = decodeURIComponent(got[i]);
    else if (want[i] !== got[i]) return null;
  }
  return params;
}

type LinkProps = { to: string; children: ReactNode; className?: string };

export function Link({ to, children, className }: LinkProps) {
  const { path } = useLocation();
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;   // новая вкладка — как обычно
    e.preventDefault();
    navigate(to);
  };
  const active = path === new URL(to, location.origin).pathname;
  return (
    <a href={to} onClick={onClick} className={className} aria-current={active ? 'page' : undefined}>
      {children}
    </a>
  );
}
