import { useActionState, useEffect, useState } from 'react';
import { login } from '../api/auth';
import { isHttpError } from '../api/http';
import { navigate, useLocation } from '../router';

const USERS = ['junior', 'rich', 'hr'];

/* Итог последней попытки входа: текст над кнопкой, ошибки под полями и до какого момента ждать после 429 */
type LoginState = { error: string; fields: { [field: string]: string }; waitUntil: number };

const FRESH: LoginState = { error: '', fields: {}, waitUntil: 0 };

/* Вернуться можно только на свой адрес: ?next=//evil.example увёл бы на чужой сайт (open redirect) */
function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/login') ? next : '/';
}

/* Вход через useActionState: pending — пока идёт запрос, state — разбор ответа.
   422 VALIDATION и BAD_CREDENTIALS несут fields — показываем под полями; 429 — ждать Retry-After секунд */
export function Login() {
  const { search } = useLocation();
  const next = safeNext(search.get('next'));
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [now, setNow] = useState(Date.now());

  const [state, submit, pending] = useActionState(async (_prev: LoginState, form: FormData): Promise<LoginState> => {
    try {
      await login(String(form.get('login') ?? ''), String(form.get('password') ?? ''));
      navigate(next, { replace: true });   // replace: «Назад» не вернёт на форму входа
      return FRESH;
    } catch (e: unknown) {
      if (!isHttpError(e)) return { ...FRESH, error: 'Не получилось войти' };
      if (e.status === 429) {
        setNow(Date.now());
        return { ...FRESH, error: 'Слишком много попыток. Остынь', waitUntil: Date.now() + (e.retryAfter ?? 60) * 1000 };
      }
      if (e.code === 'BAD_CREDENTIALS') {
        const left = e.body?.error.attemptsLeft;
        return { ...FRESH, error: `Неверный логин или пароль${left !== undefined ? ` · попыток до паузы: ${left}` : ''}`, fields: e.fields };
      }
      return { ...FRESH, error: e.status === 422 ? '' : e.message, fields: e.fields };
    }
  }, FRESH);

  const wait = Math.max(0, Math.ceil((state.waitUntil - now) / 1000));

  /* Обратный отсчёт до конца паузы: часы тикают, только пока ждём */
  useEffect(() => {
    if (state.waitUntil <= Date.now()) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= state.waitUntil) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [state.waitUntil]);

  const fill = (user: string) => {
    setName(user);
    setPassword(user);
  };

  return (
    <section className="panel narrow">
      <h1>Вход</h1>
      <form className="stack" action={submit}>
        <label className="field">
          <span>Логин</span>
          <input name="login" value={name} onChange={(e) => setName(e.target.value)} autoComplete="username" aria-invalid={Boolean(state.fields.login)} />
          {state.fields.login && <small className="field-error">{state.fields.login}</small>}
        </label>
        <label className="field">
          <span>Пароль</span>
          <input name="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" aria-invalid={Boolean(state.fields.password)} />
          {state.fields.password && <small className="field-error">{state.fields.password}</small>}
        </label>
        {state.error && <p className="note note-error" role="alert">{state.error}</p>}
        <button type="submit" className="btn btn-primary" disabled={pending || wait > 0}>
          {pending ? 'Входим…' : wait > 0 ? `Подожди ${wait} с` : 'Войти'}
        </button>
      </form>
      <p className="muted small">
        Учётки:{' '}
        {USERS.map((u) => (
          <button key={u} type="button" className="link-btn" onClick={() => fill(u)}>{u}/{u}</button>
        ))}
      </p>
    </section>
  );
}
