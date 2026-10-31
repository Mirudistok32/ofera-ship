import { lazy, Suspense } from 'react';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { useLocation } from '../router';

/* Вне компонента: lazy внутри него при каждом рендере давал бы новый тип и сбрасывал дерево */
const Contract = lazy(() => import('./Contract').then((m) => ({ default: m.Contract })));

/* Договор /family (Т27). Граница снаружи Suspense ловит и падение рендера, и незагруженный чанк.
   Заголовок вне границы: упал только договор. key сбрасывает границу, когда сменился пункт */
export function Family() {
  const { search } = useLocation();
  const clause = search.get('clause') ?? '';
  return (
    <section className="panel">
      <h1>Договор ООО «Мы как семья»</h1>
      <p className="muted">Читать не обязательно. Обижаться за это будут обязательно.</p>
      <ErrorBoundary key={clause} home="/family">
        <Suspense fallback={<p className="center muted small">Читаем мелкий шрифт…</p>}>
          <Contract clause={clause} />
        </Suspense>
      </ErrorBoundary>
    </section>
  );
}
