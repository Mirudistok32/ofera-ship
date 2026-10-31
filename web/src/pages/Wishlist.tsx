import { startTransition, useEffect, useOptimistic, useState } from 'react';
import { http, isAbort, isHttpError } from '../api/http';
import { invalidate } from '../api/cache';
import { useMe } from '../hooks/useMe';
import { useToast } from '../components/Toasts';
import { Link } from '../router';
import { OfferCard } from '../components/OfferCard';
import type { Offer, WishResponse } from '../types';

const LIMIT = 30;   // больше — 422 WISHLIST_FULL

/* Вишлист: офферы «на подумать», новые сверху.
   Т14: «Убрать» прячет карточку сразу — useOptimistic показывает список без неё, пока идёт DELETE.
   Сервер отказал — переход закончился, и React показывает подтверждённый список: карточка на месте, тост объясняет */
export function Wishlist() {
  const { me, loading } = useMe();
  const toast = useToast();
  const userId = me?.id ?? null;
  const [items, setItems] = useState<Offer[]>([]);
  const [shown, hide] = useOptimistic(items, (list: Offer[], id: string) => list.filter((o) => o.id !== id));

  /* Грузим по id, а не по me: me меняется на каждой покупке, а вишлист от неё не зависит */
  useEffect(() => {
    if (!userId) return;
    const ctrl = new AbortController();
    http<{ items: Offer[]; total: number }>('/wishlist', { signal: ctrl.signal })
      .then((data) => setItems(data.items))
      .catch((e: unknown) => {
        if (!isAbort(e)) toast(`Вишлист не загрузился: ${isHttpError(e) ? e.message : 'что-то пошло не так'}`, 'error');
      });
    return () => ctrl.abort();
  }, [userId, toast]);

  if (!me) {
    if (loading) return <p className="muted">Загрузка…</p>;
    return (
      <section className="panel narrow">
        <h1>Вишлист</h1>
        <p>Вишлист — только для своих.</p>
        <Link to="/login" className="btn btn-primary">Войти</Link>
      </section>
    );
  }

  function remove(offer: Offer) {
    startTransition(async () => {
      hide(offer.id);
      try {
        await http<WishResponse>(`/wishlist/${offer.id}`, { method: 'DELETE' });
        invalidate('/offers');   // сердечко на странице оффера и в Барахолке
        startTransition(() => setItems((list) => list.filter((o) => o.id !== offer.id)));
      } catch (e) {
        toast(`«${offer.title}» осталось в вишлисте: ${isHttpError(e) ? e.message : 'что-то пошло не так'}`, 'error');
      }
    });
  }

  return (
    <div className="stack">
      <section className="panel">
        <h1>Вишлист</h1>
        <p className="muted">{shown.length} из {LIMIT}. Пять офферов здесь — ачивка «Хочу-хочу».</p>
      </section>
      {shown.length ? (
        <div className="cards">
          {shown.map((o) => (
            <div key={o.id} className="stack wish-item">
              <OfferCard offer={o} />
              <button type="button" className="btn btn-small" onClick={() => remove(o)}>💔 Убрать</button>
            </div>
          ))}
        </div>
      ) : (
        <section className="panel empty">
          <p>🤍 Пока пусто. Сердечко ставится на странице оффера.</p>
          <Link to="/market" className="btn btn-small">В Барахолку</Link>
        </section>
      )}
    </div>
  );
}
