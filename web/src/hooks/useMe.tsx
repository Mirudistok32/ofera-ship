import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { http } from '../api/http';
import { getToken, onSession } from '../api/session';
import { restore } from '../api/auth';
import type { MeResponse, User } from '../types';

/* Кто вошёл: пользователь для шапки (🍪 и 🏆) и закрытых страниц.
   setMe — после ответов, которые несут user целиком (покупка, усиление); reload — спросить /me заново.
   Своего кэша нет: пользователь живёт в state и приходит с каждым входом, refresh и выходом через onSession.
   Модульная переменная пережила бы выход и показала бы следующему чужие 🍪 (Т12) */

type MeState = { me: User | null; loading: boolean; setMe: (user: User | null) => void; reload: () => Promise<void> };

const MeContext = createContext<MeState | null>(null);

export function MeProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);   // до ответа refresh неизвестно, гость ли это

  /* Подписка раньше restore: refresh сообщит пользователя через onSession */
  useEffect(() => onSession(setMe), []);

  useEffect(() => {
    restore().finally(() => setLoading(false));
  }, []);

  /* Один /me на всех: StrictMode и соседние страницы зовут reload одновременно — второй ждёт тот же запрос.
     Сбой /me не роняет страницу: шапка остаётся со старыми 🍪, а http уже повторил GET (Т3) */
  const pending = useRef<Promise<void> | null>(null);
  const reload = useCallback(() => {
    if (!getToken()) {
      setMe(null);
      return Promise.resolve();
    }
    pending.current ??= http<MeResponse>('/me')
      .then((data) => setMe(data.user), () => {})
      .finally(() => {
        pending.current = null;
      });
    return pending.current;
  }, []);

  return <MeContext.Provider value={{ me, loading, setMe, reload }}>{children}</MeContext.Provider>;
}

export function useMe(): MeState {
  const state = useContext(MeContext);
  if (!state) throw new Error('useMe — только внутри <MeProvider>');
  return state;
}
