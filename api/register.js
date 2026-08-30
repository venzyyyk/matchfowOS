/* POST /api/register — заявка от игрока.
   Открыт для всех, но умеет ровно одно: добавить человека в список заявок
   того турнира, у которого статус «идёт регистрация». */

const S = require('../lib/store');

const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max);

function addPlayer(st, b) {
  const name = clean(b.name, 80);
  const cats = Array.isArray(st.cats) && st.cats.length ? st.cats.length : 8;
  const cat = Math.max(0, Math.min(cats - 1, parseInt(b.cat, 10) || 0));
  const id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  st.midSeq = (st.midSeq || 0) + 1;
  const mid = (st.midPrefix || '123') + '-' + String(st.midSeq).padStart(3, '0');
  return {
    id, mid, name, city: clean(b.city, 60), club: clean(b.club, 60),
    contact: clean(b.contact, 60), cat
  };
}

function feed(t, name) {
  if (!Array.isArray(t.feed)) t.feed = [];
  t.feed.unshift({ t: new Date().toISOString().slice(11, 16), txt: 'Новая заявка: <b>' + name.replace(/[&<>]/g, '') + '</b>' });
  if (t.feed.length > 60) t.feed.pop();
}

async function attempt(b) {
  const cur = await S.read();
  const st = cur.state;
  if (!st) return { code: 409, out: { error: 'closed' } };
  const name = clean(b.name, 80);

  /* новая структура: несколько турниров */
  if (Array.isArray(st.tours)) {
    const t = st.tours.find(x => x.id === (b.tour || st.cur)) || st.tours.find(x => x.status === 'reg');
    if (!t || t.status !== 'reg') return { code: 409, out: { error: 'closed' } };
    if (!Array.isArray(t.entries)) t.entries = [];
    if (t.entries.length >= 400) return { code: 409, out: { error: 'full' } };
    const dup = t.entries.some(e => {
      const p = (st.players || []).find(x => x.id === e.p);
      return p && String(p.name).toLowerCase() === name.toLowerCase() && e.st === 'new';
    });
    if (dup) return { code: 409, out: { error: 'duplicate' } };
    const p = addPlayer(st, b);
    if (!Array.isArray(st.players)) st.players = [];
    st.players.push(p);
    t.entries.push({ p: p.id, st: 'new', seed: null, w: 0, l: 0, place: null });
    feed(t, name);
    const w = await S.write(cur.rev, st);
    return w.ok ? { code: 200, out: { ok: true, rev: w.rev } } : null;
  }

  /* старая структура — на случай отката */
  if (!st.t || st.t.status !== 'reg') return { code: 409, out: { error: 'closed' } };
  if (!Array.isArray(st.players)) st.players = [];
  if (st.players.length >= 400) return { code: 409, out: { error: 'full' } };
  if (st.players.some(p => String(p.name).toLowerCase() === name.toLowerCase() && p.st === 'new'))
    return { code: 409, out: { error: 'duplicate' } };
  const p = addPlayer(st, b);
  st.players.push(Object.assign(p, { st: 'new', w: 0, l: 0, seed: null, place: null }));
  feed(st, name);
  const w = await S.write(cur.rev, st);
  return w.ok ? { code: 200, out: { ok: true, rev: w.rev } } : null;
}

module.exports = async (req, res) => {
  S.noStore(res);
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method' }) }
  if (!S.configured()) return res.status(501).json({ error: 'no_storage' });

  try {
    const b = S.body(req);
    if (clean(b.name, 80).length < 3) return res.status(400).json({ error: 'name' });
    for (let i = 0; i < 3; i++) {
      const r = await attempt(b);
      if (r) return res.status(r.code).json(r.out);
    }
    return res.status(409).json({ error: 'busy' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
