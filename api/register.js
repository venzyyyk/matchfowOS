/* POST /api/register — заявка от игрока.
   Открыт для всех, но умеет ровно одно: добавить человека в список заявок.
   Ни сетку, ни результаты, ни чужие данные через него не тронуть. */

const S = require('../lib/store');

const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max);

module.exports = async (req, res) => {
  S.noStore(res);
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method' }) }
  if (!S.configured()) return res.status(501).json({ error: 'no_storage' });

  try {
    const b = S.body(req);
    const name = clean(b.name, 80);
    if (name.length < 3) return res.status(400).json({ error: 'name' });

    const cur = await S.read();
    if (!cur.state) return res.status(409).json({ error: 'closed' });
    const st = cur.state;
    if (!st.t || st.t.status !== 'reg') return res.status(409).json({ error: 'closed' });
    if (!Array.isArray(st.players)) st.players = [];
    if (st.players.length >= 400) return res.status(409).json({ error: 'full' });

    const dup = st.players.some(p => String(p.name).toLowerCase() === name.toLowerCase() && p.st === 'new');
    if (dup) return res.status(409).json({ error: 'duplicate' });

    const cats = Array.isArray(st.cats) && st.cats.length ? st.cats.length : 8;
    const cat = Math.max(0, Math.min(cats - 1, parseInt(b.cat, 10) || 0));

    st.players.push({
      id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name, city: clean(b.city, 60), club: clean(b.club, 60), contact: clean(b.contact, 60),
      cat, st: 'new', w: 0, l: 0, seed: null, place: null
    });

    const time = new Date().toISOString().slice(11, 16);
    if (!Array.isArray(st.feed)) st.feed = [];
    st.feed.unshift({ t: time, txt: 'Новая заявка: <b>' + name.replace(/[&<>]/g, '') + '</b>' });
    if (st.feed.length > 60) st.feed.pop();

    const next = { rev: cur.rev + 1, state: st, at: Date.now() };
    await S.write(next);
    return res.status(200).json({ ok: true, rev: next.rev });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
