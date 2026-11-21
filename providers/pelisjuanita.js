/*
 * pelisjuanita.js - plugin de TV en vivo (VERSION DE DIAGNOSTICO)
 *
 * Flujo:
 *   tmdbId "cbl-<slug>" (llega como "kitsu:cbl-hbo-2")
 *   -> https://pelisjuanita.com/tv/<slug>  (lee el onclick del canal con su lista de servidores)
 *   -> pide cada servidor con Referer de pelisjuanita
 *   -> devuelve tarjetas "DIAGNOSTICO" con lo que respondio cada uno (aun no reproduce nada)
 *
 * MODO PRUEBA (TEST_SLUG): cuando el canal pedido es TEST_SLUG (hbo-2), ademas se prueban
 * sitios fijos de otros canales que no estan en el addon (golden.php de DSports y Xtrema Cartoons).
 * Probado en pj-diag-2: el .m3u8 de Xtrema abre sin Referer (200, #EXTM3U); golden.php abre desde el plugin (200).
 *
 * Tipos de servidor vistos en la pagina (todavia sin extractor):
 *   f.html?get=<base64|url>   HLS (a veces con proxy full-online.xyz)
 *   servers/golden.php?id=    DASH + ClearKey (variables url, ck_keyid, ck_key)
 *   servers/m3u.php?id=       por investigar (HBO, Cinecanal)
 *   servers/zapster.php, hzplayer.php, jwplayer.php, msvhub.sbs/drm.php: por investigar
 *   ytplayer.html (YouTube): probablemente no sirve
 */
if (typeof globalThis.setTimeout !== "function") {
  globalThis.setTimeout = function () { return 1; };
  globalThis.clearTimeout = function () {};
}

var LABEL = "Lat 3";
var PREFIX = "cbl-";
var VERSION = "pj-diag-3";
var BASE = "https://pelisjuanita.com/tv/";
var REFERER = "https://pelisjuanita.com/tv/";
var MAX_SERVERS = 6;
var SHORT_FULL = 3000;   // respuestas de hasta este largo se muestran completas
var CTX = 200;           // caracteres alrededor de cada palabra clave
var MAX_SNIPS = 14;      // maximo de fragmentos por respuesta
var MAX_SNIP_LEN = 1500; // largo maximo de cada fragmento
var TEST_SLUG = "hbo-2";

var UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
var UA_DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

var XTREMA_B64 = "aHR0cHM6Ly9zdG12Ni52b3h0dmhkLmNvbS5ici94dHJlbWFjYXJ0b29ucy94dHJlbWFjYXJ0b29ucy9wbGF5bGlzdC5tM3U4";

