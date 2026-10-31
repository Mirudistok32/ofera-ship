import { useSyncExternalStore } from 'react';

/* Переключатель бейджей <RenderCount> и счётчики по именам. Отдельное хранилище, а не контекст:
   включение пульта перерисовывает только бейджи, а не всё дерево — иначе счётчик врал бы сам себе */

const KEY = 'quest-render-count';
const listeners = new Set<() => void>();
let on = read();
let totals: { [name: string]: number } = {};

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function setRenderCountOn(next: boolean) {
  on = next;
  try {
    localStorage.setItem(KEY, next ? '1' : '0');
  } catch {
    /* приватное окно — переключатель просто не запомнится */
  }
  listeners.forEach((l) => l());
}

export function useRenderCountOn(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => on,
  );
}

export function countRender(name: string) {
  totals[name] = (totals[name] ?? 0) + 1;
}

export const renderTotals = () => ({ ...totals });

export function resetRenderTotals() {
  totals = {};
}
