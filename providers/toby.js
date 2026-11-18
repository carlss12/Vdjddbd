/**
 * Toby — plugin de Nuvio para películas y series.
 *
 * Pide la lista de cuentas del servicio, se queda con las de bandera MX (FLAG), descarta solas las que no
 * responden, agrupa las que son del MISMO panel (mismas categorías => mismos ids), busca el id de TMDB en
 * una cuenta por panel y devuelve una tarjeta por cada cuenta del panel.
 *
 * Switches:
 *  DEBUG     -> tarjetas de diagnóstico (solo hosts, nunca usuario ni contraseña)
 *  FLAG      -> bandera que se acepta
 *  TMDB_KEY  -> clave de TMDB, solo para el respaldo por título
 */
"use strict";

var DEBUG = true;
var FLAG = "🇲🇽"; // 🇲🇽
var TMDB_KEY = ""; // pegar la misma clave de los otros plugins (123.js / animejara.js)

var BOOTSTRAP_URL = "http://vegetatvv2.duckdns.org/bootstrap.php";
var VERSION_CODE = "21";
var MAX_SERVERS = 24;
var T_SHORT = 8000;    // categorías / pruebas
var SCAN_BUDGET_MS = 30000; // tope por búsqueda al recorrer categorías
var SCAN_CONC = 6;          // categorías pedidas a la vez
var T_LIST = 25000;    // lista completa de películas o series
var HEDGE_MS = 8000;   // si la primera cuenta tarda, se lanza la siguiente del panel
var TTL_MS = 6 * 60 * 60 * 1000;
var MIN_SHARED = 8, MIN_SHARE = 0.8; // regla para decidir si dos cuentas son del mismo panel
var MOBILE_UA = "Mozilla/5.0 (Linux; Android 13; moto g82 5G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36";
var DIAG_URL = "http://127.0.0.1/diagnostico";

// ---------------------------------------------------------------- utilidades

var MEM = { ctx: null, maps: {}, inflight: {} };

function now() { return Date.now(); }
function errText(e) { return String((e && (e.message || e.code)) || e).slice(0, 80); }

function withTimeout(promise, ms, label) {
  return new Promise(function (resolve, reject) {
    var done = false;
    var t = setTimeout(function () { if (!done) { done = true; reject(new Error("tiempo agotado " + (label || ""))); } }, ms);
    promise.then(function (v) { if (!done) { done = true; clearTimeout(t); resolve(v); } },
      function (e) { if (!done) { done = true; clearTimeout(t); reject(e); } });
  });
}

function fetchText(url, headers, ms, label) {
  var p = fetch(url, { method: "GET", headers: headers || {} }).then(function (res) {
    return res.text().then(function (text) {
      var ct = "";
      try { ct = (res.headers && res.headers.get && res.headers.get("content-type")) || ""; } catch (e) {}
      return { ok: res.ok, status: res.status, text: text, ct: ct };
    });
  });
  return withTimeout(p, ms, label);
}

function fetchJson(url, headers, ms, label) {
  return fetchText(url, headers, ms, label).then(function (r) {
    var info = "HTTP " + r.status + " | " + (r.ct || "?") + " | " + r.text.length + " bytes | «" + r.text.slice(0, 100).replace(/\s+/g, " ") + "»";
    if (!r.ok) { var e1 = new Error("HTTP " + r.status); e1.info = info; throw e1; }
    var data;
    try { data = JSON.parse(r.text); } catch (e) { var e2 = new Error("respuesta no JSON"); e2.info = info; throw e2; }
    return { data: data, bytes: r.text.length };
  });
}

