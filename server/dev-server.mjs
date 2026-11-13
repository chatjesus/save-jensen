// Local preview of the real Worker without wrangler: serves ./public as the ASSETS binding and
// backs DB with in-memory SQLite (node:sqlite). Data is lost when the process exits.
//   node work/save-jensen/server/dev-server.mjs [port]      ADMIN_TOKEN defaults to "local-admin"
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "./src/worker.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, "public");
const port = Number(process.argv[2] || 8787);
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".jpg": "image/jpeg", ".png": "image/png", ".xml": "application/xml", ".txt": "text/plain; charset=utf-8" };

const db = new DatabaseSync(":memory:");
for (const m of ["0001_init.sql", "0002_cheers.sql", "0003_avatars.sql"]) db.exec(readFileSync(path.join(here, "migrations", m), "utf8"));
const DB = { async batch(stmts) { db.exec("BEGIN"); try { const out = []; for (const s of stmts) out.push(await s.run()); db.exec("COMMIT"); return out; } catch (e) { db.exec("ROLLBACK"); throw e; } }, prepare(sql) { const st = db.prepare(sql); return { bind: (...a) => ({ first: async () => st.get(...a) ?? null, all: async () => ({ results: st.all(...a) }), run: async () => ({ meta: { changes: Number(st.run(...a).changes) } }) }) }; } };

const ASSETS = {
  async fetch(request) {
    let p = decodeURIComponent(new URL(request.url).pathname);
    if (p.endsWith("/")) p += "index.html";
    let file = path.join(pub, path.normalize(p));
    if (!file.startsWith(pub)) return new Response("forbidden", { status: 403 });
    try {
      if ((await stat(file)).isDirectory()) return new Response(null, { status: 307, headers: { Location: new URL(request.url).pathname + "/" } });
      return new Response(await readFile(file), { headers: { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" } });
    } catch {
      return new Response(await readFile(path.join(pub, "404.html")), { status: 404, headers: { "Content-Type": TYPES[".html"] } });
    }
  },
};
const env = { DB, ASSETS, ADMIN_TOKEN: process.env.ADMIN_TOKEN || "local-admin", RATE_SALT: "local" };

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  headers.set("CF-Connecting-IP", req.socket.remoteAddress || "127.0.0.1");
  const hasBody = !["GET", "HEAD"].includes(req.method);
  const r = await worker.fetch(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined }), env);
  const out = {};
  r.headers.forEach((v, k) => { if (k !== "set-cookie") out[k] = v; });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  if (sc.length) out["set-cookie"] = sc;
  res.writeHead(r.status, out);
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(port, "127.0.0.1", () => console.log(`Save Jensen dev server: http://localhost:${port}/  (admin token: ${env.ADMIN_TOKEN})`));
