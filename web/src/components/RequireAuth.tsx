import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { useMe } from '../hooks/useMe';
import { Link, navigate } from '../router';
import type { Role } from '../types';

/* Закрытая страница: гостя уводит на вход до первого запроса страницы и запоминает, куда вернуть (?next=).
   Страница с ролью не монтируется без неё — значит, и не шлёт запросов, на которые сервер ответит 403.
   Скрывать ссылку в шапке мало: адрес /hr можно набрать руками. Настоящая охрана всё равно на сервере */
type RequireAuthProps = { role?: Role; children: ReactNode };

export function RequireAuth({ role, children }: RequireAuthProps) {
  const { me, loading } = useMe();
  const guest = !loading && !me;

  useEffect(() => {
    if (guest) navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`, { replace: true });
  }, [guest]);

  if (!me) return <p className="muted">Загрузка…</p>;
  if (role && me.role !== role) {
    return (
      <section className="panel narrow">
        <h1>Только для HR</h1>
        <p>Соискателей просят подождать в переговорке.</p>
        <Link to="/" className="btn btn-primary">На главную</Link>
      </section>
    );
  }
  return <>{children}</>;
}
