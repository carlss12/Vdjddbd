/*
 * pelisjuanita.js - plugin de TV en vivo (VERSION DE DIAGNOSTICO pj-diag-4)
 *
 * tmdbId "cbl-<slug>" (llega como "kitsu:cbl-hbo-2"), type "tv".
 *
 * Rutas que resuelve (segun la tabla CHANNELS):
 *   m3u:    servers/m3u.php?id=<NOMBRE>  -> redirige a f.html?get=<base64>.
 *           El "get" decodifica a un proxy (.../proxy/ssl/?url=http://IP:PUERTO/.../index.m3u8?hls).
 *   get:    valor "get" de f.html (base64 o URL) tomado de la lista del sitio.
 *   golden: servers/golden.php?id=<ID>  -> DASH + ClearKey (url, ck_keyid, ck_key). SOLO diagnostico.
 *
 * Hallazgos (pj-diag-2/3): la pagina pelisjuanita.com/tv/<slug> da 403 o pantalla de acceso desde el plugin,
 * por eso se usa la tabla CHANNELS en vez de leer la pagina. f.html solo es un envoltorio: se decodifica "get".
 * Sin extractor: ytplayer (YouTube), zapster, hzplayer, jwplayer, msvhub drm.php.
 *
 * NO PROBADO contra el sitio real desde mi lado: ver diagnostico en pantalla.
 */
if (typeof globalThis.setTimeout !== "function") {
  globalThis.setTimeout = function () { return 1; };
  globalThis.clearTimeout = function () {};
}

var LABEL = "Lat 3";
var PREFIX = "cbl-";
var VERSION = "pj-diag-4";
var DEBUG = true;
var BASE = "https://pelisjuanita.com/tv/";
var SITE = "https://pelisjuanita.com/";
var SITE_ORIGIN = "https://pelisjuanita.com";
var REFERER = "https://pelisjuanita.com/tv/";
var TEST_SLUG = "hbo-2"; // en este canal ademas se prueba golden.php de DSports

var SHORT_FULL = 3000;
var CTX = 200;
var MAX_SNIPS = 14;
var MAX_SNIP_LEN = 1500;

var UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";

// slug de pelisjuanita -> datos del canal
var CHANNELS = {
  "hbo-2": { name: "HBO 2", m3u: ["HBO2 HD"] },
  "hbo-family": { name: "HBO Family", m3u: ["HBO Family HD"] },
  "cinecanal": {
    name: "Cinecanal", m3u: ["CINECANAL HD"],
    get: ["aHR0cHM6Ly9mdWxsLW9ubGluZS54eXovcHJveHkvc3NsLz91cmw9aHR0cDovLzE5MC42MS4xMDEuMTE6NzA1MC9wbGF5L2EwN2EvaW5kZXgubTN1OD9obHMg"]
  },
  "xtrema-cartoons": {
    name: "Xtrema Cartoons",
    get: ["aHR0cHM6Ly9zdG12Ni52b3h0dmhkLmNvbS5ici94dHJlbWFjYXJ0b29ucy94dHJlbWFjYXJ0b29ucy9wbGF5bGlzdC5tM3U4"]
  },
  "directv-sports": { name: "DSports", golden: ["dsportsco"] },
  "directv-plus": { name: "DSports +", golden: ["dsportsplus"] },
  "directv-sports-2": { name: "DSports 2", golden: ["dsports2"] }
};

function slugFromId(id) {
  var t = String(id || "").toLowerCase(), i = t.indexOf(PREFIX);
  return i < 0 ? "" : t.slice(i + PREFIX.length);
}

var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function b64val(ch) { return ch ? B64.indexOf(ch) : -1; }
function b64decode(input) {
  var s = String(input || "").replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+\/]/g, "");
  var out = "", i = 0, a, b, c, d;
  while (i < s.length) {
    a = b64val(s.charAt(i++)); b = b64val(s.charAt(i++)); c = b64val(s.charAt(i++)); d = b64val(s.charAt(i++));
    if (a < 0 || b < 0) break;
    out += String.fromCharCode((a << 2) | (b >> 4));
    if (c >= 0) out += String.fromCharCode(((b & 15) << 4) | (c >> 2));
    if (d >= 0) out += String.fromCharCode(((c & 3) << 6) | d);
  }
  return out;
}

