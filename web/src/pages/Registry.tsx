import { memo, useCallback, useEffect, useState } from 'react';
import { useRegistry } from '../hooks/useRegistry';
import { Link } from '../router';
import { RARITIES } from '../rarity';
import { RenderCount } from '../components/RenderCount';
import type { Offer } from '../types';

const money = (n: number) => n.toLocaleString('ru-RU');
const ROW = 44;       // высота строки, px — та же, что --row в styles.css: индекс строки — деление
const OVERSCAN = 6;   // запас строк над окном и под ним: при быстрой прокрутке не мелькает пустота
const AHEAD = 100;    // до конца загруженного меньше двух страниц — просим следующую

const hitOf = (o: Offer, q: string) => `${o.title} ${o.grade} ${o.city} ${o.stack.join(' ')}`.toLowerCase().includes(q);

/* Т24: свой виртуальный список. Прокручивается коробка .reg-box, внутри — подложка высотой во все строки,
   а рисуются только строки окна [from, to): сверху их сдвигает padding-top, снизу место держит height */
export function Registry() {
  const { rows, total, error, end, more } = useRegistry();
  const [mark, setMark] = useState('');
  // Окно — в строках, а не в пикселях: прокрутка внутри одной строки не перерисовывает реестр
  const [view, setView] = useState({ first: 0, count: 20 });

  const box = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const sync = () => {
      const first = Math.floor(node.scrollTop / ROW);
      const count = Math.ceil(node.clientHeight / ROW) + 1;
      setView((v) => (v.first === first && v.count === count ? v : { first, count }));
    };
    sync();
    const ro = new ResizeObserver(sync);   // повернули телефон, растянули окно — окно строк пересчитано
    ro.observe(node);
    node.addEventListener('scroll', sync, { passive: true });
    return () => {
      ro.disconnect();
      node.removeEventListener('scroll', sync);
    };
  }, []);

  const from = Math.max(0, view.first - OVERSCAN);
  const to = Math.min(rows.length, view.first + view.count + OVERSCAN);

  // Подгрузка — от окна, а не от наблюдателя за низом: низ подложки ничего не значит, она уже во все строки
  useEffect(() => {
    if (!end && !error && to > rows.length - AHEAD) void more();
  }, [to, rows.length, end, error, more]);

  const q = mark.trim().toLowerCase();

  return (
    <section className="stack">
      <h1>📜 Реестр офферов</h1>
      <p className="muted">Все офферы рынка подряд, сначала новые. Загружено {money(rows.length)} из {total == null ? '…' : money(total)} · <DomRows /></p>
      <label className="field reg-mark">
        <span>Подсветить</span>
        <input value={mark} onChange={(e) => setMark(e.target.value)} placeholder="React, Сочи, Lead…" />
      </label>
      <div>
        <RegHead />
        <div className="reg reg-box" ref={box} tabIndex={0} aria-label="Реестр офферов">
          <div className="reg-in" style={{ height: rows.length * ROW, paddingTop: from * ROW }}>
            {rows.slice(from, to).map((o, i) => <RegistryRow key={o.id} offer={o} index={from + i} hit={q !== '' && hitOf(o, q)} />)}
          </div>
        </div>
      </div>
      {error && <p className="center small">{error} <button type="button" className="btn btn-small" onClick={() => void more()}>Ещё раз</button></p>}
      {!end && !error && <p className="center muted small">Загружаем ещё…</p>}
    </section>
  );
}

export function RegHead() {
  return (
    <div className="reg-row reg-head" aria-hidden="true">
      <span>№</span><span>Оффер</span><span>Грейд · город</span><span className="reg-num">Вилка до</span><span className="reg-num">Цена</span>
    </div>
  );
}

/* memo и hit вместо mark: буква в «Подсветить» перерисовывает только строки, у которых подсветка сменилась */
export const RegistryRow = memo(function RegistryRow({ offer, index, hit }: { offer: Offer; index: number; hit: boolean }) {
  const rarity = RARITIES.find((r) => r.id === offer.rarity);
  return (
    <div className={`reg-row rarity-${offer.rarity}${hit ? ' reg-hit' : ''}`}>
      <span className="muted">{index + 1}</span>
      <span className="reg-title">
        <span title={rarity?.name}>{rarity?.emoji}</span> <Link to={`/offers/${offer.id}`}>{offer.title}</Link>
        <RenderCount name="RegistryRow" />
      </span>
      <span className="small">{offer.grade} · {offer.city}</span>
      <span className="reg-num small">{money(offer.salaryTo)} ₽</span>
      <span className="reg-num"><b>{offer.price}</b> 🍪</span>
    </div>
  );
});

/* Сколько строк реестра сейчас в DOM — чтобы видеть результат Т24 без DevTools */
export function DomRows() {
  const [n, setN] = useState(0);
  const tick = useCallback((node: HTMLElement | null) => {
    if (!node) return;
    const id = setInterval(() => setN(document.querySelectorAll('.reg .reg-row').length), 500);
    return () => clearInterval(id);
  }, []);
  return <span ref={tick}>строк в DOM: <b>{money(n)}</b></span>;
}
