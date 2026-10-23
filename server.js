// Servidor del juego + monitoreo de jugadores. Sin dependencias:  node server.js
//
// Variables de entorno:
//   PORT          puerto (por defecto 3000)
//   MONITOR_USER  usuario para /monitor (por defecto "admin")
//   MONITOR_PASS  contraseña para /monitor (si no se pone, /monitor queda desactivado)
//   TZ            zona horaria para las estadísticas por día/hora (ej. America/Bogota)
//   MONITOR_OPEN  "1" = /monitor sin contraseña (solo para probar en tu computadora)

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = +process.env.PORT || 3000;
const USER = process.env.MONITOR_USER || "admin";
const PASS = process.env.MONITOR_PASS || "";
const OPEN = process.env.MONITOR_OPEN === "1";
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DATA = path.join(DATA_DIR, "stats.json");
const ONLINE_MS = 45 * 1000;      // conectado = dio señal en los últimos 45 s

// ---------------- datos guardados ----------------
const emptyTotal = () => ({ starts: 0, wins: 0, losses: 0, scoreSum: 0, qOk: 0, qBad: 0 });
let db = { total: emptyTotal(), days: {}, top: [], sids: [] };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DATA, "utf8")) }; } catch (e) { /* primera vez */ }
const allSids = new Set(db.sids);
let dirty = false;

// ---------------- preguntas (se manejan desde /monitor) ----------------
// Banco base: preguntas-base.js (el mismo archivo que carga el juego).
const vm = require("vm");
const base = (() => {
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "preguntas-base.js"), "utf8"), ctx);
  const qid = q => "b" + crypto.createHash("sha1").update(q.q).digest("hex").slice(0, 10);
  return [
    ...ctx.window.PREGUNTAS_BASE.logica.map(q => ({ ...q, cat: "logica", id: qid(q) })),
    ...ctx.window.PREGUNTAS_BASE.tecnologia.map(q => ({ ...q, cat: "tecnologia", id: qid(q) })),
  ];
})();
const QDATA = path.join(DATA_DIR, "questions.json");
let qs = { disabled: [], custom: [], generators: true, version: 0 };
try { qs = { ...qs, ...JSON.parse(fs.readFileSync(QDATA, "utf8")) }; } catch (e) { /* primera vez */ }
function saveQs() {
  qs.version++;
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(QDATA + ".tmp", JSON.stringify(qs, null, 1)); fs.renameSync(QDATA + ".tmp", QDATA); }
  catch (e) { console.error("No se pudo guardar", QDATA, "-", e.message); }
}
const allQuestions = () => [...base.map(q => ({ ...q, builtin: true })), ...qs.custom.map(q => ({ ...q, builtin: false, plain: true }))];
const stripTags = s => String(s).replace(/<[^>]*>/g, "");

// lo que recibe el juego: solo las activas
function activeQuestions() {
  const off = new Set(qs.disabled);
  return { version: qs.version, generators: qs.generators,
    questions: allQuestions().filter(q => !off.has(q.id)).map(({ t, q, o, a, cat, plain }) => ({ t, q, o, a, cat, plain: !!plain })) };
}
// lo que ve el panel: todas, con su estado
function adminQuestions() {
  const off = new Set(qs.disabled);
  return { generators: qs.generators,
    items: allQuestions().map(q => ({ id: q.id, cat: q.cat, t: q.t, q: q.plain ? q.q : stripTags(q.q), o: q.o.map(x => q.plain ? x : stripTags(x)), builtin: q.builtin, active: !off.has(q.id) })) };
}

function adminAction(p, b) {
  const clean = (s, max) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, max);
  if (p === "/api/admin/questions/add") {
    const cat = b.cat === "logica" ? "logica" : "tecnologia";
    const q = clean(b.q, 220), o = (Array.isArray(b.o) ? b.o : []).map(x => clean(x, 90));
    const t = clean(b.t, 24).toUpperCase() || (cat === "logica" ? "LÓGICA" : "TECNOLOGÍA");
    if (!q) return [400, "Escribe la pregunta."];
    if (o.length !== 4 || o.some(x => !x)) return [400, "Escribe la respuesta correcta y las 3 incorrectas."];
    if (new Set(o.map(x => x.toLowerCase())).size !== 4) return [400, "Las 4 respuestas deben ser distintas."];
    if (qs.custom.length >= 500) return [400, "Ya hay demasiadas preguntas agregadas (máximo 500)."];
    qs.custom.push({ id: "c" + crypto.randomBytes(5).toString("hex"), cat, t, q, o, a: 0 });
  } else if (p === "/api/admin/questions/toggle") {
    if (!allQuestions().some(q => q.id === b.id)) return [404, "No existe esa pregunta."];
    qs.disabled = qs.disabled.filter(id => id !== b.id);
    if (!b.active) qs.disabled.push(b.id);
  } else if (p === "/api/admin/questions/delete") {
    const before = qs.custom.length;
    qs.custom = qs.custom.filter(q => q.id !== b.id);
    if (qs.custom.length === before) return [404, "Solo se pueden borrar las preguntas agregadas desde el panel."];
    qs.disabled = qs.disabled.filter(id => id !== b.id);
  } else if (p === "/api/admin/generators") {
    qs.generators = !!b.on;
  } else return [404, "No encontrado"];
  saveQs();
  return [200, JSON.stringify(adminQuestions())];
}

