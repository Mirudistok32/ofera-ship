import { useEffect, useState } from 'react';
import { Modal } from '../components/Modal';
import { expireTokens, getChaos, getChecks, getVerdict, setPreset, startCheck } from './devApi';
import type { ChaosSettings, ChaosState, CheckInfo, Verdict } from './devApi';
import { renderTotals, resetRenderTotals, setRenderCountOn, useRenderCountOn } from './renderCount';

/* Пульт сбоев: выдвижная панель справа. Наборы сбоев, «просрочить пропуски», проверка тикета и счётчик рендеров.
   Инструмент, а не часть задания: тикеты его не трогают */

const describe = (s: ChaosSettings) =>
  [
    `задержка ${s.delayMs}${s.jitterMs ? `–${s.delayMs + s.jitterMs}` : ''} мс`,
    `500: ${s.fail500}%`,
    `503: ${s.fail503}%`,
    `429: ${s.storm429}%`,
    `обрыв: ${s.netDrop}%`,
    `токен ${s.accessTtl} с`,
    s.noIndex ? 'база без индекса' : `пул ${s.poolSize}`,
    s.flaky ? `flaky ${s.flaky}` : '',
    s.priceJump ? 'цена прыгнет' : '',
  ].filter(Boolean).join(' · ');

export function ChaosPanel() {
  const [open, setOpen] = useState(false);
  const [chaos, setChaos] = useState<ChaosState | null>(null);
  const [checks, setChecks] = useState<CheckInfo[]>([]);
  const [ticket, setTicket] = useState(0);
  const [started, setStarted] = useState<CheckInfo | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [totals, setTotals] = useState(renderTotals);
  const renderCountOn = useRenderCountOn();

  /* Панель открыли — свежее состояние сервера: пульт могли покрутить из терминала */
  useEffect(() => {
    if (!open) return;
    let alive = true;
    Promise.all([getChaos(), getChecks()])
      .then(([state, list]) => {
        if (!alive) return;
        setChaos(state);
        setChecks(list.items);
        setTicket((n) => n || list.items[0]?.n || 0);
        setError('');
      })
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    setTotals(renderTotals());
    return () => {
      alive = false;
    };
  }, [open]);

  async function act(run: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await run();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const onPreset = (id: string) => act(async () => setChaos(await setPreset(id)));
  const onExpire = () => act(async () => setChaos(await expireTokens()));
  const onStart = () =>
    act(async () => {
      setStarted(await startCheck(ticket));
      setChaos(await getChaos());
    });
  const onVerdict = () => act(async () => setVerdict(await getVerdict(ticket)));
  const current = checks.find((c) => c.n === ticket);

  return (
    <>
      <button type="button" className="chaos-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        🎛️ Пульт{chaos?.preset && chaos.preset !== 'calm' ? ' ⚠️' : ''}
      </button>

      {open && (
        <aside className="chaos" aria-label="Пульт сбоев">
          <header className="chaos-head">
            <h2>🎛️ Пульт сбоев</h2>
            <button type="button" className="icon-btn" onClick={() => setOpen(false)} aria-label="Закрыть пульт">✕</button>
          </header>

          {error && <p className="note note-error" role="alert">{error}</p>}

          <section>
            <h3>Набор</h3>
            <div className="presets">
              {chaos?.presets.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`preset${chaos.preset === p.id ? ' preset-on' : ''}`}
                  onClick={() => onPreset(p.id)}
                  disabled={busy}
                  aria-pressed={chaos.preset === p.id}
                >
                  <b>{p.name}</b>
                  <small>{p.about}</small>
                </button>
              ))}
            </div>
            {chaos && (
              <p className="muted small">
                {chaos.preset ? '' : 'Свои ручки: '}
                {describe(chaos.settings)}
              </p>
            )}
            <button type="button" className="btn" onClick={onExpire} disabled={busy}>
              ⌛ Сделать токен просроченным
            </button>
          </section>

          <section>
            <h3>Проверка тикета</h3>
            <label className="field">
              <span>Тикет</span>
              <select value={ticket} onChange={(e) => setTicket(Number(e.target.value))}>
                {checks.map((c) => (
                  <option key={c.n} value={c.n}>Т{c.n}. {c.title}</option>
                ))}
              </select>
            </label>
            {current && <p className="muted small">{current.steps}</p>}
            <div className="row">
              <button type="button" className="btn btn-primary" onClick={onStart} disabled={busy || !ticket}>▶️ Начать</button>
              <button type="button" className="btn" onClick={onVerdict} disabled={busy || !ticket}>✅ Проверить тикет</button>
            </div>
            {started && <p className="note small">Т{started.n} начат: набор включён, пройди сценарий и жми «Проверить тикет».</p>}
          </section>

          <section>
            <h3>Инструменты</h3>
            <label className="check">
              <input type="checkbox" checked={renderCountOn} onChange={(e) => setRenderCountOn(e.target.checked)} />
              Счётчик рендеров <code>&lt;RenderCount&gt;</code>
            </label>
            {Object.keys(totals).length > 0 && (
              <ul className="totals small">
                {Object.entries(totals).map(([name, n]) => (
                  <li key={name}><code>{name}</code>: {n}</li>
                ))}
              </ul>
            )}
            <div className="row">
              <button type="button" className="btn btn-small" onClick={() => setTotals(renderTotals())}>Обновить итоги</button>
              <button type="button" className="btn btn-small" onClick={() => { resetRenderTotals(); setTotals({}); }}>Сбросить</button>
            </div>
          </section>
        </aside>
      )}

      <Modal open={verdict !== null} title={verdict ? `Т${verdict.n}: ${verdict.ok ? '✅ готово' : '❌ ещё нет'}` : ''} onClose={() => setVerdict(null)}>
        {verdict && (
          <>
            <ul className="verdict">
              {verdict.items.map((item, i) => (
                <li key={i} className={item.ok ? 'ok' : 'bad'}>{item.ok ? '✅' : '❌'} {item.text}</li>
              ))}
            </ul>
            <p className="muted small">Запросов с начала проверки: {verdict.requests}</p>
          </>
        )}
      </Modal>
    </>
  );
}
