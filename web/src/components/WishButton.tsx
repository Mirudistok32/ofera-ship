import { startTransition, useOptimistic, useRef, useState } from 'react';
import { http, isHttpError } from '../api/http';
import { invalidate } from '../api/cache';
import { useToast } from './Toasts';
import type { WishResponse } from '../types';

/* Сердечко «в вишлист» для страницы оффера.
   Т14: useOptimistic — сердечко меняется сразу, сервер догоняет. Пока запрос идёт, видно желаемое;
   запрос кончился ошибкой — React сам вернёт подтверждённое состояние, а тост объяснит почему.
   Два быстрых клика: запросы идут по очереди (PUT, потом DELETE), иначе сервер мог бы получить их
   в обратном порядке и оставить оффер в вишлисте. Тост — только про последний клик. */
type WishButtonProps = { offerId: string; inWishlist: boolean; onChange?: (inWishlist: boolean) => void };

export function WishButton({ offerId, inWishlist, onChange }: WishButtonProps) {
  const toast = useToast();
  const [on, setOn] = useState(inWishlist);        // что подтвердил сервер
  const [seen, setSeen] = useState(inWishlist);
  const [shown, setShown] = useOptimistic(on);     // что видно сейчас
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const clicks = useRef(0);

  /* Страница перечитала оффер (invalidate после покупки) — верим свежему пропу */
  if (inWishlist !== seen) {
    setSeen(inWishlist);
    setOn(inWishlist);
  }

  function toggle() {
    const want = !shown;
    const click = ++clicks.current;
    startTransition(async () => {
      setShown(want);
      const request = queue.current.then(() => http<WishResponse>(`/wishlist/${offerId}`, { method: want ? 'PUT' : 'DELETE' }));
      queue.current = request.catch(() => undefined);   // упавший запрос не держит очередь
      try {
        /* Ответы приходят по порядку, поэтому каждый — правда о сервере на этот момент. Упадёт следующий клик —
           откат вернёт сердечко к этому ответу, а не к тому, что было до обоих кликов */
        const data = await request;
        invalidate('/offers');   // и страница оффера, и лента Барахолки показывают сердечко
        startTransition(() => {
          setOn(data.inWishlist);
          onChange?.(data.inWishlist);
        });
      } catch (e) {
        if (click !== clicks.current) return;   // уже кликнули снова — про старый клик не шумим
        const text = isHttpError(e) && e.code === 'WISHLIST_FULL'
          ? 'Вишлист полон: 30 из 30. Убери что-нибудь — и сердечко встанет'
          : `Сердечко не сохранилось: ${isHttpError(e) ? e.message : 'что-то пошло не так'}`;
        toast(text, 'error');
      }
    });
  }

  return (
    <button type="button" className="btn btn-small" onClick={toggle} aria-pressed={shown}>
      {shown ? '❤️ В вишлисте' : '🤍 В вишлист'}
    </button>
  );
}
