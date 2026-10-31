import { API } from '../config';

/* Запросы пульта к служебным адресам /__chaos и /__check. Свой fetch, а не http.ts: пульт должен работать,
   пока http.ts переписывается по тикетам, а /__* сбои пульта не задевают и в журнал проверок не попадают */

export type Preset = { id: string; name: string; about: string };
export type ChaosSettings = {
  delayMs: number; jitterMs: number; fail500: number; fail503: number; storm429: number; netDrop: number;
  flaky: number; priceJump: boolean; accessTtl: number; noIndex: boolean; poolSize: number;
};
export type ChaosState = { settings: ChaosSettings; preset: string | null; presets: Preset[]; tokenGen: number };
export type CheckInfo = { n: number; title: string; preset: string; steps: string; expire: boolean };
export type Verdict = { n: number; title: string; ok: boolean; items: { ok: boolean; text: string }[]; requests: number };

async function dev<T>(path: string, method = 'GET'): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API + path, { method });
  } catch {
    throw new Error('Сервер :4010 не отвечает — запусти npm run quest');
  }
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
  return body;
}

export const getChaos = () => dev<ChaosState>('/__chaos');
export const setPreset = (id: string) => dev<ChaosState>(`/__chaos/preset/${id}`, 'POST');
export const expireTokens = () => dev<ChaosState>('/__chaos/expire-tokens', 'POST');
export const getChecks = () => dev<{ items: CheckInfo[] }>('/__check');
export const startCheck = (n: number) => dev<CheckInfo>(`/__check/${n}/start`, 'POST');
export const getVerdict = (n: number) => dev<Verdict>(`/__check/${n}`);
