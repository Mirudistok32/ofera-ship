import { useCallback, useEffect, useRef, useState } from 'react';
import { http } from '../api/http';
import type { Offer, OffersPage } from '../types';

const LIMIT = 50;   // больше сервер не отдаёт: PAGE.max

/* Реестр: все офферы подряд, страницами по курсору. Готовая часть — в Т24 её не переписывают.
   more() просит следующую страницу; пока одна в полёте, вторая не уходит; end — сервер отдал последнюю */
export function useRegistry() {
  const [rows, setRows] = useState<Offer[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [end, setEnd] = useState(false);
  const cursor = useRef<string | null>(null);
  const busy = useRef(false);

  const more = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const after = cursor.current ? `&cursor=${encodeURIComponent(cursor.current)}` : '';
      const page = await http<OffersPage>(`/offers?limit=${LIMIT}${after}`);
      cursor.current = page.nextCursor;
      setRows((rs) => [...rs, ...page.items]);
      setTotal(page.total);
      setEnd(!page.nextCursor);
      setError('');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Не загрузилось');
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    if (!cursor.current && !busy.current) void more();
  }, [more]);

  return { rows, total, error, end, more };
}
