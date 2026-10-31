import { useState } from 'react';
import { isHttpError } from '../api/http';
import { useQuery } from '../hooks/useQuery';
import { useCompany } from '../hooks/useCompany';
import { Link } from '../router';
import { rarityName, RARITIES } from '../rarity';
import { OfferCard } from '../components/OfferCard';
import { BuyModal } from '../components/BuyModal';
import { WishButton } from '../components/WishButton';
import { useMe } from '../hooks/useMe';
import type { Flag, OfferFull, OffersPage } from '../types';

const money = (n: number) => n.toLocaleString('ru-RU');
const LAST = 10_000;   // сид: офферы o00001 … o10000
const REFERENCE_TTL = 5 * 60_000;   // справочник флагов почти не меняется

/* Соседний оффер для кнопок «←» и «→»: o00042 → o00043. У офферов от HR (o-…) соседей нет */
function neighbour(id: string, step: number): string | null {
  const n = /^o\d{5}$/.test(id) ? Number(id.slice(1)) + step : 0;
  return n >= 1 && n <= LAST ? `o${String(n).padStart(5, '0')}` : null;
}

/* Страница оффера. Т6: всё грузится через useQuery — у каждого адреса своя запись в кэше.
   Быстро открыли A, потом B: страница читает только запись B, запрос A отменён, а пока B грузится, видно «Загрузка…», а не A */
export function OfferPage({ id }: { id: string }) {
  const { data: offer, status, error, reload } = useQuery<OfferFull>(`/offers/${id}`);
  const flags = useQuery<{ items: Flag[] }>('/flags', REFERENCE_TTL).data?.items ?? [];
  const company = useCompany(offer?.companyId);
  const more = useQuery<OffersPage>(offer ? `/offers?rarity=${offer.rarity}&limit=6` : null).data?.items ?? [];
  const [buying, setBuying] = useState(false);
  const { me } = useMe();

  const prev = neighbour(id, -1);
  const next = neighbour(id, 1);
  const pager = (
    <nav className="row pager" aria-label="Соседние офферы">
      {prev && <Link to={`/offers/${prev}`} className="btn btn-small">← {prev}</Link>}
      <span className="muted small">адрес: {id}</span>
      {next && <Link to={`/offers/${next}`} className="btn btn-small">{next} →</Link>}
    </nav>
  );

  if (!offer) {
    return (
      <div className="stack">
        {pager}
        {status === 'error' ? (
          <section className="panel empty">
            <p>🫥 {isHttpError(error) ? error.message : 'Не получилось загрузить оффер'}</p>
            <button type="button" className="btn btn-small" onClick={reload}>Ещё раз</button>
          </section>
        ) : <p className="muted">Загрузка…</p>}
      </div>
    );
  }

  const rarity = RARITIES.find((r) => r.id === offer.rarity);
  const flagText = (flagId: string) => flags.find((f) => f.id === flagId)?.text ?? flagId;

  return (
    <div className="stack">
      {pager}

      <section className={`panel offer-page rarity-${offer.rarity}`}>
        <span className="badge badge-rarity">{rarity?.emoji} {rarityName(offer.rarity)}</span>
        <h1>{offer.title}</h1>
        <p className="muted">
          {company ? `${company.emoji} ${company.name} — «${company.motto}»` : '…'} · {offer.grade} · {offer.city}
        </p>
        <p className="salary">
          Вилка: от {offer.salaryFrom === null ? '???' : money(offer.salaryFrom)} до {money(offer.salaryTo)} ₽*
        </p>
        {offer.salaryHidden && (
          <p className="muted small">* Низ вилки откроется после покупки, у мифических или со «Знакомым в HR».</p>
        )}
        <p>{offer.pitch}</p>
        {offer.perks.length > 0 && (
          <ul className="perks">
            {offer.perks.map((perk) => <li key={perk}>{perk}</li>)}
          </ul>
        )}
        <div className="row">
          {offer.flags.map((f) => <span key={f} className="badge badge-flag">🚩 {flagText(f)}</span>)}
        </div>
        <div className="row">
          {offer.stack.map((s) => <span key={s} className="badge">{s}</span>)}
        </div>
        <p className="price">{offer.price} 🍪</p>
        {me ? (
          <div className="row">
            <button type="button" className="btn btn-primary" onClick={() => setBuying(true)}>Купить</button>
            <WishButton key={offer.id} offerId={offer.id} inWishlist={Boolean(offer.inWishlist)} />
          </div>
        ) : (
          <p className="small"><Link to="/login">Войти</Link>, чтобы купить или отложить в вишлист.</p>
        )}
        {buying && <BuyModal offer={offer} open onClose={() => setBuying(false)} />}
      </section>

      {more.length > 0 && (
        <section className="stack">
          <h2>Ещё {rarityName(offer.rarity)}</h2>
          <div className="cards">
            {more.map((o) => <OfferCard key={o.id} offer={o} />)}
          </div>
        </section>
      )}
    </div>
  );
}
