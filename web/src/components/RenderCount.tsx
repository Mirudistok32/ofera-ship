import { useEffect, useRef } from 'react';
import { countRender, useRenderCountOn } from '../devtools/renderCount';

/* Бейдж «сколько раз отрисовался»: ставится внутрь компонента и перерисовывается вместе с ним.
   Считаем в эффекте — то есть коммиты, а не вызовы рендера; число пишем в DOM напрямую, без setState.
   Включается в пульте. name — для итогов в пульте: «OfferCard: 200». В StrictMode монтирование даёт 2 */
export function RenderCount({ name = '' }: { name?: string }) {
  const on = useRenderCountOn();
  const renders = useRef(0);
  const badge = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    renders.current += 1;
    if (name) countRender(name);
    if (badge.current) badge.current.textContent = String(renders.current);
  });

  if (!on) return null;
  return <span ref={badge} className="render-count" title={`Отрисовок${name ? ` ${name}` : ''}`} />;
}
