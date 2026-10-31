import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyTheme, savedTheme } from './theme';
import './styles.css';

applyTheme(savedTheme());

/* StrictMode оставлен нарочно: двойной эффект при монтировании сразу показывает забытый cleanup */
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
