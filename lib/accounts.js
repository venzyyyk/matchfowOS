/* Аккаунты MatchFlow OS — фундамент для трёх ролей: owner / organizer / judge / player.
   Пользователи лежат в той же коллекции, что и состояние турнира, но с префиксом _id='user:<login>'.
   publicState читает только _id='state', так что пользователи наружу не утекают.

   Пароли: scrypt с солью. Токен: HMAC-SHA256 от payload (лёгкий JWT-подобный, без внешних либ). */

const { MongoClient } = require('mongodb');
const crypto = require('crypto');

const URI = process.env.MONGODB_URI || process.env.MONGODB_URL || process.env.MONGO_URL || process.env.DATABASE_URL || '';
const DB  = process.env.MONGODB_DB || 'matchflow';
const COL = process.env.MONGODB_COLLECTION || 'tournament';
/* нет AUTH_SECRET — рандом на инстанс: нельзя подделать токен по известному дефолту/4-значному пину */
const SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString('hex');
const TTL = 1000 * 60 * 60 * 24 * 30;              /* токен живёт 30 дней */

const ROLES = ['owner', 'organizer', 'judge', 'player'];
const RANK = { owner: 3, organizer: 2, judge: 1, player: 0 };

const configured = () => !!URI;

/* одно соединение на тёплый инстанс */
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

const norm = v => String(v == null ? '' : v).trim().toLowerCase();
const uid = () => 'u' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');

/* ---------- пароли ---------- */
function hashPass(pass, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pass), salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPass(pass, salt, hash) {
  if (!salt || !hash) return false;
  let h;
  try { h = crypto.scryptSync(String(pass), salt, 64).toString('hex') } catch (e) { return false }
  const a = Buffer.from(h), b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------- токены ---------- */
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
function sign(payload) {
  const body = b64(Object.assign({ iat: Date.now(), exp: Date.now() + TTL }, payload));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function verifyToken(token) {
  if (!token || String(token).indexOf('.') < 0) return null;
  const [body, sig] = String(token).split('.');
  const exp = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(exp), b = Buffer.from(sig || '');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (p.exp && Date.now() > p.exp) return null;
    return p;
  } catch (e) { return null }
}

/* ---------- пользователи ---------- */
async function getUser(login) {
  const c = await col();
  return c.findOne({ _id: 'user:' + norm(login) });
}
async function getById(id) {
  const c = await col();
  return c.findOne({ kind: 'user', id });
}
/* то, что безопасно отдавать клиенту */
function pub(u) {
  if (!u) return null;
  return { id: u.id, login: u.login, name: u.name, role: u.role, orgId: u.orgId || null, playerId: u.playerId || null };
}

async function createUser({ login, pass, name, role, orgId, playerId }) {
  login = norm(login);
  if (login.length < 3) return { err: 'login' };
  if (String(pass).length < 6) return { err: 'pass' };
  if (ROLES.indexOf(role) < 0) role = 'player';
  const c = await col();
  const exists = await c.findOne({ _id: 'user:' + login });
  if (exists) return { err: 'exists' };
  const { salt, hash } = hashPass(pass);
  const u = {
    _id: 'user:' + login, kind: 'user', id: uid(), login,
    name: String(name || '').trim().slice(0, 80) || login,
    role, salt, hash, orgId: orgId || null, playerId: playerId || null, at: new Date()
  };
  await c.insertOne(u);
  return { user: u };
}

async function login(loginStr, pass) {
  const u = await getUser(loginStr);
  if (!u || !verifyPass(pass, u.salt, u.hash)) return { err: 'bad' };
  return { user: u, token: sign({ id: u.id, role: u.role, orgId: u.orgId || null, playerId: u.playerId || null }) };
}

/* достать пользователя из запроса (заголовок x-auth: <token>) */
async function fromReq(req) {
  const h = req.headers || {};
  const raw = h['x-auth'] || h['authorization'] || '';
  const token = String(Array.isArray(raw) ? raw[0] : raw).replace(/^Bearer\s+/i, '').trim();
  const p = verifyToken(token);
  if (!p) return null;
  return getById(p.id);
}
const atLeast = (user, role) => !!user && (RANK[user.role] || 0) >= (RANK[role] || 0);

/* есть ли хоть один пользователь (для бутстрапа первого owner) */
async function isEmpty() {
  try { const c = await col(); return (await c.countDocuments({ kind: 'user' }, { limit: 1 })) === 0 }
  catch (e) { return false }
}

module.exports = {
  configured, ROLES, RANK,
  hashPass, verifyPass, sign, verifyToken,
  getUser, getById, createUser, login, fromReq, pub, atLeast, isEmpty
};
