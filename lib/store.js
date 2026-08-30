/* Хранилище состояния турнира — MongoDB.
   Весь турнир лежит в одном документе: { _id:'state', rev, state, at }.
   rev растёт на каждую запись и защищает от того, что двое судей
   одновременно затрут работу друг друга. */

const { MongoClient } = require('mongodb');

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

const isJudge = req => String(req.headers['x-judge-pin'] || '') === PIN;
const noStore = res => res.setHeader('Cache-Control', 'no-store, max-age=0');

module.exports = { read, write, body, isJudge, configured, noStore };
