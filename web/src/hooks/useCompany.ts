import { useCached } from './useQuery';
import { loadCompany } from '../api/companies';
import type { Company } from '../types';

/* Компания по id: из кэша, а нет — через батч (Т8). Ключ — тот же адрес, что у одиночного запроса.
   Компании почти не меняются, поэтому живут в кэше 5 минут */
const COMPANY_TTL = 5 * 60_000;
const load = (key: string) => loadCompany(key.slice('/companies/'.length));

export function useCompany(id: string | null | undefined): Company | null {
  return useCached<Company>(id ? `/companies/${id}` : null, load, COMPANY_TTL).data;
}
