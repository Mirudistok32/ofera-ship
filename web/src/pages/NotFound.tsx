import { Link } from '../router';

export function NotFound() {
  return (
    <section className="panel">
      <h1>404</h1>
      <p>Вакансия закрыта, но объявление провисит ещё год.</p>
      <p><Link to="/">На главную</Link></p>
    </section>
  );
}
