import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { http } from '../api/http';
import { useMe } from '../hooks/useMe';
import { Link } from '../router';
import { AlbumCard } from '../components/AlbumCard';
import { useToast } from '../components/Toasts';
import type { AlbumItem, AlbumResponse, Shelf, ShelfResponse, UpgradeRules } from '../types';

/* Альбом: купленные офферы, полки, фильтр, прокачка.
   Т21: в контексте — только то, что редко меняется и нужно всем карточкам. cards и filter
   остаются в Альбоме: иначе каждая буква в поиске давала бы новое значение контекста
   и перерисовку всех карточек. Своё у карточки (card, canMerge) приходит пропсами в memo */

type AlbumState = {
  shelves: Shelf[];
  rules: UpgradeRules | null;
  moveTo: (card: AlbumItem, shelf: string | null) => void;
  reload: () => void;
};

const AlbumContext = createContext<AlbumState | null>(null);

export function useAlbum(): AlbumState {
  const state = useContext(AlbumContext);
  if (!state) throw new Error('useAlbum — только внутри Альбома');
  return state;
}

export function Album() {
  const { me, loading } = useMe();
  const toast = useToast();
  const [cards, setCards] = useState<AlbumItem[]>([]);
  const [shelves, setShelves] = useState<Shelf[]>([]);
  const [rules, setRules] = useState<UpgradeRules | null>(null);
  const [filter, setFilter] = useState('');
  const [shelf, setShelf] = useState('all');
  const [ready, setReady] = useState(false);

  /* useCallback: ссылка на reload и moveTo стабильна — значение контекста не меняется на каждый рендер */
  const reload = useCallback(() => {
    http<AlbumResponse>('/album').then((data) => {
      setCards(data.items ?? []);
      setShelves(data.shelves ?? []);
      setReady(true);
    });
  }, []);

  useEffect(() => {
    if (!me) return;
    reload();
    http<UpgradeRules>('/upgrade').then(setRules);
  }, [me?.id, reload]);

  /* Переложить на полку: If-Match с версией карточки, иначе сервер ответит 428 */
  const moveTo = useCallback(async (card: AlbumItem, to: string | null) => {
    const data = await http<ShelfResponse>(`/album/${card.id}`, {
      method: 'PATCH',
      headers: { 'If-Match': `"${card.v}"` },
      body: JSON.stringify({ shelf: to }),
    });
    if (!data.card) {
      toast('Карточку уже переложили в другой вкладке. Альбом обновлён', 'error');
      reload();
      return;
    }
    setCards((list) => list.map((c) => (c.id === data.card.id ? data.card : c)));
    const name = shelves.find((s) => s.id === to)?.name ?? 'Не разобрано';
    toast(`${card.offer?.title ?? 'Карточка'} → ${name}`, 'ok');
  }, [shelves, toast, reload]);

  const album = useMemo(() => ({ shelves, rules, moveTo, reload }), [shelves, rules, moveTo, reload]);

  /* Сколько у пользователя карточек каждого оффера — для «Слить 3 дубля». Считаем, только когда меняются cards */
  const dupes = useMemo(() => {
    const count: { [offerId: string]: number } = {};
    for (const c of cards) count[c.offerId] = (count[c.offerId] ?? 0) + 1;
    return count;
  }, [cards]);

  if (!me) {
    if (loading) return <p className="muted">Загрузка…</p>;
    return (
      <section className="panel narrow">
        <h1>Альбом</h1>
        <p>Альбом есть только у своих.</p>
        <Link to="/login" className="btn btn-primary">Войти</Link>
      </section>
    );
  }

  const text = filter.trim().toLowerCase();
  const visible = cards.filter((c) => {
    if (shelf === 'none' ? c.shelf : shelf !== 'all' && c.shelf !== shelf) return false;
    return !text || (c.offer?.title.toLowerCase().includes(text) ?? false);
  });

  return (
    <AlbumContext.Provider value={album}>
      <div className="stack">
        <section className="panel">
          <h1>Альбом</h1>
          <p className="muted">Купленные офферы: разложи по полкам, прокачай уровень или слей три дубля. У каждой карточки свой таймер «ответь HR».</p>
          <div className="album-tools">
            <label className="field">
              <span>Найти в Альбоме</span>
              <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Например, «лид»" />
            </label>
            <div className="row" role="group" aria-label="Полка">
              {[{ id: 'all', emoji: '📚', name: 'Все' }, ...shelves, { id: 'none', emoji: '📦', name: 'Не разобрано' }].map((s) => (
                <button key={s.id} type="button" className="btn btn-small" aria-pressed={shelf === s.id} onClick={() => setShelf(s.id)}>
                  {s.emoji} {s.name}
                </button>
              ))}
            </div>
          </div>
          <p className="muted small">{ready ? `Показано ${visible.length} из ${cards.length}` : 'Загрузка…'}</p>
        </section>
        {ready && !cards.length && (
          <p className="note">Альбом пуст. Купи первый оффер — и он появится здесь.</p>
        )}
        <div className="cards">
          {visible.map((c) => (
            <AlbumCard key={c.id} card={c} canMerge={rules !== null && (dupes[c.offerId] ?? 0) >= rules.mergeCount} />
          ))}
        </div>
      </div>
    </AlbumContext.Provider>
  );
}
