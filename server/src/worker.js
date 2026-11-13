// Save Jensen — Cloudflare Worker: static assets + support records + moderated messages (D1).
// Bindings: ASSETS (static files), DB (D1). Secrets: ADMIN_TOKEN, RATE_SALT.

const PRIMARY_HOST = "savejensen.ai";
const REDIRECT_HOSTS = new Set(["www.savejensen.ai", "savejensen.com", "www.savejensen.com"]);
const COOKIE = "sj_device";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const MAX_BODY = 4096;
const MAX_MESSAGE_BODY = 40 * 1024;      // a message may carry a base64 avatar of at most 24 KiB
const MAX_AVATAR_BYTES = 24 * 1024;
const ACTIVE = ["pending", "approved"];

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.code }, err.status, err.headers);
      console.error("unhandled", err && err.stack ? err.stack : err);
      return json({ error: "server_error" }, 500);
    }
  },
};

class HttpError extends Error {
  constructor(status, code, headers) { super(code); this.status = status; this.code = code; this.headers = headers; }
}

async function handle(request, env) {
  const url = new URL(request.url);

  // 1) One canonical address, in one hop: secondary hostnames → the primary host (path and query kept), and
  //    legacy "?lang=zh|en" home links → that language's home page with the lang parameter removed.
  const legacy = request.method === "GET" || request.method === "HEAD" ? canonicalHomeTarget(url) : null;
  const secondary = REDIRECT_HOSTS.has(url.hostname);
  if (secondary || legacy) {
    const origin = secondary ? `https://${PRIMARY_HOST}` : url.origin;
    return new Response(null, { status: 301, headers: { Location: origin + (legacy || url.pathname + url.search) } });
  }

  // 2) API
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return api(request, env, url);

  // 3) Static assets (only what the build copied into ./public)
  const res = await env.ASSETS.fetch(request);
  const h = new Headers(res.headers);
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("X-Frame-Options", "DENY");
  if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
    h.set("X-Robots-Tag", "noindex, nofollow");
    h.set("Cache-Control", "no-store");
    h.set("Content-Security-Policy", "default-src 'self'; img-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

/* ---------------- helpers ---------------- */

const HOME_PATHS = new Set(["/", "/index.html", "/en", "/en/", "/en/index.html", "/zh", "/zh/", "/zh/index.html"]);

// English is the default. Preserve old language links and unrelated query parameters.
// An explicit supported ?lang overrides the path; API and asset URLs are never localized.
function canonicalHomeTarget(url) {
  if (!HOME_PATHS.has(url.pathname)) return null;
  const lang = url.searchParams.getAll("lang").find((v) => v === "zh" || v === "en");
  const path = lang ? (lang === "zh" ? "/zh/" : "/") : (url.pathname.startsWith("/zh") ? "/zh/" : "/");
  let query = url.search;
  if (lang) {
    const rest = new URLSearchParams(url.search);
    rest.delete("lang");
    const q = rest.toString();
    query = q ? "?" + q : "";
  }
  const target = path + query;
  return target === url.pathname + url.search ? null : target;
}

function json(body, status = 200, extra) {
  const h = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
    "X-Content-Type-Options": "nosniff",
  });
  if (extra) for (const [k, v] of Object.entries(extra)) h.append(k, v);
  return new Response(JSON.stringify(body), { status, headers: h });
}

const now = () => Date.now();

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Mutating requests must come from our own pages. */
function requireSameOrigin(request, url) {
  const origin = request.headers.get("Origin");
  if (!origin || origin !== url.origin) throw new HttpError(403, "bad_origin");
  const site = request.headers.get("Sec-Fetch-Site");
  if (site && site !== "same-origin") throw new HttpError(403, "bad_origin");
}

async function readJson(request, limit = MAX_BODY) {
  const type = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") throw new HttpError(415, "json_required");
  if (Number(request.headers.get("Content-Length") || 0) > limit) throw new HttpError(413, "body_too_large");
  // Read chunk by chunk and stop as soon as the limit is passed, instead of buffering the whole upload.
  const chunks = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel("body_too_large").catch(() => {});
        throw new HttpError(413, "body_too_large");
      }
      chunks.push(value);
    }
  }
  const buf = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  let data;
  try { data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buf)); } catch { throw new HttpError(400, "bad_json"); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new HttpError(400, "bad_json");
  return data;
}

