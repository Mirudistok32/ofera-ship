/* «База данных» в памяти — ведёт себя как настоящая, чтобы на фронте было видно цену запросов.
   - Таблицы: Map id → строка, у каждой строки версия v (для If-Match и «пока шли раздумья…»).
   - Пул из 5 соединений: каждый запрос занимает соединение; очередь длиннее 20 → DB_BUSY (на HTTP — 503).
   - Цена: «по индексу» 5–30 мс, полный перебор 300–800 мс; noIndex превращает всё в перебор.
   - Транзакция держит одно соединение, между шагами — пауза; записи применяются только при commit.
   - Счётчик запросов на HTTP-запрос (ctx) → заголовки Server-Timing и X-DB-Queries.
   - Ревизия таблицы растёт с каждой записью в неё — по ней справочники понимают, что ETag устарел.
   - Сохранение в JSON с задержкой 300 мс после записи и сразу при выходе. */
import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.js';

export class DbError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const between = ([a, b]) => a + Math.random() * (b - a);
const copy = (row) => (row ? structuredClone(row) : null);

export const DEFAULTS = {
  poolSize: 5,
  queueMax: 20,
  indexMs: [5, 30],
  scanMs: [300, 800],
  stepMs: [40, 120],   // пауза между шагами транзакции
  noIndex: false,
};

export function newCtx() {
  return { queries: 0, ms: 0, wait: 0 };
}

export class Db {
  constructor(file, data, settings = {}) {
    this.file = file;
    this.settings = { ...DEFAULTS, ...settings };
    this.meta = data.meta ?? {};
    this.tables = {};
    for (const [name, rows] of Object.entries(data.tables)) this.tables[name] = new Map(rows.map((r) => [r.id, r]));
    this.revs = {};
    this.active = 0;
    this.queue = [];
    this.timer = null;
  }

