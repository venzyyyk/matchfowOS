/* GET  /api/state?since=N  → состояние турнира (публично, без судейского кода и контактов)
   POST /api/state          → записать состояние (только судья, заголовок x-judge-pin) */

const S = require('../lib/store');

const MAX_STATE = 2 * 1024 * 1024;   /* 2 МБ — турнир столько не весит, а раздуть базу не даст */

module.exports = async (req, res) => {
  S.noStore(res);
  if (!S.configured()) return res.status(501).json({ error: 'no_storage' });

  try {
    const judge = S.isJudge(req);

    if (req.method === 'GET') {
      const cur = await S.read();
      const since = parseInt((req.query && req.query.since) || '0', 10) || 0;
      if (cur.rev <= since) return res.status(200).json({ rev: cur.rev });
      /* контакты и код судьи уходят только тому, кто вошёл в судейскую */
      return res.status(200).json({ rev: cur.rev, state: judge ? cur.state : S.publicState(cur.state) });
    }

    if (req.method === 'POST') {
      if (!judge) {
        /* перебор кода: десять попыток на источник за десять минут */
        const rl = await S.hit('pin', req, 10, 10 * 60 * 1000);
        if (!rl.ok) return res.status(429).json({ error: 'too_many', retry: rl.retry });
        return res.status(401).json({ error: 'pin' });
      }
      await S.forget('pin', req);

      const b = S.body(req);
      if (b.check) return res.status(200).json({ ok: true });

      const ok = b.state && typeof b.state === 'object' && Array.isArray(b.state.players) &&
        (Array.isArray(b.state.tours) || b.state.t);
      if (!ok) return res.status(400).json({ error: 'bad_state' });

      let size = 0;
      try { size = Buffer.byteLength(JSON.stringify(b.state)) } catch (e) { return res.status(400).json({ error: 'bad_state' }) }
      if (size > MAX_STATE) return res.status(413).json({ error: 'too_big', size });

      const cur = await S.read();
      if (typeof b.rev === 'number' && cur.rev > b.rev)
        return res.status(409).json({ rev: cur.rev, state: cur.state });

      const w = await S.write(cur.rev, b.state);
      if (!w.ok) {
        const fresh = await S.read();
        return res.status(409).json({ rev: fresh.rev, state: fresh.state });
      }
      return res.status(200).json({ rev: w.rev });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method' });
  } catch (e) {
    return S.oops(res, e);
  }
};
