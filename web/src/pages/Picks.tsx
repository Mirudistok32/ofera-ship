import { useEffect, useState } from 'react';
import { useRegistry } from '../hooks/useRegistry';
import { Link, navigate, useLocation } from '../router';
import type { Offer } from '../types';

const money = (n: number) => n.toLocaleString('ru-RU');
const byPrice = (a: Offer, b: Offer) => a.price - b.price;

/* Подборка /picks: PR стажёра после ревью (Т25). Поиск по названию, сортировка, шорт-лист и заметки */
export function Picks() {
  const { search } = useLocation();
  const q = search.get('q') ?? '';
  const { rows, error } = useRegistry();
  const [cheapFirst, setCheapFirst] = useState(false);
  const [shortlist, setShortlist] = useState<string[]>([]);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);   // от прошлого значения: колбэк живёт дольше рендера
    return () => clearInterval(id);
  }, []);

  const found = q ? rows.filter((o) => o.title.toLowerCase().includes(q.toLowerCase())) : rows;
  const shown = cheapFirst ? [...found].sort(byPrice) : found;   // sort меняет массив на месте, а rows — состояние
  const sum = rows.filter((o) => shortlist.includes(o.id)).reduce((all, o) => all + o.price, 0);

  const toggle = (id: string) => setShortlist((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  return (
    <section className="stack">
      <h1>🧑‍🎓 Подборка</h1>
      <p className="muted">Запрос: <b>{q || 'все офферы'}</b> · нашлось {shown.length}</p>
      <p className="muted small">Собрано {seconds} с назад</p>
      <label className="field reg-mark">
        <span>Искать в названии</span>
        <input value={q} onChange={(e) => navigate(`/picks?q=${encodeURIComponent(e.target.value)}`, { replace: true })} placeholder="React, Lead…" />
      </label>
      <label className="row">
        <input type="checkbox" checked={cheapFirst} onChange={(e) => setCheapFirst(e.target.checked)} /> Сначала дешёвые
      </label>
      {shortlist.length > 0 && <p className="note">В шорт-листе: {shortlist.length} на {money(sum)} 🍪</p>}
      {error && <p className="note note-error">{error}</p>}
      <div className="stack">
        {shown.map((o) => (
          <PickRow key={o.id} offer={o} picked={shortlist.includes(o.id)} onToggle={() => toggle(o.id)} />
        ))}
      </div>
    </section>
  );
}

function PickRow({ offer, picked, onToggle }: { offer: Offer; picked: boolean; onToggle: () => void }) {
  const [note, setNote] = useState('');
  return (
    <div className={`card rarity-${offer.rarity}`}>
      <Link to={`/offers/${offer.id}`}>{offer.title}</Link>
      <span className="small muted">{offer.grade} · {offer.city} · <b>{offer.price}</b> 🍪</span>
      <div className="row">
        <button type="button" className="btn btn-small" aria-pressed={picked} onClick={onToggle}>{picked ? '⭐ В шорт-листе' : '☆ В шорт-лист'}</button>
      </div>
      <label className="field">
        <span>Заметка</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Что спросить на созвоне" />
      </label>
    </div>
  );
}
