import { useState } from 'react';
import { Link, navigate } from '../router';
import { logout } from '../api/auth';
import { useMe } from '../hooks/useMe';
import { applyTheme, savedTheme, systemTheme } from '../theme';
import type { Theme } from '../theme';

export function Header() {
  const { me, loading } = useMe();
  const [theme, setTheme] = useState<Theme>(() => savedTheme() ?? systemTheme());

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    setTheme(next);
  };

  /* logout сам сбросит пользователя и кэш через сессию */
  const onLogout = () => {
    void logout();
    navigate('/login');
  };

  return (
    <header className="topbar">
      <div className="topbar-in">
        <Link to="/" className="brand">💼 Офферомания</Link>
        <nav className="nav" aria-label="Разделы">
          <Link to="/">Главная</Link>
          <Link to="/market">Барахолка</Link>
          <Link to="/registry">Реестр</Link>
          <Link to="/shop">Лавка</Link>
          <Link to="/auction">Аукцион</Link>
          {me && <Link to="/wishlist">Вишлист</Link>}
          {me && <Link to="/album">Альбом</Link>}
          <Link to="/premium">⭐ Премиум</Link>
          {me?.role === 'hr' && <Link to="/hr">HR</Link>}
        </nav>
        <div className="me">
          {me ? (
            <>
              <span className="pill" title="Печеньки — на покупки">🍪 {me.cookies}</span>
              <span className="pill" title="Ачивки на счету — на премиум">🏆 {me.trophies}</span>
              <span className="me-name" title={`${me.login} · ${me.role} · ${me.plan}`}>{me.name}</span>
              <button type="button" className="btn btn-small" onClick={onLogout}>Выйти</button>
            </>
          ) : loading ? (
            <span className="muted small">…</span>
          ) : (
            <Link to="/login" className="btn btn-small btn-primary">Войти</Link>
          )}
          <button type="button" className="icon-btn" onClick={toggleTheme} aria-label={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}>
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
        </div>
      </div>
    </header>
  );
}
