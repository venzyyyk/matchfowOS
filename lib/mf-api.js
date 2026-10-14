/* Тонкий клиент к /api/state — для браузерных страниц (экран групп, overlay).
   Один источник правды: то же состояние, что пишет и читает основная сетка.

   read()            -> { rev, state }        (публичная версия: без pin и контактов)
   readJudge(pin)    -> { rev, state }        (полная версия, если pin верный)
   write(pin, rev, state) -> { ok, rev } | { conflict, rev, state } | { denied }
   poll(onChange, opts)   -> stop()           (лёгкий опрос ?since=rev)

   Никакого состояния наружу не тянем — вызывающий держит свой ST и rev. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MFApi = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var BASE = '';   /* тот же origin, что и страница */

  function headers(pin) {
    var h = { 'Content-Type': 'application/json' };
    if (pin) h['x-judge-pin'] = String(pin).trim();
    return h;
  }

  async function read(pin) {
    var r = await fetch(BASE + '/api/state', { headers: headers(pin), cache: 'no-store' });
    if (!r.ok) throw new Error('state ' + r.status);
    return r.json();
  }
  function readJudge(pin) { return read(pin); }

  /* короткий опрос: спрашиваем только «изменилось ли с rev» */
  async function since(rev, pin) {
    var r = await fetch(BASE + '/api/state?since=' + (rev | 0), { headers: headers(pin), cache: 'no-store' });
    if (!r.ok) throw new Error('state ' + r.status);
    return r.json();   /* { rev } если не менялось, иначе { rev, state } */
  }

  async function write(pin, rev, state) {
    var r = await fetch(BASE + '/api/state', {
      method: 'POST',
      headers: headers(pin),
      body: JSON.stringify({ rev: rev, state: state })
    });
    if (r.status === 401) return { denied: true, reason: 'pin' };
    if (r.status === 409) { var c = await r.json().catch(function () { return {}; }); return { conflict: true, rev: c.rev, state: c.state }; }
    if (r.status === 429) { var t = await r.json().catch(function () { return {}; }); return { denied: true, reason: 'rate', retry: t.retry }; }
    if (!r.ok) { var e = await r.json().catch(function () { return {}; }); return { denied: true, reason: e.error || ('http_' + r.status) }; }
    var ok = await r.json();
    return { ok: true, rev: ok.rev };
  }

  /* проверить pin, не записывая ничего */
  async function checkPin(pin) {
    var r = await fetch(BASE + '/api/state', { method: 'POST', headers: headers(pin), body: JSON.stringify({ check: true }) });
    return r.status === 200;
  }

  /* Периодический опрос. onChange({rev, state}) зовётся только когда rev вырос.
     opts: { interval=2000, pin, onError } . Возвращает функцию остановки. */
  function poll(onChange, opts) {
    opts = opts || {};
    var interval = opts.interval || 2000;
    var rev = typeof opts.rev === 'number' ? opts.rev : -1;
    var stopped = false, timer = null;
    async function tick() {
      if (stopped) return;
      try {
        var d = await since(rev, opts.pin);
        if (d && typeof d.rev === 'number' && d.rev !== rev && d.state) {
          rev = d.rev;
          onChange({ rev: rev, state: d.state });
        } else if (d && typeof d.rev === 'number') {
          rev = d.rev;
        }
      } catch (e) {
        if (opts.onError) opts.onError(e);
      }
      if (!stopped) timer = setTimeout(tick, interval);
    }
    tick();
    return function stop() { stopped = true; if (timer) clearTimeout(timer); };
  }

  return { read: read, readJudge: readJudge, since: since, write: write, checkPin: checkPin, poll: poll };
});