// "get" de f.html: URL directa o base64 (a veces con escapes %2F, %3D)
function decodeGet(g) {
  g = String(g || "");
  try { g = decodeURIComponent(g); } catch (e) {}
  g = g.replace(/^\s+|\s+$/g, "");
  if (/^https?:\/\//i.test(g)) return g;
  var d = b64decode(g).replace(/^\s+|\s+$/g, "");
  return /^https?:\/\//i.test(d) ? d : "";
}

// Si es un proxy .../proxy/...?url=<destino>, devuelve el destino
function innerUrl(u) {
  if (!/\/proxy\//i.test(u)) return "";
  var m = /[?&]url=(.+)$/.exec(u);
  if (!m) return "";
  var v = m[1];
  try { v = decodeURIComponent(v); } catch (e) {}
  v = v.replace(/^\s+|\s+$/g, "");
  return /^https?:\/\//i.test(v) ? v : "";
}

function withTimeout(p, ms, label) {
  return new Promise(function (resolve, reject) {
    var t = setTimeout(function () { reject(new Error(label + " tarda demasiado")); }, ms);
    p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
  });
}

async function get(url, headers, ms) {
  var h = { "User-Agent": UA, "Accept-Language": "es-419,es;q=0.9" };
  for (var k in headers) h[k] = headers[k];
  var r = await withTimeout(fetch(url, { headers: h }), ms, "peticion");
  var text = await r.text();
  return { status: r.status, ok: r.ok, finalUrl: r.url || "", text: text };
}

var KEYS = "\\.m3u8|\\.mpd|\\.mp4|ck_key|keyid|playbackURL|<iframe|<source|\\bfile\\s*:|eval\\(|atob\\(|var\\s+url\\b|\"src\"\\s*:|hls\\d?\\s*[:=]";
function dump(text) {
  text = String(text || "");
  if (text.length <= SHORT_FULL) return text;
  var re = new RegExp(KEYS, "ig"), ranges = [], m, hits = 0, more = false;
  while ((m = re.exec(text)) !== null) {
    if (!m[0].length) { re.lastIndex++; continue; }
    hits++;
    var a = Math.max(0, m.index - CTX), b = Math.min(text.length, m.index + m[0].length + CTX);
    var last = ranges[ranges.length - 1];
    if (last && a <= last[1]) { last[1] = Math.max(last[1], b); }
    else {
      if (ranges.length >= MAX_SNIPS) { more = true; break; }
      ranges.push([a, b]);
    }
  }
  if (!ranges.length) {
    return "[" + text.length + " caracteres, NINGUNA palabra clave encontrada]\n--- inicio ---\n" +
      text.slice(0, 1500) + "\n--- final ---\n" + text.slice(-500);
  }
  var out = "[" + text.length + " caracteres; " + ranges.length + " fragmentos con palabras clave, " + hits + " coincidencias" +
    (more ? "; HAY MAS no mostradas" : "") + "]\n";
  ranges.forEach(function (r, i) {
    var piece = text.slice(r[0], r[1]).replace(/\s+/g, " ");
    if (piece.length > MAX_SNIP_LEN) piece = piece.slice(0, MAX_SNIP_LEN) + " [...]";
    out += "\n--- fragmento " + (i + 1) + " (pos " + r[0] + ") ---\n" + piece + "\n";
  });
  return out;
}

function card(title, body) {
  return { name: LABEL, title: "🛠 " + title + " (no reproducir)", url: "https://diagnostico.invalid/" + VERSION, quality: body, headers: {} };
}

function errMsg(e) { return e && e.message ? e.message : String(e); }

// Comprueba si una URL es un HLS vivo (#EXTM3U), con y sin Referer del sitio.
async function checkHls(url) {
  var variants = [
    { n: "con Referer del sitio", h: { "Referer": SITE, "Origin": SITE_ORIGIN } },
    { n: "sin Referer", h: {} }
  ];
  var res = await Promise.all(variants.map(function (v) {
    return get(url, v.h, 8000).then(function (r) {
      var isM3u = r.text.replace(/^\s+/, "").indexOf("#EXTM3U") === 0;
      return { n: v.n, h: v.h, status: r.status, m3u: isM3u, head: r.text.slice(0, 160).replace(/\s+/g, " "), len: r.text.length };
    }, function (e) { return { n: v.n, h: v.h, err: errMsg(e) }; });
  }));
  return res;
}

function headersFor(url, checks) {
  var h = { "User-Agent": UA };
  var withRef = checks[0] && checks[0].m3u, noRef = checks[1] && checks[1].m3u;
  if (withRef || !noRef) { h["Referer"] = SITE; h["Origin"] = SITE_ORIGIN; }
  return h;
}

// De un destino (URL ya decodificada) arma los candidatos y los verifica.
async function processTarget(chName, origen, target) {
  var inner = innerUrl(target);
  var cands = inner ? [{ k: "Proxy", u: target }, { k: "Directo", u: inner }] : [{ k: "Directo", u: target }];
  var log = "Origen: " + origen + "\nDestino: " + target + "\n";
  var streams = [];
  var all = await Promise.all(cands.map(function (c) { return checkHls(c.u).then(function (r) { return { c: c, r: r }; }); }));
  all.forEach(function (x, idx) {
    log += "- " + x.c.k + ": " + x.c.u + "\n";
    var ok = false;
    x.r.forEach(function (c) {
      if (c.err) { log += "    " + c.n + ": FALLO " + c.err + "\n"; return; }
      log += "    " + c.n + ": HTTP " + c.status + ", largo " + c.len + ", #EXTM3U: " + (c.m3u ? "SI" : "NO") + "\n";
      if (!c.m3u && c.head) log += "      inicio: " + c.head + "\n";
      if (c.m3u) ok = true;
    });
    streams.push({
      name: LABEL,
      title: chName + " · " + x.c.k + (inner ? " " + (idx + 1) : ""),
      url: x.c.u,
      quality: "📺 " + x.c.k + " (HLS)\nHD | " + (ok ? "verificado" : "SIN VERIFICAR") + "\nLat",
      headers: headersFor(x.c.u, x.r),
      type: "hls",
      _ok: ok
    });
  });
  return { log: log, streams: streams };
}

async function resolveM3u(chName, id) {
  var log = "m3u.php?id=" + id + "\n";
  var url = BASE + "servers/m3u.php?id=" + encodeURIComponent(id);
  var tries = [{}, { "Referer": REFERER }];
  for (var i = 0; i < tries.length; i++) {
    try {
      var r = await get(url, tries[i], 9000);
      log += "  intento " + (i + 1) + ": HTTP " + r.status + ", URL final: " + r.finalUrl + "\n";
      var m = /[?&]get=([^&#]*)/.exec(r.finalUrl);
      if (m) {
        var d = decodeGet(m[1]);
        if (d) {
          var p = await processTarget(chName, "m3u.php?id=" + id, d);
          return { log: log + p.log, streams: p.streams, cards: [] };
        }
        log += "  no pude decodificar el get\n";
      } else {
        log += "  la URL final no trae get=\n";
        if (r.text.length) log += dump(r.text) + "\n";
      }
    } catch (e) { log += "  intento " + (i + 1) + ": FALLO " + errMsg(e) + "\n"; }
  }
  return { log: log, streams: [], cards: [] };
}

async function resolveGetValue(chName, g, idx) {
  var d = decodeGet(g);
  if (!d) return { log: "get #" + (idx + 1) + ": no pude decodificar\n", streams: [], cards: [] };
  var p = await processTarget(chName, "get #" + (idx + 1) + " (lista del sitio)", d);
  return { log: p.log, streams: p.streams, cards: [] };
}

function pickVar(html, name) {
  var re = new RegExp("(?:var|let|const)\\s+" + name + "\\s*=\\s*[\"']([^\"']+)[\"']");
  var m = re.exec(html);
  return m ? m[1] : "";
}

// golden.php: solo diagnostico (DASH + ClearKey). No se devuelve como stream.
async function goldenInfo(chName, id) {
  var url = BASE + "servers/golden.php?id=" + encodeURIComponent(id);
  var t = "golden.php?id=" + id + "\n";
  try {
    var r = await get(url, { "Referer": REFERER, "Sec-Fetch-Dest": "iframe" }, 9000);
    t += "HTTP " + r.status + ", largo " + r.text.length + "\n";
    var mpd = pickVar(r.text, "url"), kid = pickVar(r.text, "ck_keyid"), key = pickVar(r.text, "ck_key");
    t += "url: " + (mpd || "NO ENCONTRADA") + "\nck_keyid: " + (kid || "NO ENCONTRADO") + "\nck_key: " + (key || "NO ENCONTRADO") + "\n";
    if (!mpd) { t += "\n" + dump(r.text); }
    else {
      try {
        var m = await get(mpd, {}, 8000);
        t += "\nMPD: HTTP " + m.status + ", largo " + m.text.length + ", contiene <MPD: " + (/<MPD/i.test(m.text) ? "SI" : "NO") + "\n";
        if (!/<MPD/i.test(m.text)) t += "inicio: " + m.text.slice(0, 160).replace(/\s+/g, " ") + "\n";
      } catch (e) { t += "\nMPD: FALLO " + errMsg(e) + "\n"; }
    }
  } catch (e) { t += "FALLO " + errMsg(e) + "\n"; }
  t += "\nNo se devuelve como stream: falta saber si Nuvio reproduce DASH + ClearKey.\n";
  return { log: "", streams: [], cards: [card("GOLDEN " + chName + " (" + id + ")", "VERSION: " + VERSION + "\n" + t)] };
}

async function getStreams(tmdbId, type, season, episode) {
  if (type !== "tv" || !tmdbId) return [];
  var slug = slugFromId(tmdbId);
  if (!slug) return [];
  var ch = CHANNELS[slug];
  if (!ch) {
    return DEBUG ? [card("CANAL SIN CONFIGURAR", "VERSION: " + VERSION + "\ntmdbId: " + tmdbId + "\nslug: " + slug +
      "\nEste slug no esta en la tabla CHANNELS del plugin.")] : [];
  }

  var jobs = [];
  (ch.m3u || []).forEach(function (id) { jobs.push(resolveM3u(ch.name, id)); });
  (ch.get || []).forEach(function (g, i) { jobs.push(resolveGetValue(ch.name, g, i)); });
  var golden = (ch.golden || []).slice();
  if (slug === TEST_SLUG) golden.push("dsportsco");
  golden.forEach(function (id) { jobs.push(goldenInfo(ch.name, id)); });

  var res = await Promise.all(jobs.map(function (j) {
    return j.then(function (x) { return x; }, function (e) { return { log: "FALLO inesperado: " + errMsg(e) + "\n", streams: [], cards: [] }; });
  }));

  var streams = [], seen = {}, log = "", cards = [];
  res.forEach(function (x) {
    log += x.log + "\n";
    cards = cards.concat(x.cards);
    x.streams.forEach(function (s) {
      if (seen[s.url]) return;
      seen[s.url] = true;
      streams.push(s);
    });
  });
  // quita la marca interna
  streams.sort(function (a, b) { return (b._ok ? 1 : 0) - (a._ok ? 1 : 0); });
  streams.forEach(function (s) { delete s._ok; });

  var diag = [card("DIAGNOSTICO " + slug, "VERSION: " + VERSION + "\ntmdbId: " + tmdbId + "\nslug: " + slug +
    "\nCanal: " + ch.name + "\nStreams devueltos: " + streams.length + "\n\n" + log)].concat(cards);

  if (!streams.length) return diag;
  return DEBUG ? streams.concat(diag) : streams;
}

exports.getStreams = getStreams;
exports._slugFromId = slugFromId;
exports._b64decode = b64decode;
exports._decodeGet = decodeGet;
exports._innerUrl = innerUrl;
exports._dump = dump;
