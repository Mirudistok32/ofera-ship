/* Авторизация «Офферомании»: JWT HS256 на node:crypto без библиотек и refresh-токен в httpOnly-cookie.
   - Access-токен { sub, role, plan, gen, iat, exp } живёт settings.accessTtl секунд (30, QUEST_ACCESS_TTL; пульт меняет на ходу).
     Тариф в токене не обновляется сам: сменился тариф — нужен refresh. gen меньше текущего поколения (кнопка пульта) — expired.
   - Refresh-токен непрозрачный, в базе лежит только его sha256. Каждый refresh выдаёт новый, старый помечается использованным.
     Повтор использованного (украли или два refresh наперегонки) отзывает всю цепочку: нужен вход заново.
   - 401 несёт WWW-Authenticate: Bearer …, error_description="expired" | "invalid" — по нему клиент решает, делать ли refresh.
   - optionalAuth — для каталога: просроченный или кривой токен там не 401, а гость.
   - Вход: 5 неудачных попыток в минуту на пару IP + логин, шестая → 429 с Retry-After, даже с верным паролем.
   - Секрет подписи — в db.meta: перезапуск не разлогинивает, quest:reset разлогинивает всех. */
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import express from 'express';
import { ACCESS_TTL, REFRESH_TTL, LOGIN_LIMIT } from './config.js';
import { DbError } from './db.js';
import { HttpError } from './errors.js';
import { log } from './log.js';

export const COOKIE = 'quest_refresh';
const REALM = 'offeromania';
const scrypt = promisify(crypto.scrypt);

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const unb64 = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const nowSec = () => Math.floor(Date.now() / 1000);
const iso = (ms = Date.now()) => new Date(ms).toISOString();

