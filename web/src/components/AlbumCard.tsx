import { memo, useSyncExternalStore } from 'react';
import { Link } from '../router';
import { rarityName, RARITIES } from '../rarity';
import { useAlbum } from '../pages/Album';
import { RenderCount } from './RenderCount';
import { Upgrade } from './Upgrade';
import type { AlbumItem } from '../types';

/* Сколько минут осталось до конца круга «ответь HR». Круг прошёл — начинается следующий */
function minutesLeft(card: AlbumItem, now: number): number {
  const period = card.hrEverySec * 1000;
  let end = Date.parse(card.hrDeadline);
  while (end <= now) end += period;
  return Math.ceil((end - now) / 60_000);
}

/* Т22: одни часы на весь Альбом. Пока есть подписчики, тикает один setInterval, а не по одному на карточку.
   Последний отписался — часы остановлены */
const listeners = new Set<() => void>();
let clock = 0;

function subscribeClock(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) clock = window.setInterval(() => listeners.forEach((l) => l()), 1000);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) clearInterval(clock);
  };
}

/* Т22: таймер — отдельный маленький компонент. Снимок — число минут: React перерисует только эту строку
   и только когда число поменялось, а не всю карточку с полкой и прокачкой */
function HrTimer({ card }: { card: AlbumItem }) {
  const minutes = useSyncExternalStore(subscribeClock, () => minutesLeft(card, Date.now()));
  return <span className={minutes <= 5 ? 'hr-timer hot' : 'hr-timer'}>⏳ Ответь HR: {minutes} мин</span>;
}

type AlbumCardProps = { card: AlbumItem; canMerge: boolean };

/* Карточка Альбома: полка, уровень, таймер «ответь HR» и прокачка.
   Т21: memo — карточка перерисуется, только если сменилась она сама, canMerge или значение контекста */
export const AlbumCard = memo(function AlbumCard({ card, canMerge }: AlbumCardProps) {
  const { shelves, rules, moveTo, reload } = useAlbum();

  const offer = card.offer;
  if (!offer) return null;
  const rarity = RARITIES.find((r) => r.id === offer.rarity);

  return (
    <article className={`card album-card rarity-${offer.rarity}`}>
      <RenderCount name="AlbumCard" />
      <div className="row">
        <span className="badge badge-rarity">{rarity?.emoji} {rarityName(offer.rarity)}</span>
        <span className="badge">{rules?.levels[card.level] ?? card.level}</span>
      </div>
      <Link to={`/offers/${offer.id}`} className="offer-title">{offer.title}</Link>
      <span className="small">{offer.grade} · {offer.city}</span>
      <HrTimer card={card} />
      <label className="field">
        <span>Полка</span>
        <select value={card.shelf ?? ''} onChange={(e) => moveTo(card, e.target.value || null)}>
          <option value="">Не разобрано</option>
          {shelves.map((s) => (
            <option key={s.id} value={s.id}>{s.emoji} {s.name}</option>
          ))}
        </select>
      </label>
      {rules && !card.lotId && <Upgrade card={card} rules={rules} canMerge={canMerge} onDone={reload} />}
      {card.lotId && <span className="badge">🔨 на аукционе</span>}
    </article>
  );
});
