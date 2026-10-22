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

  if (p === "/monitor" || p === "/api/stats") {
    if (!PASS && !OPEN) return send(res, 503, "Monitoreo desactivado: define la variable MONITOR_PASS en el servidor.");
    if (!authorized(req)) return send(res, 401, "Se necesita usuario y contraseña", undefined, { "WWW-Authenticate": 'Basic realm="Monitoreo del juego", charset="UTF-8"' });
    if (p === "/api/stats") return send(res, 200, JSON.stringify(stats()), "application/json; charset=utf-8");
    return fs.readFile(path.join(ROOT, "monitor.html"), (e, d) => e ? send(res, 500, "Falta monitor.html") : send(res, 200, d, "text/html; charset=utf-8"));
  }

  const f = FILES[p];
  if (f && (req.method === "GET" || req.method === "HEAD"))
    return fs.readFile(path.join(ROOT, f[0]), (e, d) => e ? send(res, 404, "No encontrado") : send(res, 200, d, f[1]));

  send(res, 404, "No encontrado");
});

server.listen(PORT, () => console.log(`Juego en http://localhost:${PORT}  ·  monitoreo en http://localhost:${PORT}/monitor` +
  (OPEN ? "  (SIN contraseña: modo prueba)" : PASS ? "" : "  (desactivado: falta MONITOR_PASS)")));
