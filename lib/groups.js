/* Групповой этап MatchFlow OS — round-robin, «каждый с каждым».
   Чистая логика без DOM и без сети: одни и те же функции крутятся
   на сервере (валидация) и в браузере (экран групп + overlay).

   Форма данных живёт внутри состояния турнира:
     st.groups = {
       on: true,                 // этап включён
       advance: 2,               // сколько человек из группы проходит дальше
       race: 3,                  // до скольких побед идёт матч (0 = один сет, важен счёт)
       size: 4,                  // целевой размер группы (для авто-разбивки)
       live: { g:'g1', i:4 } | null,   // какой матч сейчас «на столе» (для overlay)
       groups: [
         { id:'g1', name:'Группа A', players:['p1','p2','p3'],
           matches:[ { a:'p1', b:'p2', sa:0, sb:0, done:false } ] }
       ]
     }

   Игроки берутся из общего st.players (тот же массив, что и у сетки).
   Матчи внутри группы хранятся явным списком пар — порядок пар и есть
   расписание круга (berger-раскладка, чтобы один человек не играл два подряд).
*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MFGroups = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- мелочь ---------- */
  var letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  function gid() { return 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }
  function clampInt(v, lo, hi, def) {
    var n = parseInt(v, 10);
    if (isNaN(n)) n = def;
    return Math.max(lo, Math.min(hi, n));
  }

  /* Расписание круга по кругу Бергера: каждый играет с каждым один раз,
     соседние туры стараются не ставить одного человека подряд.
     На вход — массив id игроков, на выход — массив пар [a,b]. */
  function roundRobinPairs(ids) {
    var a = ids.slice();
    if (a.length < 2) return [];
    var bye = null;
    if (a.length % 2) { bye = '__bye__'; a.push(bye); }
    var n = a.length, rounds = n - 1, half = n / 2;
    var order = a.slice(), out = [];
    for (var r = 0; r < rounds; r++) {
      for (var i = 0; i < half; i++) {
        var x = order[i], y = order[n - 1 - i];
        if (x !== bye && y !== bye) {
          /* чередуем сторону, чтобы «хозяин» не был всегда один и тот же */
          out.push(r % 2 ? [y, x] : [x, y]);
        }
      }
      /* вращаем всех, кроме первого */
      order.splice(1, 0, order.pop());
    }
    return out;
  }

  /* собрать объекты матчей из пар */
  function buildMatches(ids) {
    return roundRobinPairs(ids).map(function (p) {
      return { a: p[0], b: p[1], sa: 0, sb: 0, done: false };
    });
  }

  /* ---------- создание этапа ---------- */

  /* Разбить список игроков на группы по целевому размеру.
     Остаток раскидывается так, чтобы размеры отличались максимум на 1. */
  function splitIntoGroups(playerIds, targetSize) {
    var ids = playerIds.slice();
    var total = ids.length;
    if (total < 2) return [ids.slice()];
    var size = clampInt(targetSize, 2, 16, 4);
    var count = Math.max(1, Math.round(total / size));
    /* не даём группам схлопнуться меньше двух человек */
    while (count > 1 && total / count < 2) count--;
    var buckets = [];
    for (var i = 0; i < count; i++) buckets.push([]);
    /* раскладываем змейкой — ровнее по силе, если список уже отсортирован по рейтингу */
    var dir = 1, idx = 0;
    for (var j = 0; j < ids.length; j++) {
      buckets[idx].push(ids[j]);
      if (dir > 0 && idx === count - 1) dir = -1;
      else if (dir < 0 && idx === 0) dir = 1;
      else idx += dir;
    }
    return buckets;
  }

  /* Создать группы из набора игроков. opts: {size, advance, race, seedBy}
     seedBy — функция (pid)->число для сортировки перед змейкой (по рейтингу). */
  function makeStage(playerIds, opts) {
    opts = opts || {};
    var ids = playerIds.slice();
    if (typeof opts.seedBy === 'function') {
      ids.sort(function (x, y) { return opts.seedBy(y) - opts.seedBy(x); });
    }
    var buckets = splitIntoGroups(ids, opts.size || 4);
    var groups = buckets.map(function (members, i) {
      return {
        id: gid(),
        name: 'Группа ' + (letters[i] || (i + 1)),
        players: members.slice(),
        matches: buildMatches(members)
      };
    });
    return {
      on: true,
      advance: clampInt(opts.advance, 1, 8, 2),
      race: clampInt(opts.race, 0, 15, 0),
      size: clampInt(opts.size, 2, 16, 4),
      live: null,
      groups: groups
    };
  }

  /* ---------- правки на лету ---------- */

  function findGroup(stage, gid2) {
    if (!stage || !Array.isArray(stage.groups)) return null;
    return stage.groups.find(function (g) { return g.id === gid2; }) || null;
  }

  /* добавить игрока в группу и дописать его матчи со всеми, кого ещё не было */
  function addPlayerToGroup(group, pid) {
    if (!group || group.players.indexOf(pid) >= 0) return false;
    group.players.forEach(function (other) {
      group.matches.push({ a: pid, b: other, sa: 0, sb: 0, done: false });
    });
    group.players.push(pid);
    return true;
  }

  /* убрать игрока из группы вместе со всеми его матчами */
  function removePlayerFromGroup(group, pid) {
    if (!group) return false;
    var before = group.players.length;
    group.players = group.players.filter(function (x) { return x !== pid; });
    group.matches = group.matches.filter(function (m) { return m.a !== pid && m.b !== pid; });
    return group.players.length !== before;
  }

  /* ---------- результат матча ---------- */

  /* матч считается сыгранным, если судья нажал «готово».
     race>0 — победа по достижению race партий; race==0 — просто по большему счёту. */
  function matchWinner(stage, m) {
    if (!m || !m.done) return null;
    if (m.sa === m.sb) return null;           /* ничьих в пирамиде не бывает, но на всякий */
    return m.sa > m.sb ? m.a : m.b;
  }
  function matchReady(stage, m) {
    if (!m) return false;
    var race = (stage && stage.race) | 0;
    if (race > 0) return m.sa >= race || m.sb >= race;
    return (m.sa | 0) !== (m.sb | 0);
  }

  /* ---------- таблица группы ---------- */

  /* Standings одной группы: победы, поражения, разница партий, личная встреча.
     Порядок сортировки: больше побед → лучше разница партий → больше забитых →
     победа в очной встрече → имя (стабильность). Возвращает массив строк
     [{pid, w, l, gf, ga, diff, played, adv}], отсортированный, с проставленным adv. */
  function standings(stage, group) {
    var rows = {};
    group.players.forEach(function (pid) {
      rows[pid] = { pid: pid, w: 0, l: 0, gf: 0, ga: 0, diff: 0, played: 0, adv: false };
    });
    /* для очной встречи — кто кого обыграл */
    var h2h = {};
    group.matches.forEach(function (m) {
      if (!m.done || !rows[m.a] || !rows[m.b]) return;
      rows[m.a].gf += m.sa | 0; rows[m.a].ga += m.sb | 0;
      rows[m.b].gf += m.sb | 0; rows[m.b].ga += m.sa | 0;
      rows[m.a].played++; rows[m.b].played++;
      var w = matchWinner(stage, m);
      if (w) {
        var l = w === m.a ? m.b : m.a;
        rows[w].w++; rows[l].l++;
        h2h[w + '>' + l] = true;
      }
    });
    var arr = group.players.map(function (pid) {
      var r = rows[pid]; r.diff = r.gf - r.ga; return r;
    });
    arr.sort(function (A, B) {
      if (B.w !== A.w) return B.w - A.w;
      if (B.diff !== A.diff) return B.diff - A.diff;
      if (B.gf !== A.gf) return B.gf - A.gf;
      if (h2h[A.pid + '>' + B.pid]) return -1;
      if (h2h[B.pid + '>' + A.pid]) return 1;
      return 0;
    });
    var adv = clampInt(stage.advance, 1, 8, 2);
    arr.forEach(function (r, i) { r.adv = i < adv; });
    return arr;
  }

  /* сколько матчей в группе сыграно / всего */
  function groupProgress(group) {
    var done = 0;
    group.matches.forEach(function (m) { if (m.done) done++; });
    return { done: done, total: group.matches.length };
  }
  function groupFinished(group) {
    var p = groupProgress(group);
    return p.total > 0 && p.done === p.total;
  }
  function stageFinished(stage) {
    return !!stage && Array.isArray(stage.groups) && stage.groups.length > 0 &&
      stage.groups.every(groupFinished);
  }

  /* Прошедшие дальше: по advance из каждой группы.
     Возвращает плоский список {pid, group, groupName, rank} в порядке посева:
     сначала все первые места групп, потом все вторые, и т.д. — так удобнее
     разводить по сетке (первые не встречаются рано). */
  function qualifiers(stage) {
    if (!stage || !Array.isArray(stage.groups)) return [];
    var adv = clampInt(stage.advance, 1, 8, 2);
    var byRank = [];
    for (var r = 0; r < adv; r++) byRank.push([]);
    stage.groups.forEach(function (g) {
      var s = standings(stage, g);
      for (var i = 0; i < adv && i < s.length; i++) {
        byRank[i].push({ pid: s[i].pid, group: g.id, groupName: g.name, rank: i + 1 });
      }
    });
    var out = [];
    byRank.forEach(function (bucket) { bucket.forEach(function (q) { out.push(q); }); });
    return out;
  }

  /* ---------- текущий матч для overlay ---------- */

  /* матч, помеченный «на табло» (stage.live), в удобном для рендера виде */
  function liveMatch(stage) {
    if (!stage || !stage.live) return null;
    var g = findGroup(stage, stage.live.g);
    if (!g) return null;
    var m = g.matches[stage.live.i | 0];
    if (!m) return null;
    return { group: g, match: m, index: stage.live.i | 0 };
  }

  /* ---------- проверка целостности (сервер) ---------- */

  /* лёгкая валидация формы stage перед записью в базу.
     Не бизнес-логика, а защита от мусора: ссылки игроков существуют,
     счёт — числа, нет дублей матчей. Возвращает true/false. */
  function validate(stage, playerIds) {
    if (!stage || typeof stage !== 'object') return false;
    if (!Array.isArray(stage.groups)) return false;
    var known = {};
    (playerIds || []).forEach(function (p) { known[p] = true; });
    for (var gi = 0; gi < stage.groups.length; gi++) {
      var g = stage.groups[gi];
      if (!g || typeof g.id !== 'string') return false;
      if (!Array.isArray(g.players) || !Array.isArray(g.matches)) return false;
      for (var pi = 0; pi < g.players.length; pi++) {
        if (!known[g.players[pi]]) return false;
      }
      for (var mi = 0; mi < g.matches.length; mi++) {
        var m = g.matches[mi];
        if (!m || typeof m !== 'object') return false;
        if (g.players.indexOf(m.a) < 0 || g.players.indexOf(m.b) < 0) return false;
        if (typeof m.sa !== 'number' || typeof m.sb !== 'number') return false;
        if (m.sa < 0 || m.sb < 0 || m.sa > 99 || m.sb > 99) return false;
      }
    }
    return true;
  }

  return {
    gid: gid,
    roundRobinPairs: roundRobinPairs,
    buildMatches: buildMatches,
    splitIntoGroups: splitIntoGroups,
    makeStage: makeStage,
    findGroup: findGroup,
    addPlayerToGroup: addPlayerToGroup,
    removePlayerFromGroup: removePlayerFromGroup,
    matchWinner: matchWinner,
    matchReady: matchReady,
    standings: standings,
    groupProgress: groupProgress,
    groupFinished: groupFinished,
    stageFinished: stageFinished,
    qualifiers: qualifiers,
    liveMatch: liveMatch,
    validate: validate
  };
});
