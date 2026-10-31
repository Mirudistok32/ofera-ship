import { useEffect, useState } from 'react';
import { http, isHttpError } from '../api/http';
import { useMe } from '../hooks/useMe';
import { useQuery } from '../hooks/useQuery';
import { Link } from '../router';
import type { Boost, BoostResponse } from '../types';

/* Лавка: заряды усилений за 🍪 и «Аванс».
   Премиальные усиления включаются с «Синдромом отличника» — здесь их только показывают */
export function Shop() {
  const { me, loading, reload, setMe } = useMe();
  // Витрина одна для всех (заряды — в me.boosts): через кэш, один запрос и при двойном эффекте StrictMode (Т3, Т7)
  const boosts = useQuery<{ items: Boost[] }>('/shop').data?.items ?? [];
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    reload();   // «чтобы печеньки в шапке были свежие»
  }, [reload]);

  /* Купить заряд или включить усиление: ответ несёт user целиком — шапка обновится.
     Т17: успех пишем только внутри try, после ответа. Ошибку не глотаем, а показываем текст сервера:
     409 и 422 — ожидаемые отказы («Больше 3 в рюкзак не влезет»), 500 и сеть — тоже по-человечески */
  async function act(boost: Boost, action: 'buy' | 'use') {
    setBusy(boost.id);
    try {
      const url = action === 'buy' ? `/shop/${boost.id}/buy` : `/boosts/${boost.id}/use`;
      const data = await http<BoostResponse>(url, { method: 'POST' });
      setMe(data.user);
      setNote({ text: `${boost.emoji} ${boost.name}: ${action === 'buy' ? 'заряд в рюкзаке' : 'включено'}. Осталось ${data.user.cookies} 🍪`, error: false });
    } catch (e: unknown) {
      const reason = isHttpError(e) ? e.message : 'что-то пошло не так';
      setNote({ text: `${boost.emoji} ${boost.name}: не вышло — ${reason}`, error: true });
    } finally {
      setBusy('');
    }
  }

  if (!me) {
    if (loading) return <p className="muted">Загрузка…</p>;
    return (
      <section className="panel narrow">
        <h1>Лавка</h1>
        <p>Усиления продают только своим.</p>
        <Link to="/login" className="btn btn-primary">Войти</Link>
      </section>
    );
  }

  return (
    <div className="stack">
      <section className="panel">
        <h1>Лавка</h1>
        <p className="muted">Заряды усилений за 🍪. Кофе и улыбка включаются здесь, письмо — в окне покупки, «Аванс» — раз в 10 минут.</p>
        {note && <p className={note.error ? 'note note-error' : 'note'} role="status">{note.text}</p>}
      </section>
      <div className="cards">
        {boosts.map((b) => (
          <article key={b.id} className="card boost">
            <b>{b.emoji} {b.name}</b>
            <span className="small">{b.effect}</span>
            <span className="muted small">
              Зарядов: {me.boosts[b.id] ?? 0} из {b.qty}
              {b.cooldownSec > 0 && ` · перезарядка ${Math.round(b.cooldownSec / 60)} мин`}
            </span>
            {b.premium ? (
              <span className="badge">⭐ только с премиумом</span>
            ) : (
              <div className="row">
                {b.price > 0 && (
                  <button type="button" className="btn btn-small" disabled={busy === b.id} onClick={() => act(b, 'buy')}>
                    Купить за {b.price} 🍪
                  </button>
                )}
                {(b.durationSec > 0 || b.id === 'advance') && (
                  <button type="button" className="btn btn-small" disabled={busy === b.id} onClick={() => act(b, 'use')}>
                    {b.id === 'advance' ? 'Взять аванс' : 'Включить'}
                  </button>
                )}
              </div>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
