/* Тема: без выбора — как в системе (CSS @media), выбор запоминается в localStorage и ставится data-theme на <html> */

export type Theme = 'light' | 'dark';
const KEY = 'quest-theme';

export function savedTheme(): Theme | null {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : null;
  } catch {
    return null;
  }
}

export const systemTheme = (): Theme => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

export function applyTheme(theme: Theme | null) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  try {
    if (theme) localStorage.setItem(KEY, theme);
    else localStorage.removeItem(KEY);
  } catch {
    /* приватное окно — тема не запомнится */
  }
}
