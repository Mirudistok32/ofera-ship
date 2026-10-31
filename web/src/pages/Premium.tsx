import { useEffect, useState } from 'react';
import { http } from '../api/http';
import { refresh } from '../api/session';
import { useMe } from '../hooks/useMe';
import { Link } from '../router';
import type { Lounge, Offer, PremiumInfo, PremiumResponse } from '../types';

/* Премиум «Синдром отличника»: 3 🏆 → 15 минут премиальных усилений и «Переговорка отличников».
   Тариф живёт в токене: после покупки старый пропуск ещё «free», поэтому сразу refresh (refreshNeeded: true).
   Премиум кончился, а пропуск помнит его — 403 PLAN_STALE; его лечит http: refresh и один повтор.
   Гостя сюда не пускает RequireAuth в App: GET /premium без токена — 401 */
export function Premium() {
  const { me, setMe } = useMe();
  const [info, setInfo] = useState<PremiumInfo | null>(null);
  const [lounge, setLounge] = useState<Offer[] | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    http<PremiumInfo>('/premium').then(setInfo);
  }, []);

  async function buy() {
    setBusy(true);
    setError('');
    try {
      const data = await http<PremiumResponse>('/premium', { method: 'POST' });
      setMe(data.user);
      if (data.refreshNeeded) await refresh();   // новый пропуск с plan: 'premium' — иначе /lounge ответит PLAN_STALE
      setInfo(await http<PremiumInfo>('/premium'));
      setNote('⭐ «Синдром отличника» включён на 15 минут');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Не получилось купить');
    } finally {
      setBusy(false);
    }
  }

  async function enter() {
    setError('');
    try {
      const data = await http<Lounge>('/lounge');
      setLounge(data.items);
    } catch (e: unknown) {
      setLounge(null);
      setError(e instanceof Error ? e.message : 'Дверь не открылась');
    }
  }

  const until = info?.premiumUntil ? new Date(info.premiumUntil).toLocaleTimeString('ru-RU') : '';

  return (
    <div className="stack">
      <section className="panel">
        <h1>⭐ Синдром отличника</h1>
        <p>Премиум на 15 минут: «Знакомый в HR», «Оффер на руках», «Заморозка» и «Рекомендация» с полными зарядами.</p>
        {info?.plan === 'premium' ? (
          <p className="note">{info.forever ? 'Премиум навсегда.' : `Премиум до ${until}.`}</p>
        ) : (
          <p className="muted">
            Цена — {info?.cost ?? 3} 🏆 со счёта, ачивки при этом не пропадают. На счету: {me?.trophies ?? 0} 🏆.
          </p>
        )}
        {note && <p className="note" role="status">{note}</p>}
        {error && <p className="note note-error" role="alert">{error}</p>}
        <div className="row">
          <button type="button" className="btn btn-primary" onClick={buy} disabled={busy || info?.plan === 'premium'}>
            Купить за {info?.cost ?? 3} 🏆
          </button>
          <button type="button" className="btn" onClick={enter} disabled={busy}>Зайти в переговорку</button>
        </div>
      </section>

      {lounge && (
        <section className="panel">
          <h2>Переговорка отличников</h2>
          {lounge.length ? (
            <ul className="lounge">
              {lounge.map((o) => (
                <li key={o.id}><Link to={`/offers/${o.id}`}>{o.title}</Link> · {o.price} 🍪</li>
              ))}
            </ul>
          ) : (
            <p className="muted">Дверь не открылась.</p>
          )}
        </section>
      )}
    </div>
  );
}
