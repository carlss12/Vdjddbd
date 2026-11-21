/*
 * pelisjuanita.js - plugin de TV en vivo (VERSION DE DIAGNOSTICO)
 *
 * Flujo:
 *   tmdbId "cbl-<slug>" (ej. cbl-hbo-2)
 *   -> https://pelisjuanita.com/tv/<slug>  (lee el onclick del canal con su lista de servidores)
 *   -> pide cada servidor con Referer de pelisjuanita
 *   -> devuelve tarjetas "DIAGNOSTICO" con lo que respondio cada uno (aun no reproduce nada)
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
var VERSION = "pj-diag-1";
var BASE = "https://pelisjuanita.com/tv/";
var REFERER = "https://pelisjuanita.com/tv/";
var MAX_SERVERS = 6;
var MAX_DUMP = 60000;

var UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";

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

async function get(url, headers, ms) {
  var h = { "User-Agent": UA, "Accept-Language": "es-419,es;q=0.9" };
  for (var k in headers) h[k] = headers[k];
  var r = await withTimeout(fetch(url, { headers: h }), ms, "peticion");
  var text = await r.text();
  return { status: r.status, ok: r.ok, finalUrl: r.url || "", text: text };
}

function dump(text) {
  text = String(text || "");
  if (text.length <= MAX_DUMP) return text;
  return text.slice(0, MAX_DUMP) + "\n[... cortado: el original mide " + text.length + " caracteres]";
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

async function probeServer(srv, idx) {
  var url = resolveUrl(srv && srv.url);
  if (!url) return card("SERVIDOR " + (idx + 1), "URL vacia en la lista.");
  var head = "VERSION: " + VERSION + "\nSERVIDOR " + (idx + 1) + "\nURL pedida: " + url + "\nReferer enviado: " + REFERER + "\n";
  try {
    var r = await get(url, { "Referer": REFERER, "Sec-Fetch-Dest": "iframe" }, 9000);
    return card("SERVIDOR " + (idx + 1),
      head + "HTTP: " + r.status + "\nURL final: " + r.finalUrl + "\nLargo: " + r.text.length +
      "\n\n----- RESPUESTA -----\n" + dump(r.text));
  } catch (e) {
    return card("SERVIDOR " + (idx + 1), head + "FALLO: " + (e && e.message ? e.message : e));
  }
}

async function getStreams(tmdbId, type, season, episode) {
  if (type !== "tv" || !tmdbId) return [];
  var slug = slugFromId(tmdbId);
  if (!slug) return [];

  var out = [];
  var pageUrl = BASE + encodeURIComponent(slug);
  var servers = null;
  var summary = "VERSION: " + VERSION + "\ntmdbId: " + tmdbId + "\nslug: " + slug + "\nPagina: " + pageUrl + "\n";

  try {
    var r = await get(pageUrl, { "Referer": "https://pelisjuanita.com/inicio.php" }, 9000);
    summary += "HTTP: " + r.status + "\nURL final: " + r.finalUrl + "\nLargo HTML: " + r.text.length + "\n";
    servers = parseServers(r.text, slug);
    if (servers) {
      summary += "Servidores en la lista: " + servers.length + "\n\n";
      servers.forEach(function (s, i) { summary += (i + 1) + ") " + resolveUrl(s && s.url) + "\n"; });
    } else {
      summary += "\nNO encontre el canal (data-slug) ni su onclick en el HTML.\n\n----- INICIO DEL HTML -----\n" + dump(r.text);
    }
  } catch (e) {
    summary += "FALLO al pedir la pagina: " + (e && e.message ? e.message : e);
  }
  out.push(card("DIAGNOSTICO " + slug, summary));

  if (servers && servers.length) {
    var jobs = servers.slice(0, MAX_SERVERS).map(function (s, i) { return probeServer(s, i); });
    var cards = await Promise.all(jobs);
    out = out.concat(cards);
  }
  return out;
}

exports.getStreams = getStreams;
exports._slugFromId = slugFromId;
exports._parseServers = parseServers;
exports._resolveUrl = resolveUrl;
