import { Link } from '../router';

/* Текст договора: страница /family нужна редко, а весит он как настоящий мелкий шрифт */
const CLAUSES = [
  { title: 'Отпуск', text: 'Отпуск — это предательство. Заявление подаётся директору лично, желательно со слезами.' },
  { title: 'Переработки', text: 'Переработок нет. Есть вечера, которые семья проводит вместе.' },
  { title: 'Зарплата', text: 'Индексация — по случаю хорошего настроения. О деньгах за семейным столом не говорят.' },
  { title: 'Чат', text: 'Семейный чат читается в выходные, в отпуске и на собственной свадьбе.' },
  { title: 'Увольнение', text: 'Из семьи не увольняются. По собственному желанию можно только разочаровать.' },
];

/* Номер приходит из адреса, а пункта 99 юристы так и не написали. Типы этого не видят */
function Clause({ n }: { n: number }) {
  const item = CLAUSES[n - 1];
  return <p className="note"><b>{item.title}.</b> {item.text}</p>;
}

export function Contract({ clause }: { clause: string }) {
  return (
    <>
      <ol>
        {CLAUSES.map((c, i) => (
          <li key={c.title}><Link to={`/family?clause=${i + 1}`}>{c.title}</Link></li>
        ))}
      </ol>
      <p className="small"><Link to="/family?clause=99">Пункт 99, мелким шрифтом</Link></p>
      {clause && <Clause n={Number(clause)} />}
    </>
  );
}