const sessions = new Map();       // sid -> { last, dev, playing }
const feed = [];                  // actividad reciente

const pad = n => String(n).padStart(2, "0");
function dayKey(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function today() {
  const k = dayKey();
  return db.days[k] || (db.days[k] = { visitors: [], hours: Array(24).fill(0), starts: 0, wins: 0, losses: 0, qOk: 0, qBad: 0 });
}
function log(dev, text) {
  feed.push({ t: Date.now(), dev, text });
  if (feed.length > 60) feed.shift();
}

function save() {
  if (!dirty) return;
  dirty = false;
  db.sids = [...allSids];
  // guarda solo los últimos 30 días
  const keys = Object.keys(db.days).sort();
  keys.slice(0, Math.max(0, keys.length - 30)).forEach(k => delete db.days[k]);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA + ".tmp", JSON.stringify(db));
    fs.renameSync(DATA + ".tmp", DATA);
  } catch (e) {
    // si la carpeta no se puede escribir, el juego sigue funcionando (solo no se guardan las estadísticas)
    if (!save.warned) { console.error("No se pudo guardar", DATA, "-", e.message); save.warned = true; }
  }
}
setInterval(save, 5000);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { save(); process.exit(0); });

// limpia sesiones viejas de la memoria
setInterval(() => { const lim = Date.now() - 10 * 60 * 1000; for (const [k, s] of sessions) if (s.last < lim) sessions.delete(k); }, 60 * 1000);

// ---------------- eventos que manda el juego ----------------
function hit(b) {
  const sid = String(b.sid || "");
  if (!/^[a-z0-9]{6,40}$/i.test(sid)) return;
  const dev = b.dev === "movil" ? "movil" : "pc";
  const now = Date.now();
  const s = sessions.get(sid) || { playing: false };
  s.last = now; s.dev = dev;
  sessions.set(sid, s);
  const D = today();

  switch (b.ev) {
    case "visit":
      if (!D.visitors.includes(sid)) { D.visitors.push(sid); D.hours[new Date().getHours()]++; }
      if (!allSids.has(sid)) { allSids.add(sid); log(dev, "Nuevo visitante"); }
      break;
    case "ping":
      s.playing = !!b.playing;
      break;
    case "start":
      s.playing = true; D.starts++; db.total.starts++;
      log(dev, "Empezó una partida");
      break;
    case "level": {
      const lv = Math.min(3, Math.max(1, b.level | 0));
      log(dev, `Pasó el nivel ${lv}`);
      break;
    }
    case "end": {
      const win = !!b.win, score = Math.min(100000, Math.max(0, b.score | 0)), lv = Math.min(3, Math.max(1, b.level | 0));
      s.playing = false;
      if (win) { D.wins++; db.total.wins++; } else { D.losses++; db.total.losses++; }
      db.total.scoreSum += score;
      db.top.push({ score, level: lv, win, dev, t: now });
      db.top.sort((a, b) => b.score - a.score);
      db.top = db.top.slice(0, 10);
      log(dev, win ? `¡Escapó! ${score} puntos` : `Perdió en el nivel ${lv} (${score} puntos)`);
      break;
    }
    case "q":
      if (b.ok) { D.qOk++; db.total.qOk++; } else { D.qBad++; db.total.qBad++; }
      break;
    default:
      return;
  }
  dirty = true;
}

