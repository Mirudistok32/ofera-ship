import { useEffect, useState } from 'react';
import { http } from '../api/http';
import { subscribe } from '../api/stream';
import type { Offer, PriceEvent, TickerResponse } from '../types';

/* Бегущая строка биржи: 24 свежих оффера, цены двигает событие price из SSE /stream */
export function Ticker() {
  const [items, setItems] = useState<Offer[]>([]);
  const [moved, setMoved] = useState<PriceEvent | null>(null);

  /* Отмена в cleanup: в StrictMode иначе два /ticker делили бы сбои сервера, а ответ первого никому не нужен.
     Строка необязательная: не загрузилась — её просто нет, без необработанной ошибки */
  useEffect(() => {
    const ctrl = new AbortController();
    http<TickerResponse>('/ticker', { signal: ctrl.signal }).then((data) => setItems(data.items), () => {});
    return () => ctrl.abort();
  }, []);

  /* Т20: один поток на приложение — общий api/stream.ts, его же слушает аукцион. Свой EventSource
     здесь открывался бы на каждую смену адреса и висел, пока не кончатся 6 соединений на хост.
     subscribe возвращает отписку — она и есть cleanup: в StrictMode второй эффект не оставит лишний поток.
     Смену пропуска (вход, refresh, выход) поток отрабатывает сам — зависимостей у эффекта нет */
  useEffect(() => subscribe<PriceEvent>('price', (event) => {
    setItems((list) => list.map((o) => (o.id === event.offerId ? { ...o, price: event.price } : o)));
    setMoved(event);
  }), []);

  if (!items.length) return null;

  return (
    <div className="ticker" aria-label="Бегущая строка цен">
      <div className="ticker-in">
        {items.map((o) => {
          const delta = moved?.offerId === o.id ? moved.price - moved.was : 0;
          return (
            <span key={o.id} className="ticker-item">
              {o.title} <b>{o.price} 🍪</b>
              {delta !== 0 && <span className={delta > 0 ? 'up' : 'down'}>{delta > 0 ? ' ▲' : ' ▼'}{Math.abs(delta)}</span>}
            </span>
          );
        })}
      </div>
    </div>
  );
}