export function signJwt(payload, secret) {
  const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}`;
  return `${head}.${crypto.createHmac('sha256', secret).update(head).digest('base64url')}`;
}

/* → { payload } или { reason: 'invalid' | 'expired' }. Подпись сверяется до разбора, alg — только HS256: alg "none" не пройдёт */
export function verifyJwt(token, secret) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return { reason: 'invalid' };
  const [h, p, sig] = parts;
  const good = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== good.length || !crypto.timingSafeEqual(got, good)) return { reason: 'invalid' };
  let header, payload;
  try {
    header = unb64(h);
    payload = unb64(p);
  } catch {
    return { reason: 'invalid' };
  }
  if (header.alg !== 'HS256' || typeof payload.exp !== 'number') return { reason: 'invalid' };
  if (nowSec() >= payload.exp) return { reason: 'expired', payload };
  return { payload };
}

/* Тариф прямо сейчас: премиум навсегда (rich) или купленный до premiumUntil */
export function planOf(user, at = Date.now()) {
  return user.plan === 'premium' || (user.premiumUntil && Date.parse(user.premiumUntil) > at) ? 'premium' : 'free';
}

/* trophies — ачивки на счету: заработанные минус потраченные на премиум */
export function publicUser(user) {
  const { passwordHash, salt, ...rest } = user;
  return { ...rest, plan: planOf(user), trophies: user.achievements.length - (user.achievementsSpent ?? 0) };
}

/* Премиальное действие: тариф в токене и в базе должны совпасть. Не совпали — 403 PLAN_STALE, лечится refresh:
   премиум купили, а токен старый, или премиум кончился, а токен ещё помнит его */
export function premiumGate(auth, user) {
  const real = planOf(user);
  if (auth.plan !== real) {
    throw new HttpError(403, 'PLAN_STALE', real === 'premium'
      ? 'Тариф сменился, а пропуск старый. Обнови его через /auth/refresh'
      : 'Премиум закончился, а пропуск ещё помнит его. Обнови через /auth/refresh', { extra: { tokenPlan: auth.plan, plan: real } });
  }
  if (real !== 'premium') throw new HttpError(403, 'PREMIUM_REQUIRED', 'Это для тех, у кого «Синдром отличника»');
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/* Path=/auth — cookie уходит только на /auth/*, остальные запросы её не таскают. Secure нет: всё на http://localhost */
const cookie = (value, maxAge) => `${COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=${maxAge}`;

/* Неизвестный логин проверяется против пустышки: время ответа не выдаёт, есть ли такой пользователь */
const DUMMY = { salt: 'quest:dummy', passwordHash: '0'.repeat(64) };
async function passwordOk(user, password) {
  const u = user ?? DUMMY;
  const got = await scrypt(password, u.salt, 32);
  return crypto.timingSafeEqual(got, Buffer.from(u.passwordHash, 'hex')) && Boolean(user);
}

function unauthorized(reason, code, message) {
  const challenge = `Bearer realm="${REALM}"${reason ? `, error="invalid_token", error_description="${reason}"` : ''}`;
  return new HttpError(401, code, message, { headers: { 'WWW-Authenticate': challenge } });
}

const REFRESH_FAIL = {
  NO_REFRESH: 'Пропуска на продление нет — нужен вход',
  REFRESH_INVALID: 'Такой пропуск не выдавали',
  REFRESH_EXPIRED: 'Пропуск на продление просрочен — нужен вход',
  REFRESH_REVOKED: 'Пропуск отозван — нужен вход',
  REFRESH_REUSED: 'Этот пропуск уже обменяли. Вся цепочка отозвана — нужен вход',
};
/* Неудачный refresh стирает cookie: клиенту больше нечего обменивать */
const refreshFail = (code) => new HttpError(401, code, REFRESH_FAIL[code], { headers: { 'Set-Cookie': cookie('', 0) } });

export function createAuth({ db, origins }) {
  const settings = { accessTtl: ACCESS_TTL, refreshTtl: REFRESH_TTL };
  if (!db.meta.jwtSecret) db.setMeta({ jwtSecret: crypto.randomBytes(32).toString('base64url') });
  const secret = () => db.meta.jwtSecret;
  const failures = new Map();   // `${ip}|${login}` → времена неудачных попыток за окно

  /* gen — поколение пропусков: кнопка пульта «сделать токен просроченным» поднимает его, и все выданные раньше считаются expired */
  const tokenGen = () => db.meta.tokenGen ?? 0;
  const accessToken = (user) => {
    const iat = nowSec();
    return signJwt({ sub: user.id, role: user.role, plan: planOf(user), gen: tokenGen(), iat, exp: iat + settings.accessTtl }, secret());
  };
  const verify = (token) => {
    const result = verifyJwt(token, secret());
    if (!result.reason && (result.payload.gen ?? 0) < tokenGen()) return { reason: 'expired', payload: result.payload };
    return result;
  };

  /* Пульт: все выданные access-токены — просроченные (refresh-cookie живы) */
  const expireAll = () => {
    db.setMeta({ tokenGen: tokenGen() + 1 });
    log('auth', `пульт: все access-токены просрочены (поколение ${tokenGen()})`);
    return tokenGen();
  };

  /* Для журнала запросов: чей токен и в каком он состоянии, без 401 */
  const inspect = (token) => {
    if (!token) return null;
    const { payload, reason } = verify(token);
    const fp = sha256(token).slice(0, 10);
    if (reason === 'invalid') return { fp, state: 'invalid' };
    return { fp, state: reason ?? 'ok', sub: payload.sub, role: payload.role, plan: payload.plan };
  };

  /* Сессия — звено цепочки family: refresh добавляет звено, повтор отзывает все */
  const newSession = (user, family = `f-${crypto.randomBytes(6).toString('hex')}`) => {
    const token = crypto.randomBytes(32).toString('base64url');
    const row = {
      id: sha256(token), family, userId: user.id,
      createdAt: iso(), expiresAt: iso(Date.now() + settings.refreshTtl * 1000),
      usedAt: null, replacedBy: null, revokedAt: null,
    };
    return { token, row };
  };

  const issue = (res, user, token) => {
    res.setHeader('Set-Cookie', cookie(token, settings.refreshTtl));
    res.json({ accessToken: accessToken(user), tokenType: 'Bearer', expiresIn: settings.accessTtl, user: publicUser(user), serverTime: Date.now() });
  };

  /* Отозвать цепочку; параллельный refresh мог задеть те же строки — тогда ещё раз */
  async function revokeFamily(ctx, family) {
    for (let attempt = 1; ; attempt++) {
      const rows = await db.where(ctx, 'sessions', (s) => s.family === family && !s.revokedAt);
      try {
        if (rows.length) await db.tx(ctx, async (t) => {
          for (const s of rows) await t.update('sessions', s.id, { revokedAt: iso() });
        });
        return rows.length;
      } catch (e) {
        if (!(e instanceof DbError && e.code === 'VERSION_CONFLICT') || attempt >= 3) throw e;
      }
    }
  }

  /* Cookie-ручки принимают запросы только без Origin (curl, fetch из node) или со своих origin */
  const ownOrigin = (req, _res, next) => {
    const origin = req.headers.origin;
    if (origin && !origins.includes(origin)) {
      log('auth', `${req.method} ${req.path} с чужого origin ${origin} → 403`);
      throw new HttpError(403, 'ORIGIN_FORBIDDEN', 'С этого сайта пропуска не выдают');
    }
    next();
  };

  const bearer = (req) => /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];

  /* Токен → payload или 401 с причиной. Кроме заголовка, токен приходит в ?token= у /stream: EventSource заголовков не шлёт */
  const authenticate = (req, token) => {
    if (!token) {
      log('auth', `401 без токена · ${req.method} ${req.path}`);
      throw unauthorized(null, 'NO_TOKEN', 'Без пропуска не пускаем');
    }
    const { payload, reason } = verify(token);
    if (reason === 'expired') {
      log('auth', `401 expired · ${payload.sub} · ${req.method} ${req.path}`);
      throw unauthorized('expired', 'TOKEN_EXPIRED', 'Пропуск просрочен — обменяй его на /auth/refresh');
    }
    if (reason) {
      log('auth', `401 invalid · подпись или формат не сошлись · ${req.method} ${req.path}`);
      throw unauthorized('invalid', 'TOKEN_INVALID', 'Пропуск нарисован от руки');
    }
    return payload;
  };

  const requireAuth = (req, _res, next) => {
    req.auth = authenticate(req, bearer(req));
    next();
  };

  /* Для публичных адресов (каталог): верный токен — знаем, кто смотрит (вишлист, вилка); нет его или он просрочен — гость, без 401.
     Так каталог работает и до тикетов про refresh, а 401 ловят только закрытые адреса */
  const optionalAuth = (req, _res, next) => {
    const token = bearer(req);
    req.auth = null;
    if (token) {
      const { payload, reason } = verify(token);
      if (reason) log('auth', `токен ${reason} на открытом ${req.method} ${req.path} → как гость`);
      else req.auth = payload;
    }
    next();
  };

  const requireRole = (...roles) => [requireAuth, (req, _res, next) => {
    if (!roles.includes(req.auth.role)) {
      log('auth', `403 роль ${req.auth.role}, нужна ${roles.join('|')} · ${req.method} ${req.path}`);
      throw new HttpError(403, 'FORBIDDEN', 'Сюда только HR. Соискателей просят подождать в переговорке');
    }
    next();
  }];

  const router = express.Router();

  router.post('/auth/login', ownOrigin, async (req, res) => {
    const { login, password } = req.body ?? {};
    const fields = {};
    if (typeof login !== 'string' || !login.trim()) fields.login = 'Нужен логин';
    if (typeof password !== 'string' || !password) fields.password = 'Нужен пароль';
    if (Object.keys(fields).length) throw new HttpError(422, 'VALIDATION', 'Анкета заполнена не до конца', { fields });

    const name = login.trim().toLowerCase();
    const key = `${req.ip}|${name}`;
    const recent = (failures.get(key) ?? []).filter((t) => Date.now() - t < LOGIN_LIMIT.windowMs);
    failures.set(key, recent);
    if (recent.length >= LOGIN_LIMIT.attempts) {
      const retry = Math.max(1, Math.ceil((recent[0] + LOGIN_LIMIT.windowMs - Date.now()) / 1000));
      log('auth', `429 вход ${name}: ${recent.length} неудач за минуту, ждать ${retry} с`);
      throw new HttpError(429, 'LOGIN_LIMIT', 'Слишком много попыток. Остынь', { headers: { 'Retry-After': String(retry) } });
    }

    const [user] = await db.where(req.db, 'users', (u) => u.login === name);
    if (!(await passwordOk(user, password))) {
      recent.push(Date.now());
      log('auth', `неудачный вход ${name} (${recent.length}/${LOGIN_LIMIT.attempts})`);
      throw new HttpError(422, 'BAD_CREDENTIALS', 'Логин или пароль не подходят', {
        fields: { password: 'Логин или пароль не подходят' },
        extra: { attemptsLeft: LOGIN_LIMIT.attempts - recent.length },
      });
    }
    failures.delete(key);

    const { token, row } = newSession(user);
    await db.tx(req.db, (t) => t.insert('sessions', row));
    log('auth', `вход ${name} · ${user.role}, ${planOf(user)} · цепочка ${row.family}`);
    issue(res, user, token);
  });

  router.post('/auth/refresh', ownOrigin, async (req, res) => {
    const token = readCookie(req, COOKIE);
    if (!token) throw refreshFail('NO_REFRESH');
    const id = sha256(token);
    let result;
    try {
      result = await db.tx(req.db, async (t) => {
        const s = await t.get('sessions', id);
        if (!s) return { fail: 'REFRESH_INVALID' };
        if (s.revokedAt) return { fail: 'REFRESH_REVOKED' };
        if (s.usedAt) return { fail: 'REFRESH_REUSED', family: s.family };
        if (Date.parse(s.expiresAt) <= Date.now()) return { fail: 'REFRESH_EXPIRED' };
        const user = await t.get('users', s.userId);
        if (!user) return { fail: 'REFRESH_INVALID' };
        const next = newSession(user, s.family);
        await t.update('sessions', id, { usedAt: iso(), replacedBy: next.row.id });
        await t.insert('sessions', next.row);
        return { user, token: next.token, family: s.family };
      });
    } catch (e) {
      if (!(e instanceof DbError && e.code === 'VERSION_CONFLICT')) throw e;
      /* Параллельный refresh тем же токеном закоммитился первым — это такой же повтор */
      const s = await db.get(req.db, 'sessions', id);
      result = { fail: 'REFRESH_REUSED', family: s?.family };
    }
    if (result.fail) {
      if (result.fail === 'REFRESH_REUSED' && result.family) {
        const n = await revokeFamily(req.db, result.family);
        log('auth', `повтор refresh-токена → цепочка ${result.family} отозвана (${n} звен.)`);
      } else {
        log('auth', `refresh отклонён: ${result.fail}`);
      }
      throw refreshFail(result.fail);
    }
    log('auth', `refresh ${result.user.login} · ${result.user.role}, ${planOf(result.user)} · цепочка ${result.family}`);
    issue(res, result.user, result.token);
  });

  router.post('/auth/logout', ownOrigin, async (req, res) => {
    const token = readCookie(req, COOKIE);
    const s = token ? await db.get(req.db, 'sessions', sha256(token)) : null;
    if (s) {
      await revokeFamily(req.db, s.family);
      log('auth', `выход · цепочка ${s.family} отозвана`);
    }
    res.setHeader('Set-Cookie', cookie('', 0));
    res.status(204).end();
  });

  router.get('/me', requireAuth, async (req, res) => {
    const user = await db.get(req.db, 'users', req.auth.sub);
    if (!user) throw unauthorized('invalid', 'TOKEN_INVALID', 'Такого сотрудника нет');
    const { role, plan, exp } = req.auth;
    res.json({ user: publicUser(user), token: { role, plan, exp }, serverTime: Date.now() });
  });

  return { router, authenticate, requireAuth, optionalAuth, requireRole, settings, bearer, expireAll, inspect };
}