function stats() {
  const now = Date.now(), D = today();
  let online = 0, playing = 0, movil = 0, pc = 0;
  for (const s of sessions.values()) {
    if (now - s.last > ONLINE_MS) continue;
    online++; if (s.playing) playing++;
    s.dev === "movil" ? movil++ : pc++;
  }
  const games = db.total.wins + db.total.losses;
  const pct = (ok, bad) => (ok + bad ? Math.round(ok / (ok + bad) * 100) : null);
  const last7 = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now - i * 86400000), k = dayKey(d);
    last7.push({ day: k, visitors: db.days[k] ? db.days[k].visitors.length : 0 });
  }
  return {
    now, online, playing, movil, pc,
    today: { visitors: D.visitors.length, hours: D.hours, starts: D.starts, wins: D.wins, losses: D.losses, accuracy: pct(D.qOk, D.qBad), answers: D.qOk + D.qBad },
    total: { visitors: allSids.size, starts: db.total.starts, wins: db.total.wins, losses: db.total.losses,
             avgScore: games ? Math.round(db.total.scoreSum / games) : null, accuracy: pct(db.total.qOk, db.total.qBad) },
    last7, top: db.top, feed: feed.slice(-25).reverse(),
  };
}

// ---------------- HTTP ----------------
function authorized(req) {
  if (OPEN) return true;
  if (!PASS) return false;
  const m = /^Basic (.+)$/.exec(req.headers.authorization || "");
  if (!m) return false;
  const given = Buffer.from(Buffer.from(m[1], "base64").toString());
  const want = Buffer.from(`${USER}:${PASS}`);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

// solo estos archivos se pueden descargar (nunca server.js ni data/)
const FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/preguntas-base.js": ["preguntas-base.js", "text/javascript; charset=utf-8"],
  "/qr/cartel-qr-juego-feria.png": ["qr/cartel-qr-juego-feria.png", "image/png"],
  "/qr/qr-juego-feria.png": ["qr/qr-juego-feria.png", "image/png"],
};

function send(res, code, body, type = "text/plain; charset=utf-8", extra = {}) {
  res.writeHead(code, { "Content-Type": type, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache", ...extra });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  if (p === "/health") return send(res, 200, "ok");

  if (p === "/api/hit" && req.method === "POST") {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 2048) req.destroy(); });
    req.on("end", () => { try { hit(JSON.parse(body)); } catch (e) {} send(res, 204, ""); });
    return;
  }

  if (p === "/api/questions" && req.method === "GET")
    return send(res, 200, JSON.stringify(activeQuestions()), "application/json; charset=utf-8");

  if (p === "/monitor" || p === "/api/stats" || p.startsWith("/api/admin/")) {
    if (!PASS && !OPEN) return send(res, 503, "Monitoreo desactivado: define la variable MONITOR_PASS en el servidor.");
    if (!authorized(req)) return send(res, 401, "Se necesita usuario y contraseña", undefined, { "WWW-Authenticate": 'Basic realm="Monitoreo del juego", charset="UTF-8"' });
    if (p === "/api/stats") return send(res, 200, JSON.stringify(stats()), "application/json; charset=utf-8");
    if (p === "/api/admin/questions" && req.method === "GET") return send(res, 200, JSON.stringify(adminQuestions()), "application/json; charset=utf-8");
    if (p.startsWith("/api/admin/")) {
      // solo JSON por POST (un formulario de otra página no puede mandar esto: protege contra CSRF)
      if (req.method !== "POST" || !/^application\/json\b/.test(req.headers["content-type"] || "")) return send(res, 405, "Usa POST con JSON");
      let body = "";
      req.on("data", c => { body += c; if (body.length > 8192) req.destroy(); });
      req.on("end", () => {
        let b; try { b = JSON.parse(body); } catch (e) { return send(res, 400, "JSON inválido"); }
        const [code, out] = adminAction(p, b);
        send(res, code, out, code === 200 ? "application/json; charset=utf-8" : undefined);
      });
      return;
    }
    return fs.readFile(path.join(ROOT, "monitor.html"), (e, d) => e ? send(res, 500, "Falta monitor.html") : send(res, 200, d, "text/html; charset=utf-8"));
  }

  const f = FILES[p];
  if (f && (req.method === "GET" || req.method === "HEAD"))
    return fs.readFile(path.join(ROOT, f[0]), (e, d) => e ? send(res, 404, "No encontrado") : send(res, 200, d, f[1]));

  send(res, 404, "No encontrado");
});

server.listen(PORT, () => console.log(`Juego en http://localhost:${PORT}  ·  monitoreo en http://localhost:${PORT}/monitor` +
  (OPEN ? "  (SIN contraseña: modo prueba)" : PASS ? "" : "  (desactivado: falta MONITOR_PASS)")));
