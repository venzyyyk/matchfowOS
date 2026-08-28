/* GET  /api/state?since=N  → состояние турнира (публично)
   POST /api/state          → записать состояние (только судья, заголовок x-judge-pin) */

const S = require('../lib/store');

module.exports = async (req, res) => {
  S.noStore(res);
  if (!S.configured()) return res.status(501).json({ error: 'no_storage' });

  try {
    if (req.method === 'GET') {
      const cur = await S.read();
      const since = parseInt((req.query && req.query.since) || '0', 10) || 0;
      if (cur.rev <= since) return res.status(200).json({ rev: cur.rev });
      return res.status(200).json({ rev: cur.rev, state: cur.state });
    }

    if (req.method === 'POST') {
      if (!S.isJudge(req)) return res.status(401).json({ error: 'pin' });
      const b = S.body(req);
      if (b.check) return res.status(200).json({ ok: true });
      if (!b.state || typeof b.state !== 'object' || !b.state.t || !Array.isArray(b.state.players))
        return res.status(400).json({ error: 'bad_state' });

      const cur = await S.read();
      if (typeof b.rev === 'number' && cur.rev > b.rev)
        return res.status(409).json({ rev: cur.rev, state: cur.state });

      const next = { rev: cur.rev + 1, state: b.state, at: Date.now() };
      await S.write(next);
      return res.status(200).json({ rev: next.rev });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