function getOrigin(url) { var m = /^(https?:\/\/[^\/\s?#]+)/i.exec(url || ""); return m ? m[1] : ""; }
function getHost(url) { return getOrigin(url).replace(/^https?:\/\//i, ""); }

function djb2(text) {
  var h = 5381;
  for (var i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
function fnv(s) {
  var h = 0x811c9dc5;
  for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function stripAccents(s) {
  try { return s.normalize("NFD").replace(/[̀-ͯ]/g, ""); } catch (e) { return s; }
}
function findKey(text) {
  return stripAccents(String(text || "")).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
// Quita etiquetas de idioma/año del final: "Matrix (LAT) (1999)" -> { name:"Matrix", year:1999 }
function cleanTitle(raw, yearField) {
  var name = String(raw || "").replace(/[\r\n\t]+/g, " ");
  var year = 0;
  for (var i = 0; i < 6; i++) {
    var before = name;
    name = name.replace(/^\s*\|[^|]{1,24}\|\s*/, "")
      .replace(/\s*\[[^\]]*\]\s*$/, "")
      .replace(/\s*\(\s*(LAT|CAST|ENG|SUB|DUAL|4K|UHD|FHD|HD)\s*\)\s*$/i, "");
    var y = /\s*\(\s*((?:19|20)\d\d)\s*\)\s*$/.exec(name);
    if (y) { if (!year) year = Number(y[1]); name = name.slice(0, y.index); }
    if (name === before) break;
  }
  if (/^(19|20)\d\d$/.test(String(yearField || "").trim())) year = Number(String(yearField).trim());
  return { name: name.trim(), year: year };
}

// ---------------------------------------------------------------- almacenamiento (si existe)

var STORE = null;      // { get(key)->Promise<string|null>, set(key,value)->Promise, kind }
var STORE_TRIED = false;

function initStore() {
  if (STORE_TRIED) return STORE;
  STORE_TRIED = true;
  try {
    if (typeof localStorage !== "undefined" && localStorage && typeof localStorage.getItem === "function") {
      localStorage.setItem("toby:probe", "1");
      if (localStorage.getItem("toby:probe") === "1") {
        STORE = {
          kind: "localStorage",
          get: function (k) { try { return Promise.resolve(localStorage.getItem(k)); } catch (e) { return Promise.resolve(null); } },
          set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} return Promise.resolve(); }
        };
        return STORE;
      }
    }
  } catch (e) {}
  try {
    var AS = require("@react-native-async-storage/async-storage");
    AS = (AS && AS.default) || AS;
    if (AS && typeof AS.getItem === "function") {
      STORE = {
        kind: "AsyncStorage",
        get: function (k) { return Promise.resolve(AS.getItem(k)).catch(function () { return null; }); },
        set: function (k, v) { return Promise.resolve(AS.setItem(k, v)).catch(function () {}); }
      };
      return STORE;
    }
  } catch (e) {}
  return null;
}

function storeGet(key) {
  var s = initStore();
  if (!s) return Promise.resolve(null);
  return s.get(key).then(function (raw) {
    if (!raw) return null;
    try { var o = JSON.parse(raw); return o && o.ts && now() - o.ts < TTL_MS ? o : null; } catch (e) { return null; }
  }).catch(function () { return null; });
}
function storeSet(key, obj) {
  var s = initStore();
  if (!s) return Promise.resolve();
  try {
    var text = JSON.stringify(obj);
    if (text.length > 4 * 1024 * 1024) return Promise.resolve(); // demasiado grande: solo en memoria
    return s.set(key, text);
  } catch (e) { return Promise.resolve(); }
}

// ---------------------------------------------------------------- bootstrap -> cuentas

var FLAG_RE = /\uD83C[\uDDE6-\uDDFF]\uD83C[\uDDE6-\uDDFF]/g;

function parseBootstrapText(text) {
  var out = [];
  var lines = String(text || "").split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line || line.charAt(0) === "#") continue;
    var m = /^(https?:\/\/\S+)\s*(.*)$/i.exec(line);
    if (!m) continue;
    var url = m[1], rest = (m[2] || "").trim();
    var u = /[?&](?:username|user)=([^&\s]+)/i.exec(url);
    var p = /[?&](?:password|pass)=([^&\s]+)/i.exec(url);
    var base = getOrigin(url);
    if (!u || !base) continue;
    var flags = rest.match(FLAG_RE) || [];
    out.push({ base: base, host: getHost(base), user: u[1], pass: p ? p[1] : "", flag: flags[0] || "", flags: flags, label: rest });
  }
  return out;
}

function bootstrapHeaders(code) {
  return { "X-Vegeta-Version-Code": String(code), "X-Vegeta-Servers-Direct": "1", "Cache-Control": "no-cache, no-store", "Pragma": "no-cache", "Accept": "application/json" };
}

function fetchBootstrap() {
  var code = VERSION_CODE;
  function attempt(n) {
    return fetchText(BOOTSTRAP_URL + "?v=" + now(), bootstrapHeaders(code), T_SHORT, "bootstrap").then(function (r) {
      var data = null;
      try { data = JSON.parse(r.text); } catch (e) { data = null; }
      if (!r.ok || !data || data.ok === false) {
        var want = data ? Math.max(Number(data.minimum_version_code) || 0, Number(data.latest_version_code) || 0) : 0;
        if (n === 0 && want > Number(code)) { code = String(want); return attempt(1); }
        throw new Error("bootstrap " + r.status);
      }
      var text = typeof data.servers_text === "string" ? data.servers_text : "";
      var list = parseBootstrapText(text);
      if (!list.length && typeof data.servers_url === "string" && data.servers_url) {
        return fetchText(data.servers_url, bootstrapHeaders(code), T_SHORT, "servers_url").then(function (r2) {
          return parseBootstrapText(r2.text);
        });
      }
      if (!list.length) {
        var want2 = Math.max(Number(data.minimum_version_code) || 0, Number(data.latest_version_code) || 0);
        if (n === 0 && want2 > Number(code)) { code = String(want2); return attempt(1); }
        throw new Error("bootstrap sin servidores");
      }
      return list;
    });
  }
  return attempt(0);
}

// ---------------------------------------------------------------- Xtream

function api(srv, action, extra, ms) {
  var q = "username=" + srv.user + "&password=" + srv.pass + (action ? "&action=" + action : "");
  if (extra) for (var k in extra) q += "&" + k + "=" + encodeURIComponent(extra[k]);
  var headers = { "Accept": "application/json,text/plain,*/*", "Cache-Control": "no-cache", "User-Agent": "Mozilla/5.0 (compatible; VegetaTVCache/2.0)" };
  return fetchJson(srv.base + "/player_api.php?" + q, headers, ms || T_SHORT, srv.host + " " + (action || "auth")).then(function (r) {
    var d = r.data;
    if (d && !Array.isArray(d) && typeof d === "object" && d.user_info && String(d.user_info.auth) === "0") throw new Error("cuenta inválida");
    if (d === null || typeof d !== "object") throw new Error("respuesta inválida");
    return r;
  }).catch(function (e) {
    if (e && e.info) {
      if (srv.user) e.info = e.info.split(srv.user).join("*");
      if (srv.pass) e.info = e.info.split(srv.pass).join("*");
    }
    throw e;
  });
}

// ---------------------------------------------------------------- paneles (dos cuentas son del mismo panel si comparten categorías)

function pairHashes(cats) {
  var set = {}, n = 0;
  for (var i = 0; i < cats.length; i++) {
    var c = cats[i] || {};
    var id = String(c.category_id || "");
    if (!id) continue;
    var h = fnv(id + "|" + findKey(c.category_name));
    if (!set[h]) { set[h] = 1; n++; }
  }
  return { set: set, size: n };
}
function linked(a, b) {
  var small = a.size <= b.size ? a : b, large = a.size <= b.size ? b : a;
  if (small.size < MIN_SHARED) return false;
  var n = 0;
  for (var h in small.set) if (large.set[h]) n++;
  return n >= MIN_SHARED && n >= MIN_SHARE * small.size;
}
// sets: [{srv, pairs}] -> [[srv, srv, ...], ...]  (las cuentas sueltas quedan en su propio grupo)
function groupByPanel(items) {
  var sorted = items.slice().sort(function (a, b) { return b.pairs.size - a.pairs.size; });
  var groups = [];
  for (var i = 0; i < sorted.length; i++) {
    var it = sorted[i];
    var hits = groups.filter(function (g) { return linked(it.pairs, g.anchor); });
    if (hits.length === 1) hits[0].members.push(it.srv);
    else groups.push({ anchor: it.pairs, members: [it.srv], cats: it.cats, ambiguous: hits.length > 1 });
  }
  return groups.map(function (g) { return { members: g.members, cats: g.cats }; });
}

// ---------------------------------------------------------------- contexto (cuentas vivas + paneles)

function loadContext(diag) {
  if (MEM.ctx && now() - MEM.ctx.ts < TTL_MS) { diag.ctxFrom = "memoria"; return Promise.resolve(MEM.ctx); }
  if (MEM.inflight.ctx) return MEM.inflight.ctx;
  var p = storeGet("toby:ctx:v1").then(function (saved) {
    if (saved && saved.groups && saved.groups.length) { diag.ctxFrom = "almacenamiento"; MEM.ctx = saved; return saved; }
    return buildContext(diag);
  }).then(function (ctx) { MEM.inflight.ctx = null; return ctx; }, function (e) { MEM.inflight.ctx = null; throw e; });
  MEM.inflight.ctx = p;
  return p;
}

function buildContext(diag) {
  diag.ctxFrom = "bootstrap";
  var t0 = now();
  return fetchBootstrap().then(function (all) {
    diag.bootMs = now() - t0;
    diag.total = all.length;
    diag.flags = {};
    all.forEach(function (s) { var f = s.flag || "(sin bandera)"; diag.flags[f] = (diag.flags[f] || 0) + 1; });
    var mine = all.filter(function (s) { return s.flags.indexOf(FLAG) >= 0; });
    // quita duplicados exactos y ordena: HTTPS primero
    var seen = {}, uniq = [];
    mine.forEach(function (s) { var k = s.base + "|" + s.user; if (!seen[k]) { seen[k] = 1; uniq.push(s); } });
    uniq.sort(function (a, b) { return (b.base.indexOf("https") === 0 ? 1 : 0) - (a.base.indexOf("https") === 0 ? 1 : 0); });
    uniq = uniq.slice(0, MAX_SERVERS);
    diag.mx = uniq.length;
    return Promise.all(uniq.map(function (srv) {
      var t1 = now();
      return api(srv, "get_vod_categories", null, T_SHORT).then(function (r) {
        if (!Array.isArray(r.data) || !r.data.length) throw new Error("sin categorías");
        return { srv: srv, pairs: pairHashes(r.data), ms: now() - t1, cats: r.data.map(function (c) { return { id: String(c.category_id), name: String(c.category_name || "") }; }) };
      }).catch(function (e) { diag.dead.push(srv.host + ": " + errText(e)); return null; });
    }));
  }).then(function (rows) {
    var alive = rows.filter(Boolean);
    diag.alive = alive.length;
    var groups = groupByPanel(alive);
    var ctx = {
      ts: now(),
      groups: groups.map(function (g) {
        return { id: djb2(g.members[0].base + "|" + g.members[0].user), members: g.members, cats: g.cats };
      })
    };
    diag.timesMs = alive.map(function (r) { return r.srv.host + " " + r.ms + "ms"; });
    MEM.ctx = ctx;
    return storeSet("toby:ctx:v1", ctx).then(function () { return ctx; });
  });
}

// ---------------------------------------------------------------- listas por panel -> mapa compacto

function addRef(t, tm, ref) {
  var cur = t[tm];
  if (!cur) { t[tm] = ref; return; }
  var arr = cur.split(",");
  if (arr.length < 3 && arr.indexOf(ref) < 0) t[tm] = cur + "," + ref;
}

// Mapa: { ts, t: { tmdb: "id.ext,id.ext" }, n: [[clave,año,"id.ext"], ...], count, withTmdb, ... }
function buildMap(items, isMovie) {
  var t = {}, n = [], withTmdb = 0;
  for (var i = 0; i < items.length; i++) {
    var it = items[i] || {};
    var id = String(isMovie ? it.stream_id : it.series_id || "");
    if (!id) continue;
    var ext = isMovie ? String(it.container_extension || "mp4") : "";
    var ref = isMovie ? id + "." + ext : id;
    var tm = parseInt(it.tmdb || it.tmdb_id, 10) || 0;
    if (tm > 0) { withTmdb++; addRef(t, tm, ref); }
    else if (n.length < 60000) {
      var c = cleanTitle(it.name || it.title, it.year || (it.release_date ? String(it.release_date).slice(0, 4) : ""));
      var key = findKey(c.name);
      if (key) n.push([key, c.year, ref]);
    }
  }
  return { ts: now(), t: t, n: n, count: items.length, withTmdb: withTmdb };
}

function mergeInto(map, add) {
  for (var k in add.t) add.t[k].split(",").forEach(function (r) { addRef(map.t, k, r); });
  if (map.n.length < 60000) map.n = map.n.concat(add.n.slice(0, 60000 - map.n.length));
  map.count += add.count;
  map.withTmdb += add.withTmdb;
}

function firstSuccess(factories, hedgeMs) {
  return new Promise(function (resolve, reject) {
    var failed = 0, finished = false, errors = [], infos = [];
    function start(i) {
      if (i >= factories.length || finished) return;
      var timer = setTimeout(function () { start(i + 1); }, hedgeMs);
      factories[i]().then(function (v) {
        clearTimeout(timer);
        if (!finished) { finished = true; resolve(v); }
      }, function (e) {
        clearTimeout(timer);
        errors.push(errText(e));
        if (e && e.info) infos.push(e.info);
        failed++;
        if (failed >= factories.length) {
          if (!finished) { finished = true; var err = new Error(errors.join(" | ")); err.info = infos[0] || ""; reject(err); }
        } else start(i + 1);
      });
    }
    start(0);
  });
}

var ADULT_RE = /xxx|adult|\+18|18\+|porn|sexo|er[oó]tic|hentai/i;
var LATIN_RE = /lat|mex|espa|spanish|dual|castel/i;

function categoryIds(group, isMovie) {
  function clean(list) {
    var ok = list.filter(function (c) { return !ADULT_RE.test(c.name); });
    ok.sort(function (a, b) { return (LATIN_RE.test(b.name) ? 1 : 0) - (LATIN_RE.test(a.name) ? 1 : 0); });
    return ok.map(function (c) { return c.id; });
  }
  if (isMovie) return Promise.resolve(clean(group.cats || []));
  var tries = group.members.slice(0, 3).map(function (srv) {
    return function () {
      return api(srv, "get_series_categories", null, T_SHORT).then(function (r) {
        if (!Array.isArray(r.data) || !r.data.length) throw new Error("sin categorías");
        return clean(r.data.map(function (c) { return { id: String(c.category_id), name: String(c.category_name || "") }; }));
      });
    };
  });
  return firstSuccess(tries, HEDGE_MS);
}

// Si el panel no entrega la lista completa se recorre por categorías (varias a la vez) hasta encontrar lo que se busca.
function scanCategories(group, isMovie, map, wantTmdb, gd) {
  var action = isMovie ? "get_vod_streams" : "get_series";
  var deadline = now() + SCAN_BUDGET_MS;
  var rr = 0;
  function one(catId) {
    var srv = group.members[rr++ % group.members.length];
    return api(srv, action, { category_id: catId }, T_SHORT * 2).then(function (r) {
      if (!Array.isArray(r.data)) throw new Error("lista inválida");
      mergeInto(map, buildMap(r.data, isMovie));
    }).catch(function (e) {
      map.catErrors = (map.catErrors || 0) + 1;
      if (!gd.scanErr) gd.scanErr = e.info || errText(e);
    });
  }
  function loop() {
    if (!map.pending.length || now() > deadline || (wantTmdb && map.t[String(wantTmdb)])) return Promise.resolve();
    var batch = map.pending.splice(0, SCAN_CONC);
    return Promise.all(batch.map(one)).then(loop);
  }
  return loop();
}

function scanMore(group, isMovie, map, wantTmdb, gd) {
  if (!map.scanning) {
    map.scanning = scanCategories(group, isMovie, map, wantTmdb, gd).then(function () { map.scanning = null; }, function () { map.scanning = null; });
  }
  return map.scanning;
}

function loadMap(group, isMovie, gd) {
  var key = "toby:map:" + (isMovie ? "m" : "s") + ":" + group.id;
  var mem = MEM.maps[key];
  if (mem && now() - mem.ts < TTL_MS) { gd.mapFrom = mem.partial ? "memoria (por categorías)" : "memoria"; return Promise.resolve(mem); }
  if (MEM.inflight[key]) { gd.mapFrom = "en curso"; return MEM.inflight[key]; }
  var action = isMovie ? "get_vod_streams" : "get_series";
  var tries = group.members.slice(0, 3).map(function (srv) {
    return function () {
      var t0 = now();
      return api(srv, action, null, T_LIST).then(function (r) {
        if (!Array.isArray(r.data)) throw new Error("lista inválida");
        var map = buildMap(r.data, isMovie);
        map.ms = now() - t0; map.bytes = r.bytes; map.host = srv.host;
        return map;
      });
    };
  });
  gd.mapFrom = "servidor";
  var p = firstSuccess(tries, HEDGE_MS).catch(function (e) {
    gd.listErr = e.info || errText(e);
    gd.mapFrom = "por categorías";
    return categoryIds(group, isMovie).then(function (ids) {
      if (!ids.length) throw new Error("sin categorías");
      return { ts: now(), t: {}, n: [], count: 0, withTmdb: 0, partial: true, pending: ids.slice(), total: ids.length };
    });
  }).then(function (map) {
    MEM.maps[key] = map;
    MEM.inflight[key] = null;
    return map;
  }, function (e) { MEM.inflight[key] = null; throw e; });
  MEM.inflight[key] = p;
  return p;
}

// ---------------------------------------------------------------- TMDB (respaldo por título)

function tmdbTitles(tmdbId, type) {
  if (!TMDB_KEY) return Promise.resolve(null);
  var kind = type === "movie" ? "movie" : "tv";
  function one(lang) {
    return fetchJson("https://api.themoviedb.org/3/" + kind + "/" + tmdbId + "?api_key=" + TMDB_KEY + "&language=" + lang, {}, T_SHORT, "tmdb")
      .then(function (r) { return r.data; }).catch(function () { return null; });
  }
  return Promise.all([one("es-MX"), one("en-US")]).then(function (arr) {
    var names = {}, year = 0;
    arr.forEach(function (d) {
      if (!d) return;
      [d.title, d.name, d.original_title, d.original_name].forEach(function (x) { var k = findKey(x); if (k) names[k] = 1; });
      var date = d.release_date || d.first_air_date || "";
      if (!year && /^\d{4}/.test(date)) year = Number(date.slice(0, 4));
    });
    return Object.keys(names).length ? { names: names, year: year } : null;
  });
}

function findRefs(map, tmdbId, titles) {
  var hit = map.t[String(tmdbId)];
  if (hit) return { refs: hit.split(","), by: "tmdb" };
  if (titles && map.n && map.n.length) {
    var out = [];
    for (var i = 0; i < map.n.length; i++) {
      var row = map.n[i];
      if (!titles.names[row[0]]) continue;
      if (titles.year && row[1] && Math.abs(row[1] - titles.year) > 1) continue;
      out.push(row[2]);
      if (out.length >= 3) break;
    }
    if (out.length) return { refs: out, by: "título" };
  }
  return { refs: [], by: "" };
}

// ---------------------------------------------------------------- series: episodio

function findEpisode(group, seriesId, season, episode, gdiag) {
  var tries = group.members.slice(0, 3).map(function (srv) {
    return function () {
      return api(srv, "get_series_info", { series_id: seriesId }, T_SHORT * 2).then(function (r) {
        var eps = r.data && r.data.episodes;
        if (!eps) throw new Error("sin episodios");
        var list = eps[String(season)] || [];
        if (!Array.isArray(list)) { var tmp = []; for (var k in list) tmp.push(list[k]); list = tmp; }
        for (var i = 0; i < list.length; i++) {
          if (parseInt(list[i].episode_num, 10) === Number(episode)) {
            var ext = String(list[i].container_extension || (list[i].info && list[i].info.container_extension) || "mp4");
            return { id: String(list[i].id), ext: ext };
          }
        }
        throw new Error("episodio no está");
      });
    };
  });
  return firstSuccess(tries, HEDGE_MS).catch(function (e) { gdiag.epErr = errText(e); return null; });
}

// ---------------------------------------------------------------- tarjetas

function card(srv, path, ext) {
  var isHls = ext === "m3u8";
  var fmt = isHls ? "HLS" : String(ext || "mp4").toUpperCase();
  var s = {
    name: "Toby",
    title: "",
    url: srv.base + path,
    quality: "📺 Toby · " + srv.host + " (" + fmt + ")\nHD | WEB-DL\n🇲🇽 LATINO",
    headers: { "User-Agent": MOBILE_UA }
  };
  if (isHls) s.type = "hls";
  return s;
}

function diagCard(title, lines) {
  return { name: "🔧 Toby", title: "", url: DIAG_URL, quality: title + "\n" + lines.join("\n"), headers: {} };
}

// ---------------------------------------------------------------- principal

function buildDiagCards(diag, groupsDiag) {
  var st = initStore();
  var head = [
    "contexto: " + diag.ctxFrom + (diag.bootMs ? " (" + diag.bootMs + "ms)" : ""),
    "líneas: " + (diag.total === undefined ? "(no se pidió esta vez)" : diag.total),
    "banderas: " + (diag.flags ? Object.keys(diag.flags).map(function (k) { return k + " " + diag.flags[k]; }).join(", ") : "-"),
    "MX: " + (diag.mx === undefined ? "-" : diag.mx) + " | vivas: " + (diag.alive === undefined ? "-" : diag.alive),
    "almacenamiento: " + (st ? st.kind : "no hay (solo memoria)")
  ];
  var out = [diagCard("ℹ️ Resumen", head)];
  if (diag.dead && diag.dead.length) out.push(diagCard("⚠ Cuentas caídas", diag.dead.slice(0, 12)));
  groupsDiag.forEach(function (g) {
    var lines = [
      g.hosts.join(", "),
      "lista: " + (g.mapFrom || "-") + (g.count !== undefined ? " | " + g.count + " títulos, " + g.withTmdb + " con tmdb" : ""),
      (g.listMs ? "bajada: " + g.listMs + "ms, " + g.listKB + " KB | " : "") + "total " + (g.ms || 0) + "ms"
    ];
    if (g.listErr) lines.push("lista completa falló: " + g.listErr);
    if (g.total !== undefined) lines.push("categorías revisadas: " + g.scanned + "/" + g.total + (g.catErrors ? " (" + g.catErrors + " con error)" : ""));
    if (g.scanErr) lines.push("error de categoría: " + g.scanErr);
    lines.push("resultado: " + g.result + (g.epErr ? " (" + g.epErr + ")" : ""));
    out.push(diagCard("🧩 Panel " + g.n + " (" + g.hosts.length + " cuentas)", lines));
  });
  return out;
}

function lookup(group, isMovie, tmdbId, wantTitles, gd) {
  return loadMap(group, isMovie, gd).then(function (map) {
    var found = findRefs(map, tmdbId, null);
    var more = (!found.refs.length && map.partial && map.pending && map.pending.length) ? scanMore(group, isMovie, map, tmdbId, gd) : Promise.resolve();
    return more.then(function () {
      found = findRefs(map, tmdbId, null);
      gd.count = map.count; gd.withTmdb = map.withTmdb; gd.listMs = map.ms; gd.listKB = map.bytes ? Math.round(map.bytes / 1024) : 0;
      if (map.partial) { gd.total = map.total; gd.scanned = map.total - map.pending.length; gd.catErrors = map.catErrors || 0; }
      if (!found.refs.length && map.n && map.n.length && TMDB_KEY) {
        return wantTitles().then(function (titles) { return findRefs(map, tmdbId, titles); });
      }
      return found;
    });
  });
}

exports.getStreams = function (tmdbId, type, season, episode) {
  if (type !== "movie" && type !== "tv") return Promise.resolve([]);
  var isMovie = type === "movie";
  var diag = { dead: [], ctxFrom: "" };
  var groupsDiag = [];
  var cards = [];
  return loadContext(diag).then(function (ctx) {
    if (!ctx.groups.length) return;
    var titlesP = null;
    var wantTitles = function () { if (!titlesP) titlesP = tmdbTitles(tmdbId, type); return titlesP; };
    return Promise.all(ctx.groups.map(function (group, gi) {
      var gd = { n: gi + 1, hosts: group.members.map(function (m) { return m.host; }), result: "" };
      groupsDiag.push(gd);
      var t0 = now();
      return lookup(group, isMovie, tmdbId, wantTitles, gd).then(function (found) {
        if (!found.refs.length) { gd.result = "no está en este panel"; return; }
        gd.result = "encontrada por " + found.by + " (" + found.refs.length + ")";
        if (isMovie) {
          found.refs.forEach(function (ref) {
            var parts = ref.split("."), id = parts[0], ext = parts[1] || "mp4";
            group.members.forEach(function (srv) { cards.push(card(srv, "/movie/" + srv.user + "/" + srv.pass + "/" + id + "." + ext, ext)); });
          });
          return;
        }
        return findEpisode(group, found.refs[0], season || 1, episode || 1, gd).then(function (ep) {
          if (!ep) { gd.result += "; episodio no encontrado"; return; }
          group.members.forEach(function (srv) { cards.push(card(srv, "/series/" + srv.user + "/" + srv.pass + "/" + ep.id + "." + ep.ext, ep.ext)); });
        });
      }).catch(function (e) { gd.result = "error: " + errText(e); }).then(function () { gd.ms = now() - t0; });
    }));
  }).catch(function (e) {
    diag.fatal = errText(e);
  }).then(function () {
    var result = cards;
    if (DEBUG) {
      var d = buildDiagCards(diag, groupsDiag);
      if (diag.fatal) d.unshift(diagCard("⚠ Error", [diag.fatal]));
      result = d.concat(cards);
    }
    return result;
  }).catch(function () { return []; });
};

// Solo para pruebas locales
exports.__test = { parseBootstrapText: parseBootstrapText, groupByPanel: groupByPanel, pairHashes: pairHashes, cleanTitle: cleanTitle, findKey: findKey, buildMap: buildMap, MEM: MEM };
