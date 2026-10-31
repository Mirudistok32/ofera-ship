import { useCallback, useEffect, useState } from 'react';
import { http, isAbort, isHttpError } from '../api/http';
import { serverNow, subscribe, syncClock } from '../api/stream';
import { useMe } from '../hooks/useMe';
import { rarityName, RARITIES } from '../rarity';
import type { BidEvent, BidResponse, Lot, LotEndEvent, LotsResponse } from '../types';

/* Осталось до конца торгов: 125 000 мс → «2:05» */
function left(ms: number): string {
  if (ms <= 0) return 'торги окончены';
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* Свежее состояние лота побеждает старое. Ставок у лота только прибавляется, поэтому по bids видно,
   что новее: событие SSE и ответ на свою ставку приходят в любом порядке и про одну и ту же ставку */
function fresher(lot: Lot, next: Lot): Lot {
  return next.bids >= lot.bids ? { ...next, offer: next.offer ?? lot.offer } : lot;
}

/* Аукцион: открытые лоты, таймер и ставка.
   Т15: ставка с expected — ценой, которую видно на экране; отказ сервера объясняется у поля.
   Т16: ставки других и конец торгов приходят по SSE, таймер считает по часам сервера */
export function Auction() {
  const { me, setMe, reload } = useMe();
  const myId = me?.id ?? null;
  const [lots, setLots] = useState<Lot[]>([]);
  const [step, setStep] = useState(10);
  const [now, setNow] = useState(serverNow);
  const [note, setNote] = useState('');
  const [hammer, setHammer] = useState(0);   // сколько лотов закончилось — после каждого подгружаем новые

  const patch = useCallback((id: string, change: (lot: Lot) => Lot) => {
    setLots((list) => list.map((lot) => (lot.id === id ? change(lot) : lot)));
  }, []);

  /* Открытые лоты с сервера. Закончившиеся остаются в конце списка с итогом, пока страница открыта */
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await http<LotsResponse>('/lots', { signal });
      syncClock(data.serverTime);
      setNow(serverNow());   // не ждём тика: со сбитыми часами первая секунда показала бы «торги окончены»
      setStep(data.step);
      setLots((list) => [...data.items, ...list.filter((lot) => lot.status !== 'open' && !data.items.some((o) => o.id === lot.id))]);
    } catch (e) {
      if (!isAbort(e)) setNote(isHttpError(e) ? e.message : 'Лоты не загрузились');
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  /* Боты выставляют новый лот, когда закончился старый: в SSE об этом события нет, поэтому перечитываем список */
  useEffect(() => {
    if (!hammer) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => load(ctrl.signal), 1000);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [hammer, load]);

  /* Т16: таймер тикает по часам сервера. Date.now() браузера может убежать на минуты —
     serverNow() = Date.now() + сдвиг, а сдвиг приходит в serverTime каждого ответа и события */
  useEffect(() => {
    const timer = setInterval(() => setNow(serverNow()), 1000);
    return () => clearInterval(timer);
  }, []);

  /* Т16: ставки — из общего потока. Вторая вкладка и боты видны сразу, без «Обновить».
     Антиснайпинг приходит тем же событием: endsAt сдвинулся — таймер сам показал новое время */
  useEffect(() => subscribe<BidEvent>('bid', (e) => {
    patch(e.lotId, (lot) => (e.bids > lot.bids ? {
      ...lot, price: e.price, minBid: e.minBid, leader: e.leader, bids: e.bids, endsAt: e.endsAt,
      extensions: lot.extensions + (e.extended ? 1 : 0),
    } : lot));
    /* Перебили меня: 🍪 разморозились на сервере, шапке нужен свежий пользователь */
    if (myId && e.outbid === myId && e.leader?.id !== myId) {
      setNote(`Перебили: ${e.leader?.name ?? 'кто-то'} поставил ${e.amount} 🍪, твои 🍪 вернулись на счёт`);
      reload();
    }
  }), [patch, reload, myId]);

  useEffect(() => subscribe<LotEndEvent>('lot-end', (e) => {
    patch(e.lotId, (lot) => ({ ...lot, status: e.status, price: e.price, leader: e.winner }));
    setHammer((n) => n + 1);
    if (myId && (e.winner?.id === myId || e.seller?.id === myId)) {
      setNote(e.winner?.id === myId ? `Продано тебе за ${e.price} 🍪 — карточка в Альбоме` : `Лот закрыт: ${e.status === 'sold' ? `продан за ${e.price} 🍪` : 'без ставок, карточка вернулась'}`);
      reload();
    }
  }), [patch, reload, myId]);

  /* Поток переподключился (сеть, новый пропуск): то, что не догналось по Last-Event-ID, берём списком */
  useEffect(() => subscribe('hello', () => load()), [load]);

  /* Т15: ставка. Ошибка — строка для поля ставки, null — принята */
  async function bid(lot: Lot, amount: number): Promise<string | null> {
    try {
      const data = await http<BidResponse>(`/lots/${lot.id}/bids`, { method: 'POST', body: JSON.stringify({ amount, expected: lot.price }) });
      syncClock(data.serverTime);
      setMe(data.user);   // 🍪 списались и заморозились — шапка видит сразу
      patch(lot.id, (old) => fresher(old, data.lot));
      setNote(`Ставка ${amount} 🍪 на «${lot.offer?.title ?? lot.offerId}» принята${data.bid.extended ? ' · антиснайпинг: торги продлены' : ''}`);
      return null;
    } catch (e) {
      if (!isHttpError(e)) throw e;
      const info = e.body?.error;
      if (info?.serverTime) syncClock(info.serverTime);
      switch (e.code) {
        case 'OUTBID':
          /* Пока решали, перебили: новая цена и минимальная ставка — из ответа, без перезагрузки списка */
          patch(lot.id, (old) => ({
            ...old, price: info?.price ?? old.price, minBid: info?.minBid ?? old.minBid,
            leader: info?.leader ?? old.leader, endsAt: info?.endsAt ?? old.endsAt,
          }));
          return `Перебили: теперь ${info?.price} 🍪, ставка — от ${info?.minBid} 🍪`;
        case 'BID_STEP':
          if (info?.minBid) patch(lot.id, (old) => ({ ...old, minBid: info.minBid ?? old.minBid }));
          return e.fields.amount ?? e.message;
        case 'LOT_ENDED':
          /* Итог придёт событием lot-end, а пока — таймер в ноль и форму прочь */
          patch(lot.id, (old) => ({ ...old, endsAt: new Date(serverNow()).toISOString() }));
          return 'Торги уже закончились — молоток стукнул';
        case 'ALREADY_LEADING':
          return 'Ставка и так твоя — ждём, пока перебьют';
        case 'NOT_ENOUGH_COOKIES':
          return `Не хватает 🍪: на счету ${me?.cookies ?? 0}. Аванс — в Лавке`;
        default:
          return e.message;
      }
    }
  }

  return (
    <div className="stack">
      <section className="panel">
        <h1>Аукцион</h1>
        <p className="muted">
          Шаг ставки — от {step} 🍪. Ставка в последние 10 секунд продлевает торги. «Вечный кандидат» не спит.
        </p>
        {me && <p className="small">На счету {me.cookies} 🍪, заморожено в ставках {me.frozen} 🍪.</p>}
        {note && <p className="note" role="status">{note}</p>}
      </section>

      {lots.length ? (
        <div className="cards">
          {lots.map((lot) => (
            <LotCard key={lot.id} lot={lot} now={now} myId={myId} onBid={bid} />
          ))}
        </div>
      ) : (
        <p className="muted">Лотов пока нет — боты скоро выставят.</p>
      )}
    </div>
  );
}

type LotCardProps = { lot: Lot; now: number; myId: string | null; onBid: (lot: Lot, amount: number) => Promise<string | null> };

function LotCard({ lot, now, myId, onBid }: LotCardProps) {
  const [amount, setAmount] = useState(lot.minBid);
  const [minSeen, setMinSeen] = useState(lot.minBid);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const rarity = lot.offer ? RARITIES.find((r) => r.id === lot.offer?.rarity) : undefined;
  const ms = Date.parse(lot.endsAt) - now;
  const open = lot.status === 'open' && ms > 0;
  const leading = Boolean(myId) && lot.leader?.id === myId;
  const canBid = Boolean(myId) && lot.seller?.id !== myId && open;

  /* Минимальная ставка выросла — поднимаем сумму в поле, если она стала меньше. Во время рендера, а не в эффекте:
     так поле не мигает старым числом. key с minBid, как было, пересоздавал карточку и стирал то, что набрано */
  if (lot.minBid !== minSeen) {
    setMinSeen(lot.minBid);
    if (amount < lot.minBid) setAmount(lot.minBid);
  }

  async function submit() {
    setBusy(true);
    setError((await onBid(lot, amount)) ?? '');
    setBusy(false);
  }

  return (
    <article className={`card lot rarity-${lot.offer?.rarity ?? 'common'}`}>
      {lot.offer && <span className="badge badge-rarity">{rarity?.emoji} {rarityName(lot.offer.rarity)}</span>}
      <b>{lot.offer?.title ?? lot.offerId}</b>
      <span className="muted small">продаёт {lot.seller?.name ?? '—'}</span>
      <span className="lot-price">{lot.price} 🍪 <span className="muted small">· ставок {lot.bids}</span></span>
      {lot.status === 'open' ? (
        <span className="small">Лидер: {leading ? 'ты' : lot.leader?.name ?? 'пока никого'}</span>
      ) : (
        <span className="small">{lot.status === 'sold' ? `Продано: ${lot.leader?.name ?? '—'}` : 'Без ставок — снят'}</span>
      )}
      <span className={`small timer${open && ms < 10_000 ? ' timer-hot' : ''}`}>⏱ {left(open ? ms : 0)}{lot.extensions > 0 && ` · продлён ×${lot.extensions}`}</span>
      {canBid && !leading && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <div className="row">
            <input
              type="number" className="bid-input" min={lot.minBid} step={lot.step} value={amount}
              onChange={(e) => setAmount(Number(e.target.value))} aria-label="Ставка, 🍪" aria-invalid={Boolean(error)}
            />
            <button type="submit" className="btn btn-small btn-primary" disabled={busy}>{busy ? 'Ставим…' : 'Ставка'}</button>
          </div>
          {error && <span className="field-error" role="alert">{error}</span>}
        </form>
      )}
    </article>
  );
}
