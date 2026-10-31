import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { http, isHttpError } from '../api/http';
import { Modal } from '../components/Modal';
import { Link } from '../router';
import { RARITIES, rarityName } from '../rarity';
import type { Company, Flag, HrOffer, HrOfferDraft, Rarity } from '../types';

const GRADES = ['Junior', 'Junior+', 'Middle', 'Middle+', 'Senior', 'Lead'];

const EMPTY: HrOfferDraft = {
  title: '', grade: 'Junior', companyId: 'c01', rarity: 'common', price: 40,
  salaryFrom: 100_000, salaryTo: 150_000, flags: ['family'], city: 'Удалённо', pitch: '',
};

/* HR-панель: свои офферы и форма «Выставить оффер» */
export function HrPanel() {
  const [offers, setOffers] = useState<HrOffer[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [flags, setFlags] = useState<Flag[]>([]);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<HrOfferDraft>(EMPTY);
  const [sending, setSending] = useState(false);
  const [fields, setFields] = useState<{ [field: string]: string }>({});
  const [formError, setFormError] = useState('');

  const load = useCallback(() => {
    http<{ items: HrOffer[] }>('/hr/offers').then((data) => setOffers(data.items ?? []));
  }, []);

  useEffect(() => {
    load();
    http<{ items: Company[] }>('/companies').then((data) => setCompanies(data.items ?? []));
    http<{ items: Flag[] }>('/flags').then((data) => setFlags(data.items ?? []));
  }, [load]);

  const toggleFlag = (id: string) =>
    setDraft({ ...draft, flags: draft.flags.includes(id) ? draft.flags.filter((f) => f !== id) : [...draft.flags, id] });

  /* Т18: форма закрывается только после 201. На 422 остаётся открытой: fields — под полями,
     общий текст — над кнопками, черновик не трогаем. Ошибка не улетает из обработчика необработанной */
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSending(true);
    setFields({});
    setFormError('');
    try {
      await http<{ offer: HrOffer }>('/hr/offers', { method: 'POST', body: JSON.stringify(draft) });
      setDraft(EMPTY);
      setOpen(false);
      load();
    } catch (err: unknown) {
      if (isHttpError(err)) {
        setFields(err.fields);
        setFormError(err.message);
      } else {
        setFormError('Не получилось отправить. Попробуй ещё раз');
      }
    } finally {
      setSending(false);
    }
  }

  /* Ошибки прошлой попытки не переносим в новое открытие формы — черновик остаётся */
  const openForm = () => {
    setFields({});
    setFormError('');
    setOpen(true);
  };

  const fieldError = (name: string) => fields[name] && <small className="field-error">{fields[name]}</small>;

  return (
    <div className="stack">
      <section className="panel">
        <h1>HR-панель</h1>
        <p className="muted">Офферы, которые выставлены с этого бейджа. Сервер проверяет каждое поле.</p>
        <button type="button" className="btn btn-primary" onClick={openForm}>Выставить оффер</button>
      </section>

      {offers.length ? (
        <div className="cards">
          {offers.map((o) => (
            <article key={o.id} className={`card rarity-${o.rarity}`}>
              <span className="badge badge-rarity">{rarityName(o.rarity)}</span>
              <Link to={`/offers/${o.id}`} className="offer-title">{o.title}</Link>
              <span className="small">{o.grade} · {o.city} · {o.price} 🍪</span>
            </article>
          ))}
        </div>
      ) : (
        <p className="muted">Пока ничего не выставлено.</p>
      )}

      <Modal open={open} title="Новый оффер" onClose={() => setOpen(false)}>
        <form className="stack hr-form" onSubmit={onSubmit}>
          <label className="field">
            <span>Название</span>
            <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="Frontend-ниндзя" aria-invalid={Boolean(fields.title)} />
            {fieldError('title')}
          </label>
          <div className="form-row">
            <label className="field">
              <span>Грейд</span>
              <select value={draft.grade} onChange={(e) => setDraft({ ...draft, grade: e.target.value })}>
                {GRADES.map((g) => <option key={g}>{g}</option>)}
              </select>
              {fieldError('grade')}
            </label>
            <label className="field">
              <span>Редкость</span>
              <select value={draft.rarity} onChange={(e) => setDraft({ ...draft, rarity: e.target.value as Rarity })}>
                {RARITIES.map((r) => <option key={r.id} value={r.id}>{r.emoji} {r.name}</option>)}
              </select>
              {fieldError('rarity')}
            </label>
          </div>
          <label className="field">
            <span>Компания</span>
            <select value={draft.companyId} onChange={(e) => setDraft({ ...draft, companyId: e.target.value })}>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.emoji} {c.name}</option>)}
            </select>
            {fieldError('companyId')}
          </label>
          <div className="form-row">
            <label className="field">
              <span>Цена, 🍪</span>
              <input type="number" value={draft.price} onChange={(e) => setDraft({ ...draft, price: Number(e.target.value) })} aria-invalid={Boolean(fields.price)} />
              {fieldError('price')}
            </label>
            <label className="field">
              <span>Вилка от, ₽</span>
              <input type="number" value={draft.salaryFrom} onChange={(e) => setDraft({ ...draft, salaryFrom: Number(e.target.value) })} aria-invalid={Boolean(fields.salaryFrom)} />
              {fieldError('salaryFrom')}
            </label>
            <label className="field">
              <span>Вилка до, ₽</span>
              <input type="number" value={draft.salaryTo} onChange={(e) => setDraft({ ...draft, salaryTo: Number(e.target.value) })} aria-invalid={Boolean(fields.salaryTo)} />
              {fieldError('salaryTo')}
            </label>
          </div>
          <label className="field">
            <span>Город</span>
            <input value={draft.city} onChange={(e) => setDraft({ ...draft, city: e.target.value })} aria-invalid={Boolean(fields.city)} />
            {fieldError('city')}
          </label>
          <fieldset className="flags">
            <legend className="muted small">Красные флаги</legend>
            {flags.map((f) => (
              <label key={f.id} className="check small">
                <input type="checkbox" checked={draft.flags.includes(f.id)} onChange={() => toggleFlag(f.id)} />
                {f.text}
              </label>
            ))}
            {fieldError('flags')}
          </fieldset>
          <label className="field">
            <span>Описание</span>
            <textarea rows={3} value={draft.pitch} onChange={(e) => setDraft({ ...draft, pitch: e.target.value })} aria-invalid={Boolean(fields.pitch)} />
            {fieldError('pitch')}
          </label>
          {formError && !Object.keys(fields).length && <p className="note note-error" role="alert">{formError}</p>}
          <div className="row">
            <button type="submit" className="btn btn-primary" disabled={sending}>Выставить</button>
            <button type="button" className="btn" onClick={() => setOpen(false)}>Отмена</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