/** Device credential: random token in an HttpOnly cookie; only its SHA-256 is stored. */
async function readDevice(request) {
  const m = /(?:^|;\s*)sj_device=([A-Za-z0-9_-]{43})(?:;|$)/.exec(request.headers.get("Cookie") || "");
  return m ? { hash: await sha256Hex("device:" + m[1]), setCookie: null } : null;
}

/** Business writes need an existing credential (issued by GET /api/state). Without one nothing is written. */
async function requireDevice(request) {
  const d = await readDevice(request);
  if (!d) throw new HttpError(428, "device_required");
  return d;
}

async function ensureDevice(request) {
  const d = await readDevice(request);
  if (d) return d;
  const token = randomToken();
  return {
    hash: await sha256Hex("device:" + token),
    setCookie: `${COOKIE}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Strict`,
  };
}

/** Short-lived rate limiting keyed by a salted, daily-rotating hash of the IP. Raw IPs are never stored. */
async function rateLimit(request, env, scope, max, windowSec) {
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const day = new Date(now()).toISOString().slice(0, 10);
  const ipHash = (await sha256Hex(`ip:${env.RATE_SALT || "dev-salt"}:${day}:${ip}`)).slice(0, 32);
  const t = Math.floor(now() / 1000);
  const bucket = Math.floor(t / windowSec);
  const row = await env.DB.prepare(
    "INSERT INTO rate_limits (k, bucket, n, expires_at) VALUES (?, ?, 1, ?) " +
    "ON CONFLICT (k, bucket) DO UPDATE SET n = n + 1 RETURNING n"
  ).bind(`${scope}:${ipHash}`, bucket, t + windowSec * 2).first();
  if (Math.random() < 0.02) await env.DB.prepare("DELETE FROM rate_limits WHERE expires_at < ?").bind(t).run();
  if (row && row.n > max) throw new HttpError(429, "rate_limited", { "Retry-After": String(windowSec) });
}

async function supportCount(env) {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM supports WHERE withdrawn_at IS NULL").bind().first();
  return r ? Number(r.n) : 0;
}

async function cheerState(env, hash) {
  const all = await env.DB.prepare("SELECT n FROM counters WHERE name = 'cheers'").bind().first();
  const me = hash ? await env.DB.prepare("SELECT total, epoch FROM cheers WHERE device_hash = ?").bind(hash).first() : null;
  return { total: all ? Number(all.n) : 0, mine: me ? Number(me.total) : 0, epoch: me ? Number(me.epoch) : 0 };
}

async function shareCount(env) {
  const r = await env.DB.prepare("SELECT n FROM counters WHERE name = 'shares'").bind().first();
  return r ? Number(r.n) : 0;
}

const publicMessage = (r) => r && ({ id: r.id, nickname: r.nickname, content: r.content, status: r.status, createdAt: r.created_at, hasAvatar: !!r.has_avatar });

async function deviceMessage(env, hash) {
  return publicMessage(await env.DB.prepare(
    "SELECT id, nickname, content, status, created_at, EXISTS (SELECT 1 FROM message_avatars a WHERE a.message_id = messages.id) AS has_avatar FROM messages " +
    "WHERE device_hash = ? AND status != 'withdrawn' ORDER BY created_at DESC LIMIT 1"
  ).bind(hash).first());
}

