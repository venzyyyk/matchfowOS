/* /api/auth — аккаунты MatchFlow OS.
   POST { action:'register', login, pass, name, role? }  — регистрация
   POST { action:'login',    login, pass }               — вход, отдаёт токен
   GET                                                     — кто я (заголовок x-auth: <token>)

   Роли: owner / organizer / judge / player.
   - Самому зарегистрироваться можно только как player.
   - organizer создаёт только owner; judge создаёт owner или organizer.
   - Самый первый аккаунт в системе становится owner (бутстрап). */

const A = require('../lib/accounts');

function body(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body) } catch (e) { return {} } }
  return req.body;
}
const noStore = res => res.setHeader('Cache-Control', 'no-store, max-age=0');

module.exports = async (req, res) => {
  noStore(res);
  if (!A.configured()) return res.status(501).json({ error: 'no_storage' });

  try {
    /* кто я */
    if (req.method === 'GET') {
      const me = await A.fromReq(req);
      return res.status(200).json({ user: A.pub(me) });
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ error: 'method' });
    }

    const b = body(req);
    const action = String(b.action || '').toLowerCase();

    if (action === 'login') {
      const r = await A.login(b.login, b.pass);
      if (r.err) return res.status(401).json({ error: 'bad_credentials' });
      return res.status(200).json({ token: r.token, user: A.pub(r.user) });
    }

    if (action === 'register') {
      let role = String(b.role || 'player').toLowerCase();
      const caller = await A.fromReq(req);
      const bootstrap = await A.isEmpty();

      if (bootstrap) {
        role = 'owner';                  /* самый первый аккаунт в системе — owner */
      } else if (role !== 'player') {
        /* повышенные роли создаёт только тот, у кого прав хватает */
        const need = role === 'organizer' ? 'owner' : 'organizer';
        if (!A.atLeast(caller, need)) return res.status(403).json({ error: 'forbidden' });
      }

      const r = await A.createUser({
        login: b.login, pass: b.pass, name: b.name, role,
        orgId: role === 'organizer' ? null : (caller && caller.orgId) || (b.orgId || null),
        playerId: b.playerId || null
      });
      if (r.err) {
        const map = { login: 400, pass: 400, exists: 409 };
        return res.status(map[r.err] || 400).json({ error: r.err });
      }
      const tok = (await A.login(b.login, b.pass)).token;
      return res.status(200).json({ token: tok, user: A.pub(r.user) });
    }

    return res.status(400).json({ error: 'bad_action' });
  } catch (e) {
    console.error('matchflow auth:', (e && e.stack) || e);
    return res.status(500).json({ error: 'server' });
  }
};