  /* Открыть файл; нет файла — взять make() (сид) и сразу сохранить */
  static open(file, make, settings) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      data = make();
      writeData(file, data);
      log('db', `новая база из сида → ${file}`);
    }
    return new Db(file, data, settings);
  }

  table(name) {
    const t = this.tables[name];
    if (!t) throw new Error(`нет таблицы ${name}`);
    return t;
  }

  /* Таблицы, которых нет в файле старой базы (сервер вырос после сида), — пустыми */
  ensure(names) {
    for (const name of names) this.tables[name] ??= new Map();
    return this;
  }

  rev(table) {
    return this.revs[table] ?? 0;
  }

  stats() {
    const counts = Object.fromEntries(Object.entries(this.tables).map(([k, t]) => [k, t.size]));
    return { active: this.active, queued: this.queue.length, ...this.settings, counts };
  }

  /* ---------- пул ---------- */

  async acquire() {
    if (this.active < this.settings.poolSize && !this.queue.length) {
      this.active++;
      return;
    }
    if (this.queue.length >= this.settings.queueMax) {
      log('db', `очередь ${this.queue.length} — отказ (пул ${this.settings.poolSize})`);
      throw new DbError('DB_BUSY', 'База перегружена', { retryAfter: 2 });
    }
    await new Promise((resolve) => this.queue.push(resolve));
  }

  release() {
    this.active--;
    this.pump();
  }

  /* Отдать свободные соединения ждущим; размер пула можно менять на ходу */
  pump() {
    while (this.queue.length && this.active < this.settings.poolSize) {
      this.active++;
      this.queue.shift()();
    }
  }

  /* Один запрос: соединение из пула + задержка по цене + учёт в ctx */
  async run(ctx, cost, fn) {
    const t0 = performance.now();
    await this.acquire();
    const t1 = performance.now();
    try {
      const kind = this.settings.noIndex ? 'scan' : cost;
      const ms = between(kind === 'scan' ? this.settings.scanMs : this.settings.indexMs);
      await sleep(ms);
      if (kind === 'scan') log('db', `полный перебор ${Math.round(ms)} мс${t1 - t0 > 1 ? ` (ждал соединение ${Math.round(t1 - t0)} мс)` : ''}`);
      return fn();
    } finally {
      this.release();
      if (ctx) {
        ctx.queries++;
        ctx.ms += performance.now() - t0;
        ctx.wait += t1 - t0;
      }
    }
  }

  /* ---------- чтение ---------- */

  get(ctx, table, id) {
    return this.run(ctx, 'index', () => copy(this.table(table).get(id)));
  }

  /* Батч по id — один запрос, как WHERE id IN (…) */
  getMany(ctx, table, ids) {
    return this.run(ctx, 'index', () => ids.map((id) => this.table(table).get(id)).filter(Boolean).map(copy));
  }

  /* Отбор по полю с индексом (userId, offerId…) */
  where(ctx, table, pred) {
    return this.run(ctx, 'index', () => [...this.table(table).values()].filter(pred).map(copy));
  }

  /* Полный перебор (поиск по тексту): дорого */
  scan(ctx, table, pred = () => true) {
    return this.run(ctx, 'scan', () => [...this.table(table).values()].filter(pred).map(copy));
  }

  /* ---------- запись ---------- */

  /* Транзакция: fn(t) читает и пишет через t, записи видны внутри и применяются разом в конце.
     Ошибка внутри — ничего не записано. Версии проверяются ещё раз при commit: параллельная транзакция могла успеть первой */
  async tx(ctx, fn) {
    const t0 = performance.now();
    await this.acquire();
    const t1 = performance.now();
    const staged = new Map();   // `${table}/${id}` → { table, row, expected }
    const seen = new Map();     // версии, прочитанные в транзакции: запись проверится против них
    const key = (table, id) => `${table}/${id}`;
    let steps = 0;
    const step = async () => {
      if (steps++) await sleep(between(this.settings.stepMs));
      await sleep(between(this.settings.indexMs));
      if (ctx) ctx.queries++;
    };
    const t = {
      get: async (table, id) => {
        await step();
        const s = staged.get(key(table, id));
        const row = s ? s.row : this.table(table).get(id);
        if (!s && row && !seen.has(key(table, id))) seen.set(key(table, id), row.v);
        return copy(row);
      },
      insert: async (table, row) => {
        await step();
        if (this.table(table).has(row.id) || staged.has(key(table, row.id))) throw new DbError('DUPLICATE', `${table}/${row.id} уже есть`);
        staged.set(key(table, row.id), { table, row: { ...row, v: 1 }, expected: 0 });
        return copy({ ...row, v: 1 });
      },
      /* expected — версия, которую видел клиент (If-Match); без неё — версия на момент чтения в транзакции */
      update: async (table, id, patch, expected) => {
        await step();
        const k = key(table, id);
        const cur = staged.get(k)?.row ?? this.table(table).get(id);
        if (!cur) throw new DbError('NOT_FOUND', `${table}/${id} не найдено`);
        if (expected != null && cur.v !== expected) throw new DbError('VERSION_CONFLICT', 'Версия устарела', { current: copy(cur) });
        const base = staged.get(k)?.expected ?? seen.get(k) ?? cur.v;
        const row = { ...cur, ...patch, id, v: cur.v + 1 };
        staged.set(k, { table, row, expected: base });
        return copy(row);
      },
      remove: async (table, id) => {
        await step();
        const cur = this.table(table).get(id);
        staged.set(key(table, id), { table, row: null, expected: cur?.v ?? 0, id });
      },
    };
    try {
      const result = await fn(t);
      for (const s of staged.values()) {
        const id = s.row?.id ?? s.id;
        const now = this.table(s.table).get(id);
        if ((now?.v ?? 0) !== s.expected) throw new DbError('VERSION_CONFLICT', 'Пока шли раздумья, данные изменились', { current: copy(now) });
      }
      for (const s of staged.values()) {
        if (s.row) this.table(s.table).set(s.row.id, s.row);
        else this.table(s.table).delete(s.id);
        this.revs[s.table] = this.rev(s.table) + 1;
      }
      if (staged.size) this.dirty();
      return result;
    } finally {
      this.release();
      if (ctx) {
        ctx.ms += performance.now() - t0;
        ctx.wait += t1 - t0;
      }
    }
  }

  /* Служебная запись без цены и пула — для сервера самого (счётчики, боты) */
  setMeta(patch) {
    Object.assign(this.meta, patch);
    this.dirty();
  }

  /* ---------- сохранение ---------- */

  dirty() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 300);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    writeData(this.file, this.dump());
  }

  dump() {
    return { meta: this.meta, tables: Object.fromEntries(Object.entries(this.tables).map(([k, t]) => [k, [...t.values()]])) };
  }
}

/* Атомарно: во временный файл, потом rename — оборванная запись не испортит базу */
export function writeData(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

/* Server-Timing и X-DB-Queries — ставятся прямо перед отправкой заголовков */
export function dbHeaders(req, res) {
  const ctx = req.db;
  const total = performance.now() - req.t0;
  res.setHeader('X-DB-Queries', String(ctx.queries));
  res.setHeader('Server-Timing', `db;dur=${ctx.ms.toFixed(1)};desc="${ctx.queries} q", wait;dur=${ctx.wait.toFixed(1)}, app;dur=${total.toFixed(1)}`);
}
