import { http, HttpError } from './http';
import type { CompaniesBatch, Company } from '../types';

/* Т8: компании для карточек одним запросом. Карточка просит свою компанию, а в сеть уходит батч:
   просьбы копятся до конца текущей задачи — все карточки списка монтируются в одном коммите, —
   потом один GET /companies?ids=a,b,c. Пока батч не вернулся, тот же id получает тот же промис:
   батч общий и не отменяется, даже если карточка ушла, — его ответ ещё пригодится. */

type Waiter = { resolve: (c: Company) => void; reject: (e: unknown) => void };

const MAX_IDS = 100;   // столько сервер принимает за раз
const waiting = new Map<string, Promise<Company>>();   // id → промис, пока батч не ответил
let queue = new Map<string, Waiter>();                 // id → кого разбудить, пока батч не ушёл

async function flush() {
  const batch = queue;
  queue = new Map();
  const ids = [...batch.keys()];
  for (let i = 0; i < ids.length; i += MAX_IDS) {
    const part = ids.slice(i, i + MAX_IDS);
    try {
      const { items } = await http<CompaniesBatch>(`/companies?ids=${part.join(',')}`);
      const byId = new Map(items.map((c) => [c.id, c]));
      for (const id of part) {
        const c = byId.get(id);
        if (c) batch.get(id)?.resolve(c);
        else batch.get(id)?.reject(new HttpError(404, 'NOT_FOUND', 'Компания закрылась'));
      }
    } catch (e) {
      part.forEach((id) => batch.get(id)?.reject(e));
    }
  }
}

export function loadCompany(id: string): Promise<Company> {
  const known = waiting.get(id);
  if (known) return known;
  if (!queue.size) queueMicrotask(flush);   // первая просьба в этой задаче — батч уйдёт после всех остальных
  const promise = new Promise<Company>((resolve, reject) => queue.set(id, { resolve, reject }));
  const forget = () => waiting.delete(id);
  promise.then(forget, forget);
  waiting.set(id, promise);
  return promise;
}
