/* Лёгкие типы ответов API: только то, что приходит с сервера :4010. Поля — как в quest/README.md */

export type Rarity = 'common' | 'rare' | 'epic' | 'legendary' | 'mythic';
export type Role = 'user' | 'hr';
export type Plan = 'free' | 'premium';

/* Даты — ISO-строки, serverTime — миллисекунды по часам сервера */
export type User = {
  id: string;
  login: string;
  name: string;
  role: Role;
  plan: Plan;
  premiumUntil: string | null;
  cookies: number;
  frozen: number;          // 🍪 в ставках аукциона, которые ещё не перебили
  trophies: number;        // 🏆 на счету: заработанные минус потраченные на премиум
  achievements: string[];
  boosts: { [boostId: string]: number };      // сколько зарядов осталось
  cooldowns: { [boostId: string]: string };   // когда снова можно включить
  effects: { [boostId: string]: string };     // до какого времени действует
};

export type LoginResponse = { accessToken: string; tokenType: 'Bearer'; expiresIn: number; user: User; serverTime: number };
export type MeResponse = { user: User; token: { role: Role; plan: Plan; exp: number }; serverTime: number };

/* Тело любой ошибки сервера. Поля после requestId — у отдельных кодов:
   price — 409 PRICE_CHANGED (новая цена оффера) и 409 OUTBID (новая цена лота), minBid, leader и endsAt — у ставок,
   attemptsLeft — 422 BAD_CREDENTIALS при входе */
export type ApiErrorBody = {
  error: {
    code: string; message: string; fields?: { [field: string]: string }; requestId: string;
    price?: number; minBid?: number; leader?: { id: string; name: string } | null; endsAt?: string; serverTime?: number;
    attemptsLeft?: number;
  };
};

export type Offer = {
  id: string;
  title: string;
  grade: string;
  companyId: string;
  rarity: Rarity;
  price: number;
  salaryTo: number;
  flags: string[];
  stack: string[];
  city: string;
  createdAt: string;
  v: number;
  inWishlist?: boolean;    // только с токеном
};

/* GET /offers/:id — оффер целиком; вилка «от» открыта после покупки, у мифических или со «Знакомым в HR» */
export type OfferFull = Offer & {
  salaryFrom: number | null;
  salaryHidden: boolean;
  perks: string[];
  pitch: string;
  serverTime: number;
};

export type OffersPage = { items: Offer[]; total: number; nextCursor: string | null; hint?: string };

export type Company = { id: string; name: string; emoji: string; motto: string; rating: number; size: string };
export type CompaniesBatch = { items: Company[]; missing: string[] };

export type Flag = { id: string; text: string; hint: string };

/* Усиление Лавки: заряды (qty), перезарядка и срок эффекта в секундах. Премиальные не продаются */
export type Boost = {
  id: string;
  emoji: string;
  name: string;
  premium: boolean;
  price: number;
  qty: number;
  cooldownSec: number;
  durationSec: number;
  effect: string;
  incompatible: string[];
};

export type BoostResponse = { boost: string; user: User; serverTime: number };

/* HR-панель: оффер целиком, с нижней границей вилки и автором */
export type HrOffer = Offer & { salaryFrom: number; perks: string[]; pitch: string; createdBy?: string };
export type HrOfferDraft = {
  title: string;
  grade: string;
  companyId: string;
  rarity: Rarity;
  price: number;
  salaryFrom: number;
  salaryTo: number;
  flags: string[];
  city: string;
  pitch: string;
};

/* Альбом: купленная карточка. hrDeadline — конец текущего круга таймера «ответь HR», круг — hrEverySec */
export type Shelf = { id: string; emoji: string; name: string };
export type AlbumItem = {
  id: string;
  offerId: string;
  shelf: string | null;
  level: number;
  v: number;
  hrEverySec: number;
  hrDeadline: string;
  acquiredAt: string;
  lotId?: string | null;   // карточка на аукционе — её не прокачать
  offer: Offer | null;
};
export type AlbumResponse = { items: AlbumItem[]; total: number; shelves: Shelf[]; serverTime: number };
export type ShelfResponse = { card: AlbumItem; achievements: string[]; serverTime: number };

/* Прокачка — долгая задача: 202 с job, дальше опрос GET /jobs/:id */
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';
export type Job = {
  id: string;
  kind: 'level' | 'merge';
  cardIds: string[];
  fromLevel: number;
  cost: number;
  chance: number;
  status: JobStatus;
  stage: string;
  progress: number;
  result: { card: AlbumItem; merged?: string[] } | null;
  error: { code: string; message: string } | null;
};
export type UpgradeResponse = { job: Job; user: User; serverTime: number };
export type UpgradeRules = { levels: string[]; costs: number[]; mergeCount: number; failRate: number; jobMs: number };

/* Бегущая строка: GET /ticker, дальше событие price из SSE /stream */
export type TickerResponse = { items: Offer[]; priceMs: number; serverTime: number };
export type PriceEvent = { offerId: string; price: number; was: number; by: 'bot' | 'hr'; serverTime: number };

/* Покупка и вишлист (13.4): POST /purchases, PUT и DELETE /wishlist/:offerId */
export type Purchase = { id: string; offerId: string; price: number; paid: number; boosts: string[]; createdAt: string };
export type PurchaseResponse = { purchase: Purchase; card: AlbumItem; user: User; achievements: string[]; serverTime: number };
export type WishResponse = { offerId: string; inWishlist: boolean; total: number };

/* Аукцион: лот с ценой, минимальной следующей ставкой и концом торгов по часам сервера */
export type Person = { id: string; name: string };
export type LotStatus = 'open' | 'sold' | 'unsold' | 'cancelled';
export type Lot = {
  id: string;
  offerId: string;
  seller: Person | null;
  leader: Person | null;
  startPrice: number;
  price: number;
  minBid: number;
  step: number;
  bids: number;
  extensions: number;
  startsAt: string;
  endsAt: string;
  status: LotStatus;
  offer: Offer | null;
};
export type Bid = { id: string; lotId: string; bidderId: string; bidderName: string; amount: number; extended: boolean; createdAt: string };
export type LotsResponse = { items: Lot[]; total: number; step: number; snipeSec: number; extendSec: number; serverTime: number };
export type BidResponse = { lot: Lot; bid: Bid; user: User; serverTime: number };

/* Премиум «Синдром отличника»: тариф в базе (plan) и в токене (tokenPlan) могут расходиться до refresh */
export type PremiumInfo = { plan: Plan; tokenPlan: Plan; forever: boolean; premiumUntil: string | null; cost: number; durationSec: number; trophies: number };
export type PremiumResponse = { user: User; premiumUntil: string; tokenPlan: Plan; refreshNeeded: boolean; serverTime: number };
export type Lounge = { title: string; items: Offer[]; serverTime: number };

/* События аукциона из SSE /stream (Т16): bid — новая ставка, lot-end — торги закончились */
export type BidEvent = {
  lotId: string; amount: number; price: number; minBid: number; leader: Person | null;
  outbid: string | null;   // id прошлого лидера: ему вернулись 🍪
  bids: number; endsAt: string; extended: boolean; serverTime: number;
};
export type LotEndEvent = { lotId: string; status: LotStatus; price: number; winner: Person | null; seller: Person | null; serverTime: number };
