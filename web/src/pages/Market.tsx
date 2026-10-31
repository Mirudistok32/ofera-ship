import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '../hooks/useQuery';
import { isHttpError } from '../api/http';
import { navigate, useLocation } from '../router';
import { OfferCard } from '../components/OfferCard';
import { RARITIES } from '../rarity';
import type { OffersPage } from '../types';

const GRADES = ['Junior', 'Junior+', 'Middle', 'Middle+', 'Senior', 'Lead'];
const SORTS = [
  { id: 'new', name: 'сначала новые' },
  { id: 'price', name: 'дешевле' },
  { id: '-price', name: 'дороже' },
  { id: '-salary', name: 'вилка выше' },
];
const DEBOUNCE_MS = 400;   // пауза в наборе, после которой уходит поиск: на каждую букву — 429 «Остынь»

type Filters = { q: string; rarity: string; grade: string; sort: string; noFlags: boolean };

/* Т4: фильтры живут в адресе (?q=&rarity=) — ссылкой можно поделиться, «Назад» их возвращает */
function readFilters(search: URLSearchParams): Filters {
  return {
    q: search.get('q') ?? '',
    rarity: search.get('rarity') ?? '',
    grade: search.get('grade') ?? '',
    sort: search.get('sort') ?? 'new',
    noFlags: search.get('noFlags') === '1',
  };
}

/* Строка запроса по фильтрам: пустые поля не отправляем. Одна и та же — для адреса страницы и для /offers */
function toSearch(f: Filters): string {
  const params = new URLSearchParams();
  if (f.q) params.set('q', f.q);
  if (f.rarity) params.set('rarity', f.rarity);
  if (f.grade) params.set('grade', f.grade);
  if (f.sort !== 'new') params.set('sort', f.sort);
  if (f.noFlags) params.set('noFlags', '1');
  return params.size ? `?${params}` : '';
}

const errorText = (e: unknown) => (isHttpError(e) ? e.message : 'Что-то пошло не так');

/* Барахолка: фильтры, список карточек, лента по курсору */
export function Market() {
  const { search } = useLocation();
  const query = search.toString();
  const filters = readFilters(search);
  const setFilters = (next: Filters, replace = false) => navigate(`/market${toSearch(next)}`, { replace });

  // Поле поиска — своё состояние: буквы видны сразу, а в адрес (и в сеть) текст уходит после паузы
  const [text, setText] = useState(filters.q);
  const [seenQ, setSeenQ] = useState(filters.q);
  if (filters.q !== seenQ) {   // адрес сменился снаружи («Назад», «Сбросить») — поле догоняет его
    setSeenQ(filters.q);
    if (filters.q !== text.trim()) setText(filters.q);
  }

  useEffect(() => {
    const current = readFilters(new URLSearchParams(query));
    if (text.trim() === current.q) return;
    // replace: набор текста не плодит записей в истории
    const timer = setTimeout(() => navigate(`/market${toSearch({ ...current, q: text.trim() })}`, { replace: true }), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, query]);

  const path = `/offers${toSearch(filters)}`;
  const first = useQuery<OffersPage>(path);

  return (
    <div className="stack">
      <section className="panel">
        <h1>Барахолка</h1>
        <p className="muted">10 000 офферов на любой вкус. Вилка «до» — честная, «от» — после покупки.</p>
        <form className="filters" role="search" onSubmit={(e) => e.preventDefault()}>
          <label className="field filters-q">
            <span>Поиск</span>
            <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="React, печеньки, Казань…" />
          </label>
          <label className="field">
            <span>Редкость</span>
            <select value={filters.rarity} onChange={(e) => setFilters({ ...filters, rarity: e.target.value })}>
              <option value="">любая</option>
              {RARITIES.map((r) => <option key={r.id} value={r.id}>{r.emoji} {r.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Грейд</span>
            <select value={filters.grade} onChange={(e) => setFilters({ ...filters, grade: e.target.value })}>
              <option value="">любой</option>
              {GRADES.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Порядок</span>
            <select value={filters.sort} onChange={(e) => setFilters({ ...filters, sort: e.target.value })}>
              {SORTS.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={filters.noFlags} onChange={(e) => setFilters({ ...filters, noFlags: e.target.checked })} />
            <span>без красных флагов</span>
          </label>
        </form>
        <p className="muted small" aria-live="polite">
          {first.status === 'loading' ? 'Ищем…' : first.data ? `Найдено: ${first.data.total}${first.fetching ? ' · обновляем…' : ''}` : ''}
        </p>
      </section>

      {first.status === 'error' && (
        <section className="panel empty">
          <p>😵 {errorText(first.error)}</p>
          <button type="button" className="btn btn-small" onClick={first.reload}>Ещё раз</button>
        </section>
      )}

      {first.data && first.data.items.length === 0 && (
        <section className="panel empty">
          <p>🫥 {first.data.hint ?? 'Ничего не нашлось.'}</p>
          <button type="button" className="btn btn-small" onClick={() => navigate('/market')}>Сбросить фильтры</button>
        </section>
      )}

      {/* key: фильтры сменились — лента начинается заново, загруженные «ещё» страницы сбрасываются */}
      <Feed key={path} path={path} />
    </div>
  );
}

/* Т5: лента по курсору. Каждая страница — своя запись в кэше: /offers?…&cursor=…
   Курсор указывает на последний показанный оффер, поэтому страницы не пересекаются — в отличие от ?page=, где новый оффер сдвигает всё на один */
function Feed({ path }: { path: string }) {
  const [cursors, setCursors] = useState<string[]>([]);
  // Двойной клик и наблюдатель могут попросить ту же страницу дважды — второй раз её не добавляем
  const more = useCallback((cursor: string) => setCursors((cs) => (cs.includes(cursor) ? cs : [...cs, cursor])), []);
  const pages = [path, ...cursors.map((c) => `${path}${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(c)}`)];
  return (
    <>
      {pages.map((p, i) => <FeedPage key={p} path={p} last={i === pages.length - 1} onMore={more} />)}
    </>
  );
}

function FeedPage({ path, last, onMore }: { path: string; last: boolean; onMore: (cursor: string) => void }) {
  const { data, status, error, reload } = useQuery<OffersPage>(path);
  const next = last ? data?.nextCursor ?? null : null;

  // Последняя страница доскроллена до низа — подгружаем следующую сами. Ref-колбэк с cleanup — React 19
  const sentinel = useCallback((node: HTMLElement | null) => {
    if (!node || !next) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && onMore(next), { rootMargin: '400px' });
    io.observe(node);
    return () => io.disconnect();
  }, [next, onMore]);

  return (
    <>
      {data && data.items.length > 0 && (
        <div className="cards">
          {data.items.map((o) => <OfferCard key={o.id} offer={o} />)}
        </div>
      )}
      {status === 'loading' && path.includes('cursor=') && <p className="center muted small">Загружаем ещё…</p>}
      {status === 'error' && path.includes('cursor=') && (
        <p className="center small">
          {errorText(error)} <button type="button" className="btn btn-small" onClick={reload}>Ещё раз</button>
        </p>
      )}
      {next && (
        <p className="center" ref={sentinel}>
          <button type="button" className="btn" onClick={() => onMore(next)}>Загрузить ещё</button>
        </p>
      )}
    </>
  );
}
