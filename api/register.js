/* POST /api/register — заявка от игрока.
   Открыт для всех, но умеет ровно одно: добавить человека в список заявок.
   Ни сетку, ни результаты, ни чужие данные через него не тронуть. */

const S = require('../lib/store');

const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max);

async function attempt(b) {
  const cur = await S.read();
  const st = cur.state;
  if (!st || !st.t || st.t.status !== 'reg') return { code: 409, out: { error: 'closed' } };
  if (!Array.isArray(st.players)) st.players = [];
  if (st.players.length >= 400) return { code: 409, out: { error: 'full' } };

  const name = clean(b.name, 80);
  if (st.players.some(p => String(p.name).toLowerCase() === name.toLowerCase() && p.st === 'new'))
    return { code: 409, out: { error: 'duplicate' } };

  const cats = Array.isArray(st.cats) && st.cats.length ? st.cats.length : 8;
  st.players.push({
    id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name,
    city: clean(b.city, 60), club: clean(b.club, 60), contact: clean(b.contact, 60),
    cat: Math.max(0, Math.min(cats - 1, parseInt(b.cat, 10) || 0)),
    st: 'new', w: 0, l: 0, seed: null, place: null
  });

  if (!Array.isArray(st.feed)) st.feed = [];
  st.feed.unshift({ t: new Date().toISOString().slice(11, 16), txt: 'Новая заявка: <b>' + name.replace(/[&<>]/g, '') + '</b>' });
  if (st.feed.length > 60) st.feed.pop();

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

    /* если судья записал что-то в ту же секунду — пробуем ещё раз поверх свежей версии */
    for (let i = 0; i < 3; i++) {
      const r = await attempt(b);
      if (r) return res.status(r.code).json(r.out);
    }
    return res.status(409).json({ error: 'busy' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