/* ---------------- opt-in energy leaderboard ---------------- */
const profileView = (p) => p ? { id: p.id, nickname: p.nickname, enabled: !!p.public_enabled, hidden: !!p.admin_hidden, version: Number(p.version) } : null;
async function leaderboardProfile(env, hash) {
  return hash ? await env.DB.prepare("SELECT id, nickname, public_enabled, admin_hidden, version FROM leaderboard_profiles WHERE device_hash = ?").bind(hash).first() : null;
}
async function leaderboard(env, hash, period) {
  const t = now(), start = Math.floor(t / 86400000) * 86400000, end = start + 86400000;
  const score = period === "today" ? "COALESCE((SELECT SUM(b.delta) FROM cheer_batches b WHERE b.device_hash=p.device_hash AND b.epoch=c.epoch AND b.created_at>=? AND b.created_at<?),0)" : "c.total";
  const sql = `WITH scores AS (
    SELECT p.id,p.device_hash,p.nickname,p.joined_at,${score} AS score
    FROM leaderboard_profiles p JOIN cheers c ON c.device_hash=p.device_hash
    WHERE p.public_enabled=1 AND p.admin_hidden=0 AND c.total>0
  ), levels AS (
    SELECT score,LAG(score) OVER (ORDER BY score DESC) AS above FROM scores WHERE score>0 GROUP BY score
  ), ranked AS (
    SELECT *,RANK() OVER (ORDER BY score DESC) AS rank,
      ROW_NUMBER() OVER (ORDER BY score DESC,joined_at,id) AS position FROM scores WHERE score>0
  ) SELECT r.*,l.above,
    (SELECT m.id FROM messages m JOIN message_avatars a ON a.message_id=m.id WHERE m.device_hash=r.device_hash AND m.status='approved' LIMIT 1) AS avatar_id
    FROM ranked r JOIN levels l ON l.score=r.score WHERE r.position<=20 OR r.device_hash=? ORDER BY r.position`;
  const args = period === "today" ? [start, end, hash || ""] : [hash || ""];
  const { results } = await env.DB.prepare(sql).bind(...args).all();
  const view = r => ({ id: r.id, nickname: r.nickname, energy: Number(r.score), rank: Number(r.rank), avatarId: r.avatar_id || null,
    toNext: r.above == null ? null : Math.ceil((Number(r.above)-Number(r.score)+1)/10)*10 });
  const mine = results.find(r => r.device_hash === hash);
  return { period, day: new Date(start).toISOString().slice(0,10), resetsAt: end,
    entries: results.filter(r => Number(r.position)<=20).map(view), mine: mine ? view(mine) : null,
    profile: profileView(await leaderboardProfile(env, hash)) };
}

/* ---------------- text validation and automatic screening ---------------- */

const cpLen = (s) => Array.from(s).length;

// Control (Cc), invisible format (Cf: zero-width, bidi overrides, BOM) and line/paragraph separators (Zl, Zp).
const RE_INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const RE_INVISIBLE_KEEP_NL = /(?!\n)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

function cleanLine(s) {
  return String(s).normalize("NFC").replace(RE_INVISIBLE, " ").replace(/\s+/g, " ").trim();
}

function cleanText(s) {
  return String(s).normalize("NFC").replace(/\r\n?/g, "\n").replace(/\t/g, " ").replace(RE_INVISIBLE_KEEP_NL, "")
    .replace(/ +/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

const RE_LINK = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|cn|io|ai|xyz|top|cc|me|co|ru|info|vip|shop|app|dev|gg|ly|tv|link|site|online|biz|tech|us|uk|de|fr|edu|gov)\b)/i;
const RE_EMAIL = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
const RE_PHONE = /(?:\+?\d[\s\-().]{0,2}){8,}/;
const RE_CONTACT = /(加\s*[vV微]|微信|威信|vx\s*[:：]|wechat|whats\s*app|telegram|电报|qq\s*[:：]?\s*\d|扣扣)/i;
const ABUSE_ZH = ["傻逼", "傻b", "煞笔", "操你", "草泥马", "去死", "贱人", "婊子", "废物", "滚蛋", "狗东西"];
const ABUSE_EN = /(?:^|[^\p{L}\p{N}])(?:f[\s._*-]*u[\s._*-]*c[\s._*-]*k(?:ing|ed|er|s)?|s[\s._*-]*h[\s._*-]*i[\s._*-]*t|bitch|asshole|bastard|cunt|kill\s+yourself|kys|retard)(?=$|[^\p{L}\p{N}])/iu;

/**
 * Automatic pre-screening. It only catches obvious cases (links, contact details, common insults,
 * flooding). Passing messages publish immediately; admins can hide abuse afterwards.
 * This is a basic text filter, not a semantic text/image moderation service.
 */
export function screen(nickname, content) {
  const name = nickname.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  if (name.includes("savejensen") || /^(?:本站|网站)?(?:官方|管理员|主办方|运营团队|管理团队)$/.test(name)) return "reserved_nickname";
  const text = `${nickname}\n${content}`.normalize("NFKC").toLowerCase();
  if (RE_EMAIL.test(text) || RE_PHONE.test(text) || RE_CONTACT.test(text)) return "blocked_contact";
  if (RE_LINK.test(text)) return "blocked_link";
  if (ABUSE_ZH.some((w) => text.replace(/[\s._*-]/g, "").includes(w)) || ABUSE_EN.test(text)) return "blocked_abuse";
  const body = content.replace(/\s/g, "");
  if (/(.)\1{9,}/u.test(body)) return "blocked_repeat";
  const chars = Array.from(body);
  if (chars.length >= 24 && new Set(chars).size / chars.length < 0.2) return "blocked_repeat";
  return null;
}

