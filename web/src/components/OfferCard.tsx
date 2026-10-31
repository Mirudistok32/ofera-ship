import { Link } from '../router';
import { rarityName, RARITIES } from '../rarity';
import { RenderCount } from './RenderCount';
import { useCompany } from '../hooks/useCompany';
import type { Offer } from '../types';

const money = (n: number) => n.toLocaleString('ru-RU');

/* Карточка оффера для списков: Барахолка, «Ещё такие же» на странице оффера.
   Т8: компания — из кэша или общим батчем /companies?ids=, а не своим запросом на каждую карточку */
export function OfferCard({ offer }: { offer: Offer }) {
  const company = useCompany(offer.companyId);

  const rarity = RARITIES.find((r) => r.id === offer.rarity);

  return (
    <article className={`card offer-card rarity-${offer.rarity}`}>
      <RenderCount name="OfferCard" />
      <span className="badge badge-rarity">{rarity?.emoji} {rarityName(offer.rarity)}</span>
      <Link to={`/offers/${offer.id}`} className="offer-title">{offer.title}</Link>
      <span className="muted small">{company ? `${company.emoji} ${company.name}` : '…'}</span>
      <span className="small">{offer.grade} · {offer.city}</span>
      <span className="small">до {money(offer.salaryTo)} ₽*</span>
      <div className="row offer-foot">
        <b>{offer.price} 🍪</b>
        {offer.flags.length > 0 && <span className="badge" title="Красные флаги">🚩 {offer.flags.length}</span>}
      </div>
    </article>
  );
}