// Juegos de cabeceras para pedir la pagina del canal (para averiguar por que da 403)
var PAGE_ATTEMPTS = [
  { name: "A: Referer inicio.php, UA movil", h: { "Referer": "https://pelisjuanita.com/inicio.php" } },
  { name: "B: sin Referer, UA movil", h: {} },
  { name: "C: cabeceras de navegacion completas", h: {
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Upgrade-Insecure-Requests": "1", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "same-origin", "Referer": "https://pelisjuanita.com/inicio.php" } },
  { name: "D: UA de escritorio, sin Referer", h: { "User-Agent": UA_DESKTOP } }
];

// Pruebas fijas (solo con TEST_SLUG)
var FIXED_PROBES = [
  { name: "m3u.php HBO2 HD (Referer tv/)", url: BASE + "servers/m3u.php?id=HBO2%20HD", h: { "Referer": REFERER, "Sec-Fetch-Dest": "iframe" } },
  { name: "m3u.php HBO2 HD (sin Referer)", url: BASE + "servers/m3u.php?id=HBO2%20HD", h: {} },
  { name: "golden.php dsportsco (Referer tv/)", url: BASE + "servers/golden.php?id=dsportsco", h: { "Referer": REFERER, "Sec-Fetch-Dest": "iframe" } },
  { name: "Xtrema f.html?get=<base64> (Referer tv/)", url: BASE + "f.html?get=" + XTREMA_B64, h: { "Referer": REFERER, "Sec-Fetch-Dest": "iframe" } }
];

function slugFromId(id) {
  var t = String(id || "").toLowerCase(), i = t.indexOf(PREFIX);
  return i < 0 ? "" : t.slice(i + PREFIX.length);
}

function decodeEntities(s) {
  return String(s)
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

// Busca el item con data-slug="<slug>" y devuelve su lista de servidores (o null si no lo encuentra)
function parseServers(html, slug) {
  var esc = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  var re = new RegExp('data-slug="' + esc + '"[^>]*?onclick="cambiarOpcion\\(this,\\s*([^"]*)\\)"');
  var m = re.exec(html);
  if (!m) return null;
  try {
    var arr = JSON.parse(decodeEntities(m[1]));
    return Array.isArray(arr) ? arr : null;
  } catch (e) { return null; }
}

function resolveUrl(u) {
  u = String(u || "").replace(/^\s+|\s+$/g, "");
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  if (u.indexOf("//") === 0) return "https:" + u;
  return BASE + u.replace(/^\/+/, "");
}

function withTimeout(p, ms, label) {
  return new Promise(function (resolve, reject) {
    var t = setTimeout(function () { reject(new Error(label + " tarda demasiado")); }, ms);
    p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
  });
}

function hdrInfo(r) {
  var o = "";
  try {
    ["content-type", "server", "location", "cf-ray", "cf-mitigated", "set-cookie"].forEach(function (k) {
      var v = r.headers && r.headers.get && r.headers.get(k);
      if (v) o += "  " + k + ": " + v + "\n";
    });
  } catch (e) {}
  return o;
}

async function get(url, headers, ms) {
  var h = { "User-Agent": UA, "Accept-Language": "es-419,es;q=0.9" };
  for (var k in headers) h[k] = headers[k];
  var r = await withTimeout(fetch(url, { headers: h }), ms, "peticion");
  var text = await r.text();
  return { status: r.status, ok: r.ok, finalUrl: r.url || "", text: text, hdr: hdrInfo(r) };
}

var KEYS = "\\.m3u8|\\.mpd|\\.mp4|ck_key|keyid|playbackURL|<iframe|<source|\\bfile\\s*:|eval\\(|atob\\(|var\\s+url\\b|\"src\"\\s*:|hls\\d?\\s*[:=]";

// Respuesta corta: completa. Respuesta larga: solo fragmentos alrededor de palabras clave.
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
  return {
    name: LABEL,
    title: "🛠 " + title + " (no reproducir)",
    url: "https://diagnostico.invalid/" + VERSION,
    quality: body,
    headers: {}
  };
}

async function probe(label, url, headers) {
  var head = "VERSION: " + VERSION + "\n" + label + "\nURL pedida: " + url + "\n";
  try {
    var r = await get(url, headers, 9000);
    return card(label,
      head + "HTTP: " + r.status + "\nURL final: " + r.finalUrl + "\nLargo: " + r.text.length +
      "\nCabeceras:\n" + (r.hdr || "  (ninguna legible)\n") +
      "\n----- RESPUESTA -----\n" + dump(r.text));
  } catch (e) {
    return card(label, head + "FALLO: " + (e && e.message ? e.message : e));
  }
}

// Pide la pagina del canal con cada juego de cabeceras. Devuelve texto resumen y el HTML si alguno dio 200.
async function pageAttempts(pageUrl, slug) {
  var lines = "Pagina: " + pageUrl + "\n\nIntentos:\n";
  var results = await Promise.all(PAGE_ATTEMPTS.map(function (a) {
    return get(pageUrl, a.h, 9000).then(function (r) { return { a: a, r: r }; },
      function (e) { return { a: a, err: (e && e.message ? e.message : String(e)) }; });
  }));
  var html = "", servers = null, winner = "";
  results.forEach(function (x) {
    if (x.err) { lines += "- " + x.a.name + " -> FALLO: " + x.err + "\n"; return; }
    lines += "- " + x.a.name + " -> HTTP " + x.r.status + ", largo " + x.r.text.length + "\n" + x.r.hdr;
    if (!servers && x.r.status === 200 && x.r.text.length > 0) {
      var s = parseServers(x.r.text, slug);
      if (s) { servers = s; winner = x.a.name; }
      if (!html) html = x.r.text;
    }
  });
  if (servers) {
    lines += "\nFuncionó el intento " + winner + ". Servidores del canal: " + servers.length + "\n";
    servers.forEach(function (s, i) { lines += (i + 1) + ") " + resolveUrl(s && s.url) + "\n"; });
  } else if (html) {
    lines += "\nHubo HTML pero NO encontre el canal (data-slug) ni su onclick.\n\n----- INICIO DEL HTML -----\n" + dump(html);
  } else {
    lines += "\nNingun intento dio HTML con contenido.\n";
  }
  return { text: lines, servers: servers };
}

async function getStreams(tmdbId, type, season, episode) {
  if (type !== "tv" || !tmdbId) return [];
  var slug = slugFromId(tmdbId);
  if (!slug) return [];

  var pageUrl = BASE + encodeURIComponent(slug);
  var testMode = slug === TEST_SLUG;

  var fixedJobs = testMode ? FIXED_PROBES.map(function (p) { return probe("PRUEBA " + p.name, p.url, p.h); }) : [];
  var pageRes;
  try {
    pageRes = await pageAttempts(pageUrl, slug);
  } catch (e) {
    pageRes = { text: "Pagina: " + pageUrl + "\nFALLO: " + (e && e.message ? e.message : e), servers: null };
  }

  var out = [card("DIAGNOSTICO " + slug,
    "VERSION: " + VERSION + "\ntmdbId: " + tmdbId + "\nslug: " + slug + "\nModo prueba: " + (testMode ? "si" : "no") + "\n\n" + pageRes.text)];

  var seen = {};
  FIXED_PROBES.forEach(function (p) { seen[p.url] = true; });
  var srvJobs = [];
  if (pageRes.servers) {
    pageRes.servers.slice(0, MAX_SERVERS).forEach(function (s, i) {
      var u = resolveUrl(s && s.url);
      if (!u || (testMode && seen[u])) return;
      srvJobs.push(probe("SERVIDOR " + (i + 1) + " del canal", u, { "Referer": REFERER, "Sec-Fetch-Dest": "iframe" }));
    });
  }
  var cards = await Promise.all(fixedJobs.concat(srvJobs));
  return out.concat(cards);
}

exports.getStreams = getStreams;
exports._slugFromId = slugFromId;
exports._parseServers = parseServers;
exports._resolveUrl = resolveUrl;
exports._dump = dump;