/* ---------------- avatar validation ---------------- */

/** Real pixel size from the file's own headers, or null if this is not a well-formed JPEG / WebP. */
function imageInfo(b) {
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    if (b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) return null;
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { mime: "image/jpeg", height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
      }
      const len = (b[i + 2] << 8) | b[i + 3];
      if (len < 2) return null;
      i += 2 + len;
    }
    return null;
  }
  const tag = (o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (b.length > 30 && tag(0) === "RIFF" && tag(8) === "WEBP") {
    const kind = tag(12);
    if (kind === "VP8X") return { mime: "image/webp", width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (kind === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { mime: "image/webp", width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
    if (kind === "VP8L" && b[20] === 0x2f) return { mime: "image/webp", width: 1 + ((b[21] | (b[22] << 8)) & 0x3fff), height: 1 + (((b[22] >> 6) | (b[23] << 2) | (b[24] << 10)) & 0x3fff) };
  }
  return null;
}

/** Accepts { mime, data: base64 } and returns validated bytes, or throws 422. SVG, HTML, PNG, GIF etc. all fail here. */
function parseAvatar(input) {
  const bad = () => new HttpError(422, "invalid_avatar");
  if (!input || typeof input !== "object" || typeof input.data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.data)) throw bad();
  if (input.data.length > Math.ceil(MAX_AVATAR_BYTES / 3) * 4) throw bad();
  let bin;
  try { bin = atob(input.data); } catch { throw bad(); }
  if (bin.length < 100 || bin.length > MAX_AVATAR_BYTES) throw bad();
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const info = imageInfo(bytes);
  if (!info || info.mime !== input.mime) throw bad();
  if (info.width < 16 || info.height < 16 || info.width > 128 || info.height > 128) throw bad();
  return { ...info, bytes };
}

function imageResponse(row) {
  return new Response(new Uint8Array(row.bytes), { headers: {
    "Content-Type": row.mime === "image/webp" ? "image/webp" : "image/jpeg",
    "Cache-Control": "no-store",                      // so a hidden or withdrawn avatar stops being served at once
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Content-Disposition": "inline",
    "X-Robots-Tag": "noindex, nofollow",
  } });
}

/* ---------------- API ---------------- */

async function api(request, env, url) {
  if (!env.DB) throw new HttpError(503, "unavailable");
  const { method } = request;
  const path = url.pathname.replace(/\/+$/, "");
  const mutating = method !== "GET" && method !== "HEAD";
  if (mutating) requireSameOrigin(request, url);

  if (path === "/api/state" && method === "GET") {
    // The only place a device credential is issued. A brand-new credential has no records yet.
    const d = await ensureDevice(request);
    const fresh = !!d.setCookie;
    const supported = fresh ? false : !!(await env.DB.prepare("SELECT 1 AS x FROM supports WHERE device_hash = ? AND withdrawn_at IS NULL").bind(d.hash).first());
    return json({ supportCount: await supportCount(env), supported, message: fresh ? null : await deviceMessage(env, d.hash), cheers: await cheerState(env, fresh ? null : d.hash), shares: await shareCount(env) }, 200, fresh ? { "Set-Cookie": d.setCookie } : undefined);
  }

  if (path === "/api/leaderboard" && method === "GET") {
    const period = url.searchParams.get("period") || "all";
    if (!["all", "today"].includes(period)) throw new HttpError(400, "invalid_period");
    const d = await readDevice(request);
    return json(await leaderboard(env, d ? d.hash : null, period));
  }
  if (path === "/api/leaderboard/profile" && method === "PUT") {
    const d = await requireDevice(request);
    await rateLimit(request, env, "leaderboard_profile", 20, 3600);
    const body = await readJson(request);
    if (body.consentPublic !== true) throw new HttpError(400, "consent_required");
    const nickname = cleanLine(body.nickname || "");
    if (cpLen(nickname)<2 || cpLen(nickname)>32) throw new HttpError(422, "invalid_nickname");
    const blocked = screen(nickname, "");
    if (blocked) throw new HttpError(422, blocked);
    const v = body.expectedVersion;
    if (!Number.isSafeInteger(v) || v<0) throw new HttpError(400, "invalid_version");
    const t = now();
    const res = await env.DB.prepare(`INSERT INTO leaderboard_profiles
      (device_hash,id,nickname,public_enabled,version,joined_at,updated_at)
      SELECT ?,?,?,1,1,?,? WHERE ?=0 OR EXISTS(SELECT 1 FROM leaderboard_profiles WHERE device_hash=?)
      ON CONFLICT(device_hash) DO UPDATE SET nickname=excluded.nickname,public_enabled=1,
        version=leaderboard_profiles.version+1,updated_at=excluded.updated_at
      WHERE leaderboard_profiles.version=? AND leaderboard_profiles.admin_hidden=0`
    ).bind(d.hash,crypto.randomUUID(),nickname,t,t,v,d.hash,v).run();
    const p = await leaderboardProfile(env,d.hash);
    if (!res.meta.changes) return json({ error: p && p.admin_hidden ? "profile_hidden" : "profile_changed", profile:profileView(p) },409);
    return json({profile:profileView(p)});
  }
  if (path === "/api/leaderboard/profile" && method === "DELETE") {
    const d = await requireDevice(request);
    await rateLimit(request,env,"withdraw",60,3600);
    const t=now();
    await env.DB.prepare(`INSERT INTO leaderboard_profiles(device_hash,id,nickname,public_enabled,version,joined_at,updated_at)
      VALUES(?,?,'',0,1,?,?) ON CONFLICT(device_hash) DO UPDATE SET public_enabled=0,
      version=leaderboard_profiles.version+1,updated_at=excluded.updated_at`).bind(d.hash,crypto.randomUUID(),t,t).run();
    return json({profile:profileView(await leaderboardProfile(env,d.hash))});
  }

  // ---- support energy: weighted actions, counted in bounded batches ----
  if (path === "/api/cheers" && method === "GET") {
    return json({ total: (await cheerState(env, null)).total, shares: await shareCount(env) });
  }

  // ---- share clicks: counts presses of the share button, not completed shares ----
  if (path === "/api/share" && method === "POST") {
    const d = await requireDevice(request);
    await rateLimit(request, env, "share", 90, 60);
    const body = await readJson(request);
    if (!Number.isInteger(body.delta) || body.delta < 1 || body.delta > 50) throw new HttpError(400, "invalid_delta");
    if (typeof body.idempotencyKey !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(body.idempotencyKey)) throw new HttpError(400, "invalid_key");
    // One insert; the trigger adds delta to the site total in the same implicit transaction.
    const ins = await env.DB.prepare("INSERT OR IGNORE INTO share_batches (device_hash, idem_key, delta, created_at) VALUES (?, ?, ?, ?)").bind(d.hash, body.idempotencyKey, body.delta, now()).run();
    if (!ins.meta.changes) return json({ shares: await shareCount(env), duplicate: true });
    return json({ shares: await shareCount(env), added: body.delta });
  }

  if (path === "/api/cheer" && method === "POST") {
    const d = await requireDevice(request);
    await rateLimit(request, env, "cheer", 150, 60); // a real client sends at most ~2 batches a second
    const body = await readJson(request);
    const { delta, epoch, idempotencyKey: key } = body;
    if (!Number.isInteger(delta) || delta < 1 || delta > 10000) throw new HttpError(400, "invalid_delta");
    if (typeof key !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(key)) throw new HttpError(400, "invalid_key");
    if (!Number.isInteger(epoch) || epoch < 0) throw new HttpError(400, "invalid_epoch");
    // One atomic statement: the row is inserted only if the key is new AND the batch was created under the
    // device's current epoch. The AFTER INSERT trigger adds delta to the device total and the site total.
    const ins = await env.DB.prepare(
      "INSERT OR IGNORE INTO cheer_batches (device_hash, idem_key, delta, epoch, created_at) " +
      "SELECT ?, ?, ?, ?, ? WHERE COALESCE((SELECT epoch FROM cheers WHERE device_hash = ?), 0) = ?"
    ).bind(d.hash, key, delta, epoch, now(), d.hash, epoch).run();
    const cheers = await cheerState(env, d.hash);
    if (ins.meta.changes > 0) return json({ cheers, added: delta });
    // Nothing inserted: either a withdraw happened since the batch was created, or this key was already counted.
    if (cheers.epoch !== epoch) return json({ error: "stale_epoch", cheers }, 409);
    return json({ cheers, duplicate: true });
  }

  if (path === "/api/cheer" && method === "DELETE") {
    const d = await requireDevice(request);
    await rateLimit(request, env, "withdraw", 60, 3600);
    // One transaction: take this device's cheers off the site total, then zero the device and bump its epoch.
    // The row is created if missing, so batches still in flight from before the withdraw are refused too.
    const t = now();
    await env.DB.batch([
      env.DB.prepare("UPDATE counters SET n = MAX(n - COALESCE((SELECT total FROM cheers WHERE device_hash = ?), 0), 0) WHERE name = 'cheers'").bind(d.hash),
      env.DB.prepare("INSERT INTO cheers (device_hash, total, epoch, updated_at) VALUES (?, 0, 1, ?) ON CONFLICT (device_hash) DO UPDATE SET total = 0, epoch = epoch + 1, updated_at = excluded.updated_at").bind(d.hash, t),
    ]);
    return json({ cheers: await cheerState(env, d.hash), withdrawn: true });
  }

  // ---- legacy one-per-device support record (kept for compatibility; the page now uses cheers) ----
  if (path === "/api/support" && method === "POST") {
    const d = await requireDevice(request);
    await rateLimit(request, env, "support", 30, 3600);
    await env.DB.prepare(
      "INSERT INTO supports (device_hash, created_at, withdrawn_at) VALUES (?, ?, NULL) " +
      "ON CONFLICT (device_hash) DO UPDATE SET withdrawn_at = NULL, created_at = CASE WHEN supports.withdrawn_at IS NULL THEN supports.created_at ELSE excluded.created_at END"
    ).bind(d.hash, now()).run();
    return json({ supported: true, supportCount: await supportCount(env) });
  }

  if (path === "/api/support" && method === "DELETE") {
    const d = await requireDevice(request);
    await rateLimit(request, env, "support", 30, 3600);
    await env.DB.prepare("UPDATE supports SET withdrawn_at = ? WHERE device_hash = ? AND withdrawn_at IS NULL").bind(now(), d.hash).run();
    return json({ supported: false, supportCount: await supportCount(env) });
  }

  if (path === "/api/messages" && method === "GET") {
    // Cursor is "<reviewed_at>_<id>": many rows can share one reviewed_at, so the id breaks the tie.
    const cur = /^(\d{1,16})_([0-9a-f-]{36})$/.exec(url.searchParams.get("before") || "");
    const ts = cur ? Number(cur[1]) : Number.MAX_SAFE_INTEGER;
    const lastId = cur ? cur[2] : "~";
    const { results } = await env.DB.prepare(
      "SELECT id, nickname, content, reviewed_at, EXISTS (SELECT 1 FROM message_avatars a WHERE a.message_id = messages.id) AS has_avatar " +
      "FROM messages WHERE status = 'approved' AND (reviewed_at < ? OR (reviewed_at = ? AND id < ?)) " +
      "ORDER BY reviewed_at DESC, id DESC LIMIT 21"
    ).bind(ts, ts, lastId).all();
    const page = results.slice(0, 20);
    const last = page[page.length - 1];
    return json({
      messages: page.map((r) => ({ id: r.id, nickname: r.nickname, content: r.content, approvedAt: r.reviewed_at, avatar: !!r.has_avatar })),
      next: results.length > 20 ? `${last.reviewed_at}_${last.id}` : null,
    });
  }

  // Public avatar: only while its message is approved.
  const av = /^\/api\/avatars\/([0-9a-f-]{36})$/.exec(path);
  if (av && method === "GET") {
    const row = await env.DB.prepare(
      "SELECT a.mime, a.bytes FROM message_avatars a JOIN messages m ON m.id = a.message_id WHERE a.message_id = ? AND m.status = 'approved'"
    ).bind(av[1]).first();
    if (!row) throw new HttpError(404, "not_found");
    return imageResponse(row);
  }

  if (path === "/api/messages" && method === "POST") {
    const d = await requireDevice(request);
    await rateLimit(request, env, "message", 6, 3600);
    const body = await readJson(request, MAX_MESSAGE_BODY);
    if (body.consentPublic !== true) throw new HttpError(400, "consent_required");
    if (typeof body.nickname !== "string" || typeof body.content !== "string") throw new HttpError(400, "bad_json");
    const nickname = cleanLine(body.nickname);
    const content = cleanText(body.content);
    if (cpLen(nickname) < 2 || cpLen(nickname) > 32) throw new HttpError(400, "invalid_nickname");
    if (cpLen(content) < 1 || cpLen(content) > 280) throw new HttpError(400, "invalid_content");
    const lang = body.lang === "en" ? "en" : "zh";
    const idem = typeof body.idempotencyKey === "string" && /^[A-Za-z0-9-]{8,64}$/.test(body.idempotencyKey) ? body.idempotencyKey : null;
    const blocked = screen(nickname, content);
    if (blocked) throw new HttpError(422, blocked);
    const avatar = body.avatar == null ? null : parseAvatar(body.avatar);

    const cookie = undefined;
    if (idem) {
      const same = await env.DB.prepare("SELECT id, nickname, content, status, created_at, EXISTS (SELECT 1 FROM message_avatars a WHERE a.message_id = messages.id) AS has_avatar FROM messages WHERE device_hash = ? AND idem_key = ?").bind(d.hash, idem).first();
      if (same) return json({ message: publicMessage(same), duplicate: true }, 200, cookie);
    }
    const active = await env.DB.prepare("SELECT id, nickname, content, status, created_at, EXISTS (SELECT 1 FROM message_avatars a WHERE a.message_id = messages.id) AS has_avatar FROM messages WHERE device_hash = ? AND status IN ('pending','approved')").bind(d.hash).first();
    if (active) return json({ error: "already_exists", message: publicMessage(active) }, 409, cookie);
    const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE device_hash = ? AND created_at > ?").bind(d.hash, now() - 86400e3).first();
    if (recent && recent.n >= 3) throw new HttpError(429, "rate_limited", { "Retry-After": "86400" });

    const id = crypto.randomUUID();
    const t = now();
    try {
      const ins = env.DB.prepare(
        "INSERT INTO messages (id, device_hash, nickname, content, lang, status, consent_public, idem_key, created_at, reviewed_at) VALUES (?, ?, ?, ?, ?, 'approved', 1, ?, ?, ?)"
      ).bind(id, d.hash, nickname, content, lang, idem, t, t);
      // Message and avatar are written together or not at all.
      if (avatar) await env.DB.batch([ins, env.DB.prepare("INSERT INTO message_avatars (message_id, mime, bytes, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, avatar.mime, avatar.bytes, avatar.width, avatar.height, t)]);
      else await ins.run();
    } catch (e) {
      // Lost a race with a concurrent retry: the unique indexes kept a single row.
      const row = await deviceMessage(env, d.hash);
      if (row) return json({ message: row, duplicate: true }, 200, cookie);
      throw e;
    }
    return json({ message: { id, nickname, content, status: "approved", createdAt: t, hasAvatar: !!avatar } }, 201, cookie);
  }

  if (path === "/api/messages/mine" && method === "DELETE") {
    const d = await requireDevice(request);
    await rateLimit(request, env, "withdraw", 60, 3600); // own, generous quota: removing your message must stay possible
    // The avatar is deleted outright, first: even if the next statement failed it could no longer be read.
    await env.DB.prepare("DELETE FROM message_avatars WHERE message_id IN (SELECT id FROM messages WHERE device_hash = ?)").bind(d.hash).run();
    const r = await env.DB.prepare(
      "UPDATE messages SET status = 'withdrawn', withdrawn_at = ? WHERE device_hash = ? AND status IN ('pending','approved','hidden')"
    ).bind(now(), d.hash).run();
    return json({ withdrawn: r.meta.changes > 0, message: null });
  }

  if (path.startsWith("/api/admin/")) return admin(request, env, url, path);

  throw new HttpError(404, "not_found");
}

/* ---------------- admin ---------------- */

async function requireAdmin(request, env) {
  if (!env.ADMIN_TOKEN) throw new HttpError(503, "admin_disabled");
  await rateLimit(request, env, "admin", 120, 600);
  const m = /^Bearer\s+(.+)$/.exec(request.headers.get("Authorization") || "");
  // Compare digests so the comparison time does not depend on where the strings differ.
  const [a, b] = await Promise.all([sha256Hex("admin:" + (m ? m[1] : "")), sha256Hex("admin:" + env.ADMIN_TOKEN)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  if (!m || diff !== 0) throw new HttpError(401, "unauthorized", { "WWW-Authenticate": "Bearer" });
}

async function admin(request, env, url, path) {
  await requireAdmin(request, env);
  const { method } = request;

  if (path === "/api/admin/leaderboard" && method === "GET") {
    const q=cleanLine(url.searchParams.get("q")||"").slice(0,64);
    const {results}=await env.DB.prepare("SELECT id,nickname,public_enabled,admin_hidden,version FROM leaderboard_profiles WHERE (public_enabled=1 OR id=?) AND (?='' OR instr(lower(nickname),lower(?))>0 OR id=?) ORDER BY updated_at DESC LIMIT 100").bind(q,q,q,q).all();
    return json({profiles:results.map(profileView)});
  }
  const lp=/^\/api\/admin\/leaderboard\/([0-9a-f-]{36})\/(hide|restore)$/.exec(path);
  if (lp && method === "POST") {
    const r=await env.DB.prepare("UPDATE leaderboard_profiles SET admin_hidden=?,version=version+1,updated_at=? WHERE id=?").bind(lp[2]==="hide"?1:0,now(),lp[1]).run();
    if(!r.meta.changes)throw new HttpError(404,"not_found");
    return json({ok:true});
  }

  if (path === "/api/admin/messages" && method === "GET") {
    const status = url.searchParams.get("status") || "pending";
    if (!["pending", "approved", "hidden", "withdrawn"].includes(status)) throw new HttpError(400, "bad_status");
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 100);
    const { results } = await env.DB.prepare(
      "SELECT id, nickname, content, lang, status, created_at, reviewed_at, withdrawn_at, EXISTS (SELECT 1 FROM message_avatars a WHERE a.message_id = messages.id) AS has_avatar FROM messages WHERE status = ? ORDER BY created_at DESC LIMIT ?"
    ).bind(status, limit).all();
    const counts = await env.DB.prepare("SELECT status, COUNT(*) AS n FROM messages GROUP BY status").bind().all();
    return json({
      messages: results.map((r) => ({ id: r.id, nickname: r.nickname, content: r.content, lang: r.lang, status: r.status, createdAt: r.created_at, reviewedAt: r.reviewed_at, withdrawnAt: r.withdrawn_at, hasAvatar: !!r.has_avatar })),
      counts: Object.fromEntries(counts.results.map((r) => [r.status, Number(r.n)])),
      supportCount: await supportCount(env),
    });
  }

  const pic = /^\/api\/admin\/messages\/([0-9a-f-]{36})\/avatar$/.exec(path);
  if (pic && method === "GET") {
    const row = await env.DB.prepare("SELECT mime, bytes FROM message_avatars WHERE message_id = ?").bind(pic[1]).first();
    if (!row) throw new HttpError(404, "not_found");
    return imageResponse(row);
  }

  const m = /^\/api\/admin\/messages\/([0-9a-f-]{36})\/(approve|hide)$/.exec(path);
  if (m && method === "POST") {
    const [, id, action] = m;
    const from = action === "approve" ? "('pending','hidden')" : "('pending','approved')";
    const to = action === "approve" ? "approved" : "hidden";
    let changes = 0;
    try {
      // Withdrawn rows never match: approval cannot bring back a message its author removed.
      const r = await env.DB.prepare(`UPDATE messages SET status = ?, reviewed_at = ? WHERE id = ? AND status IN ${from}`).bind(to, now(), id).run();
      changes = r.meta.changes;
    } catch {
      throw new HttpError(409, "conflict_active"); // the device already has another active message
    }
    const row = await env.DB.prepare("SELECT id, status FROM messages WHERE id = ?").bind(id).first();
    if (!row) throw new HttpError(404, "not_found");
    if (!changes) return json({ error: "not_allowed", status: row.status }, 409);
    return json({ id, status: row.status });
  }

  throw new HttpError(404, "not_found");
}

export { ACTIVE };
