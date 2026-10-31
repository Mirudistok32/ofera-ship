import { useEffect, useRef, useState } from 'react';
import { http } from '../api/http';
import { useMe } from '../hooks/useMe';
import { useToast } from './Toasts';
import type { AlbumItem, Job, UpgradeResponse, UpgradeRules } from '../types';

type UpgradeProps = { card: AlbumItem; rules: UpgradeRules; canMerge: boolean; onDone: () => void };

const POLL_MS = 1000;

/* Прокачка карточки: POST /upgrade отвечает 202 с задачей, дальше опрос /jobs/:id раз в секунду.
   Уровень — Junior → … → Архитектор презентаций за 🍪, или слияние трёх дублей в оффер редкостью выше */
export function Upgrade({ card, rules, canMerge, onDone }: UpgradeProps) {
  const { setMe, reload: reloadMe } = useMe();
  const toast = useToast();
  const [job, setJob] = useState<Job | null>(null);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);

  /* Т19: уровень берём из пропсов, а не копируем в state — после reload Альбома карточка приходит с новым уровнем */
  const level = card.level;
  const jobId = job?.id ?? null;
  const running = job !== null && (job.status === 'queued' || job.status === 'running');
  const top = level >= rules.levels.length - 1;

  /* Т19: второй клик, пока идёт POST, ничего не делает. Ref, а не только state: два клика подряд
     могут прийти до перерисовки с disabled. Idempotency-Key — на случай повтора того же запроса (Т3):
     сервер вернёт ту же задачу, а не спишет 🍪 второй раз */
  async function start(kind: 'level' | 'merge') {
    if (sendingRef.current || running) return;
    sendingRef.current = true;
    setSending(true);
    try {
      const data = await http<UpgradeResponse>('/upgrade', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ cardId: card.id, kind }),
      });
      setMe(data.user);
      setJob(data.job);
    } catch (e: unknown) {
      toast(`Не вышло: ${e instanceof Error ? e.message : 'HR не берёт трубку'}`, 'error');
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  /* Т19: опрос живёт, пока есть незаконченная задача. На done и failed — стоп и job = null,
     при уходе со страницы cleanup снимает таймер. setTimeout цепочкой: следующий запрос — только после ответа */
  useEffect(() => {
    if (!jobId) return;
    let stopped = false;
    let timer = 0;

    async function poll() {
      try {
        const { job: next } = await http<{ job: Job }>(`/jobs/${jobId}`);
        if (stopped) return;
        if (next.status === 'done') {
          setJob(null);
          toast(`⬆️ ${next.stage}`, 'ok');
          onDone();
          return;
        }
        if (next.status === 'failed') {
          setJob(null);
          toast(`😬 ${next.error?.message ?? next.stage}`, 'error');
          reloadMe();   // при неудаче 🍪 вернули — шапке нужен свежий баланс
          return;
        }
        setJob(next);
      } catch {
        if (stopped) return;   // сеть мигнула — спросим ещё раз через секунду
      }
      timer = window.setTimeout(poll, POLL_MS);
    }

    timer = window.setTimeout(poll, POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [jobId, toast, onDone, reloadMe]);

  return (
    <div className="upgrade">
      {running && job ? (
        <>
          <progress max={100} value={job.progress} aria-label="Прогресс прокачки" />
          <span className="muted small">{job.stage}</span>
        </>
      ) : (
        <div className="row">
          {!top && (
            <button type="button" className="btn btn-small" disabled={sending} onClick={() => start('level')} title={`До уровня ${rules.levels[level + 1]}`}>
              ⬆️ Прокачать · {rules.costs[level]} 🍪
            </button>
          )}
          {canMerge && (
            <button type="button" className="btn btn-small" disabled={sending} onClick={() => start('merge')}>
              🧬 Слить {rules.mergeCount} дубля
            </button>
          )}
        </div>
      )}
    </div>
  );
}
