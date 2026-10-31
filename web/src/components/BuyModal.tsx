import { useRef, useState } from 'react';
import { http, isHttpError } from '../api/http';
import { invalidate } from '../api/cache';
import { useMe } from '../hooks/useMe';
import { Modal } from './Modal';
import type { Offer, PurchaseResponse } from '../types';

const LETTER = 'cover-letter';   // ✉️ −10% к цене покупки

/* Окно покупки оффера: цена, «Сопроводительное письмо» и кнопка «Купить».
   Т13: покупка списывает 🍪, поэтому её нельзя повторять вслепую.
   - Idempotency-Key — один на попытку. Сеть упала, ответа нет — жмут ещё раз с тем же ключом:
     если покупка на сервере прошла, он вернёт тот же ответ, а не спишет второй раз.
   - Условия поменялись (новая цена, письмо) — это новая попытка и новый ключ.
   - Пока запрос идёт, кнопка заблокирована, а ref не пустит второй клик, пришедший раньше рендера.
   - 409 PRICE_CHANGED: новая цена — из ответа, покупка по ней — только после ещё одного «Купить». */
type BuyModalProps = { offer: Offer; open: boolean; onClose: () => void };

export function BuyModal({ offer, open, onClose }: BuyModalProps) {
  const { me, setMe } = useMe();
  const [letter, setLetter] = useState(false);
  const [price, setPrice] = useState(offer.price);   // цена, с которой согласились: она и уходит в expectedPrice
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const key = useRef<string | null>(null);
  const sending = useRef(false);

  const charges = me?.boosts[LETTER] ?? 0;
  const total = letter ? Math.round(price * 0.9) : price;

  function toggleLetter(on: boolean) {
    setLetter(on);
    key.current = null;   // другое тело запроса — другой ключ, иначе сервер ответит 422 IDEMPOTENCY_MISMATCH
  }

  async function buy() {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError('');
    key.current ??= crypto.randomUUID();
    try {
      const data = await http<PurchaseResponse>('/purchases', {
        method: 'POST',
        headers: { 'Idempotency-Key': key.current },
        body: JSON.stringify({ offerId: offer.id, expectedPrice: price, boosts: letter ? [LETTER] : [] }),
      });
      setMe(data.user);
      invalidate(`/offers/${offer.id}`);   // после покупки вилка открыта, а в кэше — оффер со звёздочкой
      setDone(`Куплено за ${data.purchase.paid} 🍪 — карточка в Альбоме`);
    } catch (e) {
      if (!isHttpError(e)) throw e;
      if (e.code === 'PRICE_CHANGED') {
        const next = e.body?.error.price ?? price;
        setError(`Пока шли раздумья, цену подняли: было ${price} 🍪, стало ${next} 🍪. Купить по новой цене?`);
        setPrice(next);
        key.current = null;   // новая цена — новая попытка
      } else if (e.code === 'NOT_ENOUGH_COOKIES') {
        setError(`Печенек не хватает: нужно ${total} 🍪, на счету ${me?.cookies ?? 0} 🍪. Аванс — в Лавке`);
      } else if (e.status === 0) {
        setError(`${e.message}. Нажми ещё раз — с тем же ключом покупка не задвоится`);   // ключ не сбрасываем
      } else {
        setError(e.message);
      }
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  const footer = done ? (
    <button type="button" className="btn" onClick={onClose}>Закрыть</button>
  ) : (
    <>
      <button type="button" className="btn" onClick={onClose}>Подумаю</button>
      <button type="button" className="btn btn-primary" onClick={buy} disabled={busy}>
        {busy ? 'Покупаем…' : `Купить за ${total} 🍪`}
      </button>
    </>
  );

  return (
    <Modal open={open} title={`Купить «${offer.title}»`} onClose={onClose} footer={footer}>
      {done ? (
        <p className="note" role="status">🎉 {done}</p>
      ) : (
        <div className="stack">
          <p>Цена: <b>{price} 🍪</b>. На счету: {me?.cookies ?? 0} 🍪.</p>
          <label className="check">
            <input type="checkbox" checked={letter} disabled={charges === 0 || busy} onChange={(e) => toggleLetter(e.target.checked)} />
            <span>✉️ Сопроводительное письмо −10% (зарядов: {charges})</span>
          </label>
          {charges === 0 && <p className="muted small">Заряды письма продаются в Лавке.</p>}
          {error && <p className="note note-error" role="alert">{error}</p>}
        </div>
      )}
    </Modal>
  );
}
