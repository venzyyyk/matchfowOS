/* Хранилище состояния турнира.
   Работает с любым Redis, у которого есть REST API (Upstash / Vercel KV).
   Переменные окружения подставляет интеграция Vercel — руками ничего писать не нужно. */

const KEY = process.env.MATCHFLOW_KEY || 'matchflow:state';
const URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const PIN = String(process.env.JUDGE_PIN || '2604');
const MAX_BYTES = 900 * 1024;

const configured = () => !!(URL && TOKEN);

async function redis(cmd) {
  const r = await fetch(URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  if (!r.ok) throw new Error('storage_http_' + r.status);
  const j = await r.json();
  return j.result;
}

async function read() {
  const raw = await redis(['GET', KEY]);
  if (!raw) return { rev: 0, state: null };
  try {
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : { rev: 0, state: null };
  } catch (e) {
    return { rev: 0, state: null };
  }
}

async function write(obj) {
  const s = JSON.stringify(obj);
  if (s.length > MAX_BYTES) throw new Error('state_too_big');
  await redis(['SET', KEY, s]);
  return obj;
}

function body(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body) } catch (e) { return {} } }
  return req.body;
}

const isJudge = req => String(req.headers['x-judge-pin'] || '') === PIN;

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

module.exports = { read, write, body, isJudge, configured, noStore, PIN };
