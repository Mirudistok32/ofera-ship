import { Link } from '../router';
import { RARITIES } from '../rarity';
import { useMe } from '../hooks/useMe';

/* Первая страница: сюжет, Т0 и витрина редкостей. Разделы появляются по мере тикетов */
export function Home() {
  const { me } = useMe();
  return (
    <div className="stack">
      <section className="panel hero">
        <h1>Офферомания</h1>
        <p>
          Тебя взяли фронтендером на барахолку офферов. Прошлый ушёл в «Галеру №7» и оставил код — местами рабочий.
          Продакт уже пишет тикеты: «сделай» и 🐞 «почини».
        </p>
        {me ? (
          <p className="note">Вход есть: {me.name}, 🍪 {me.cookies}, 🏆 {me.trophies}.</p>
        ) : (
          <p><Link to="/login" className="btn btn-primary">Войти</Link></p>
        )}
      </section>

      <section className="panel">
        <h2>Т0. Запуск</h2>
        <ol className="steps">
          <li><code>cd net-lab && npm run quest</code> — бэкенд :4010 и каркас :5190.</li>
          <li>Открыть <code>http://localhost:5190</code> — именно localhost, не 127.0.0.1.</li>
          <li>Войти: <code>junior/junior</code>, <code>rich/rich</code> (премиум) или <code>hr/hr</code>.</li>
          <li>Кнопка «🎛️ Пульт» внизу справа: наборы сбоев, «Начать» и «Проверить тикет».</li>
        </ol>
      </section>

      <section className="panel">
        <h2>Редкость офферов</h2>
        <div className="rarities">
          {RARITIES.map((r) => (
            <div key={r.id} className={`card rarity-${r.id}`}>
              <span className="badge badge-rarity">{r.emoji} {r.name}</span>
              <b>Frontend (Junior)</b>
              <span className="muted small">до 500 000 ₽*</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
