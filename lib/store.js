/* Хранилище состояния турнира — MongoDB.
   Весь турнир лежит в одном документе: { _id:'state', rev, state, at }.
   rev растёт на каждую запись и защищает от того, что двое судей
   одновременно затрут работу друг друга. */

const { MongoClient } = require('mongodb');
const crypto = require('crypto');

const URI = process.env.MONGODB_URI || process.env.MONGODB_URL || process.env.MONGO_URL || process.env.DATABASE_URL || '';
const DB = process.env.MONGODB_DB || 'matchflow';
const COL = process.env.MONGODB_COLLECTION || 'tournament';
const DOC = 'state';
const PIN = String(process.env.JUDGE_PIN || '2604');

const configured = () => !!URI;

/* соединение переживает несколько вызовов функции на тёплом инстансе */
let promise = null;
function connect() {
  if (!promise) {
    const client = new MongoClient(URI, { maxPoolSize: 5, serverSelectionTimeoutMS: 8000 });
    promise = client.connect().catch(e => { promise = null; throw e });
  }
  return promise;
}
async function col() {
  const client = await connect();
  return client.db(DB).collection(COL);
}

async function read() {
  const c = await col();
  const d = await c.findOne({ _id: DOC });
  return d ? { rev: d.rev || 0, state: d.state || null } : { rev: 0, state: null };
}

/* Записывает, только если ревизия в базе всё ещё та, от которой мы отталкивались.
   Вернёт {ok:false}, если кто-то успел записать раньше. */
async function write(expectedRev, state) {
  const c = await col();
  const next = (expectedRev || 0) + 1;

  if (!expectedRev) {
    await c.updateOne({ _id: DOC }, { $setOnInsert: { rev: next, state, at: new Date() } }, { upsert: true });
    const d = await c.findOne({ _id: DOC });
    return d && d.rev === next ? { ok: true, rev: next } : { ok: false };
  }

  const r = await c.updateOne({ _id: DOC, rev: expectedRev }, { $set: { rev: next, state, at: new Date() } });
  return r.matchedCount ? { ok: true, rev: next } : { ok: false };
}

function body(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body) } catch (e) { return {} } }
  return req.body;
}

/* сравнение без утечки по времени */
function same(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  if (x.length !== y.length) { crypto.timingSafeEqual(x, x); return false }
  return crypto.timingSafeEqual(x, y);
}
const isJudge = req => same(req.headers['x-judge-pin'] || '', PIN);
const noStore = res => res.setHeader('Cache-Control', 'no-store, max-age=0');

/* IP запроса — только в виде соли+хеша, сырые адреса не храним */
function who(req) {
  const h = req.headers || {};
  const raw = String(h['x-real-ip'] || h['x-forwarded-for'] || '').split(',')[0].trim()
    || (req.socket && req.socket.remoteAddress) || 'unknown';
  return crypto.createHash('sha256').update(raw + '|' + PIN).digest('hex').slice(0, 16);
}

/* Счётчик попыток в той же коллекции: один документ на источник.
   Не крепость, но превращает перебор четырёх цифр из 30 секунд в недели. */
async function hit(kind, req, limit, windowMs) {
  try {
    const c = await col();
    const id = 'rl:' + kind + ':' + who(req);
    const now = Date.now();
    const d = await c.findOne({ _id: id });
    if (d && now - (d.at || 0) < windowMs) {
      if ((d.n || 0) >= limit)
        return { ok: false, retry: Math.ceil((windowMs - (now - d.at)) / 1000) };
      await c.updateOne({ _id: id }, { $set: { n: (d.n || 0) + 1 } });
      return { ok: true };
    }
    await c.updateOne({ _id: id }, { $set: { n: 1, at: now } }, { upsert: true });
    return { ok: true };
  } catch (e) { return { ok: true } }      /* сбой счётчика не должен ронять сервис */
}
async function forget(kind, req) {
  try { const c = await col(); await c.updateOne({ _id: 'rl:' + kind + ':' + who(req) }, { $set: { n: 0, at: Date.now() } }, { upsert: true }) }
  catch (e) {}
}

/* Публичная версия состояния: без судейского кода и без контактов заявителей. */
function publicState(st) {
  if (!st || typeof st !== 'object') return st;
  const out = JSON.parse(JSON.stringify(st));
  delete out.pin;
  if (Array.isArray(out.players)) out.players.forEach(p => { if (p) delete p.contact });
  return out;
}

const oops = (res, e) => {
  console.error('matchflow:', (e && e.stack) || e);
  return res.status(500).json({ error: 'server' });
};

module.exports = { read, write, body, isJudge, configured, noStore, hit, forget, publicState, oops };
