import { memo, useDeferredValue, useEffect, useState, useTransition } from 'react';
import { useRegistry } from '../hooks/useRegistry';
import { RARITIES } from '../rarity';
import { RenderCount } from '../components/RenderCount';
import type { Offer } from '../types';

const SAMPLE = 2000;   // столько офферов берёт срез: страницами по 50, как в Реестре
const PAUSE = 120;    // сервер пускает 10 запросов в секунду: с паузой загрузка не упирается в 429
const money = (n: number) => n.toLocaleString('ru-RU');
const hitOf = (o: Offer, q: string) => `${o.title} ${o.grade} ${o.city} ${o.stack.join(' ')}`.toLowerCase().includes(q);

type Axis = { keys: (o: Offer) => string[] };
type Slice = { id: string; name: string; y: Axis; x: Axis };
const STACK: Axis = { keys: (o) => o.stack };
const CITY: Axis = { keys: (o) => [o.city] };
const GRADE: Axis = { keys: (o) => [o.grade] };
const RARITY: Axis = { keys: (o) => [RARITIES.find((r) => r.id === o.rarity)?.name ?? o.rarity] };
const SLICES: Slice[] = [
  { id: 'stack-city', name: 'Стек и город', y: STACK, x: CITY },
  { id: 'stack-grade', name: 'Стек и грейд', y: STACK, x: GRADE },
  { id: 'stack-rarity', name: 'Стек и редкость', y: STACK, x: RARITY },
];
const valuesOf = (rows: Offer[], axis: Axis) => [...new Set(rows.flatMap(axis.keys))].sort();

/* Т26: ввод и клик срочные, таблица — нет. Поиск отстаёт через useDeferredValue, срез меняется в переходе:
   фоновый рендер идёт кусками и прерывается новой буквой. Считать быстрее не стало — страница просто не мёрзнет */
export function Analytics() {
  const { rows, total, error, end, more } = useRegistry();
  const [query, setQuery] = useState('');
  const [sliceId, setSliceId] = useState(SLICES[0].id);
  const deferredQuery = useDeferredValue(query);
  const [isPending, startTransition] = useTransition();
  const stale = query !== deferredQuery || isPending;
  const slice = SLICES.find((s) => s.id === sliceId) ?? SLICES[0];
  const ready = end || rows.length >= SAMPLE;

  useEffect(() => {
    if (end || error || rows.length >= SAMPLE) return;
    const id = setTimeout(() => void more(), PAUSE);
    return () => clearTimeout(id);
  }, [rows.length, end, error, more]);

  return (
    <section className="stack">
      <h1>📊 Аналитика рынка</h1>
      <p className="muted">Что платят за стек: срез из {money(SAMPLE)} новых офферов. Загружено {money(rows.length)} из {total == null ? '…' : money(total)}</p>
      <LongestTask />
      <label className="field reg-mark">
        <span>Что ищем</span>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="React, Сочи, Lead…" />
      </label>
      <div className="row an-slices" role="group" aria-label="Срез">
        {SLICES.map((s) => (
          <button key={s.id} type="button" className="btn btn-small" aria-pressed={s.id === slice.id} onClick={() => startTransition(() => setSliceId(s.id))}>{s.name}</button>
        ))}
      </div>
      <p className="muted small" role="status">{stale ? 'Считаем…' : ready ? 'Посчитано' : ''}</p>
      {error && <p className="center small">{error} <button type="button" className="btn btn-small" onClick={() => void more()}>Ещё раз</button></p>}
      <p className="muted small" id="an-note">В ячейке — медиана вилки «до» в тысячах ₽, в скобках — сколько офферов</p>
      {ready ? (
        <div className={`an-box${stale ? ' an-stale' : ''}`} role="region" aria-label="Таблица среза" tabIndex={0}>
          <AnalyticsTable rows={rows} slice={slice} query={deferredQuery} />
        </div>
      ) : !error && <p className="center muted small">Собираем срез…</p>}
    </section>
  );
}

/* memo обязателен: пока идёт срочный рендер, deferredQuery старый, пропсы те же — таблица пропускается.
   Без memo она считалась бы и в срочном рендере, и весь выигрыш пропал бы */
const AnalyticsTable = memo(function AnalyticsTable({ rows, slice, query }: { rows: Offer[]; slice: Slice; query: string }) {
  const q = query.trim().toLowerCase();
  const xs = valuesOf(rows, slice.x);
  return (
    <table className="an-table" aria-describedby="an-note">
      <thead>
        <tr><th scope="col">{slice.name} <RenderCount name="AnalyticsTable" /></th>{xs.map((x) => <th key={x} scope="col">{x}</th>)}</tr>
      </thead>
      <tbody>
        {valuesOf(rows, slice.y).map((y) => (
          <tr key={y}>
            <th scope="row">{y}</th>
            {xs.map((x) => <Cell key={x} rows={rows} slice={slice} y={y} x={x} query={q} />)}
          </tr>
        ))}
      </tbody>
    </table>
  );
});

/* Ячейка считает сама: перебирает весь срез, берёт медиану. Работа размазана по компонентам — между ними React может прерваться */
function Cell({ rows, slice, y, x, query }: { rows: Offer[]; slice: Slice; y: string; x: string; query: string }) {
  const pay = rows
    .filter((o) => (query === '' || hitOf(o, query)) && slice.y.keys(o).includes(y) && slice.x.keys(o).includes(x))
    .map((o) => o.salaryTo)
    .sort((a, b) => a - b);
  if (pay.length === 0) return <td className="muted">—</td>;
  return <td>{money(Math.round(pay[pay.length >> 1] / 1000))} <small>({pay.length})</small></td>;
}

/* Самая долгая задача главного потока с последнего «Сбросить» — чтобы видеть результат Т26 без DevTools */
export function LongestTask() {
  const [ms, setMs] = useState(0);
  const supported = PerformanceObserver.supportedEntryTypes.includes('longtask');

  useEffect(() => {
    if (!supported) return;
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) setMs((m) => Math.max(m, Math.round(e.duration)));
    });
    po.observe({ type: 'longtask' });
    return () => po.disconnect();
  }, [supported]);

  if (!supported) return <p className="muted small">Счётчик задач есть только в Chromium. В другом браузере смотри вкладку Performance.</p>;
  return (
    <p className="row small an-long">
      <span>Самая долгая задача: <b>{ms === 0 ? 'нет длиннее 50 мс' : `${money(ms)} мс`}</b></span>
      <button type="button" className="btn btn-small" onClick={() => setMs(0)}>Сбросить</button>
    </p>
  );
}
