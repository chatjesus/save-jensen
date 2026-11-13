// Integration tests: the real Worker handler + the real migration, on SQLite (node:sqlite) behind a D1-shaped shim.
// Run: node --test work/save-jensen/server/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker, { screen } from "../src/worker.js";

const ORIGIN = "https://savejensen.ai";
const ADMIN = "test-admin-token";

function makeEnv() {
  const db = new DatabaseSync(":memory:");
  for (const m of ["0001_init.sql", "0002_cheers.sql", "0003_avatars.sql", "0004_super_boost.sql", "0005_leaderboard.sql"]) db.exec(readFileSync(new URL("../migrations/" + m, import.meta.url), "utf8"));
  const DB = {
    async batch(stmts) { db.exec("BEGIN"); try { const out = []; for (const s of stmts) out.push(await s.run()); db.exec("COMMIT"); return out; } catch (e) { db.exec("ROLLBACK"); throw e; } },
    prepare(sql) {
      const st = db.prepare(sql);
      return { bind: (...a) => ({
        first: async () => st.get(...a) ?? null,
        all: async () => ({ results: st.all(...a) }),
        run: async () => {
          // Fault injection for tests: fail a matching write either before it runs or after it has run (lost reply).
          const f = DB.fail;
          if (f && sql.includes(f.match)) {
            DB.fail = null;
            if (f.when === "before") throw new Error("injected: before");
            st.run(...a);
            throw new Error("injected: after");
          }
          return { meta: { changes: Number(st.run(...a).changes) } };
        },
      }) };
    },
  };
  const ASSETS = { fetch: async (req) => new Response("<html>asset " + new URL(req.url).pathname + "</html>", { headers: { "Content-Type": "text/html" } }) };
  return { DB, ASSETS, ADMIN_TOKEN: ADMIN, RATE_SALT: "t", _db: db };
}

function client(env, ip = "203.0.113.1") {
  let cookie = "";
  return async function call(method, path, { body, origin = ORIGIN, token, raw, host, noInit } = {}) {
    // Like the real page: the first thing a browser does is GET /api/state, which issues the credential.
    if (!cookie && !noInit && method !== "GET" && path.startsWith("/api/") && !path.startsWith("/api/admin/")) await call("GET", "/api/state");
    const headers = { "CF-Connecting-IP": ip };
    if (cookie) headers.Cookie = cookie;
    if (origin && method !== "GET") headers.Origin = origin;
    if (token) headers.Authorization = "Bearer " + token;
    let payload;
    if (raw !== undefined) { payload = raw; headers["Content-Type"] = "application/json"; }
    else if (body !== undefined) { payload = JSON.stringify(body); headers["Content-Type"] = "application/json"; }
    const res = await worker.fetch(new Request((host || ORIGIN) + path, { method, headers, body: payload, redirect: "manual" }), env);
    const sc = res.headers.get("Set-Cookie");
    if (sc) cookie = sc.split(";")[0];
    let data = null;
    if ((res.headers.get("Content-Type") || "").includes("json")) data = await res.json();
    return { status: res.status, data, headers: res.headers, setCookie: sc };
  };
}

test("legacy ?lang= home links redirect once to the matching language home", async () => {
  const env = makeEnv();
  const get = client(env);
  const cases = [
    ["/?lang=en", "https://savejensen.ai/"],
    ["/?lang=zh", "https://savejensen.ai/zh/"],
    ["/en/?lang=zh", "https://savejensen.ai/zh/"],
    ["/zh/?lang=en", "https://savejensen.ai/"],
    ["/zh/?lang=zh", "https://savejensen.ai/zh/"],
    ["/en?lang=en", "https://savejensen.ai/"],
    ["/index.html?lang=en", "https://savejensen.ai/"],
    ["/?utm_source=x&lang=en&ref=a%20b", "https://savejensen.ai/?utm_source=x&ref=a+b"],
    ["/?lang=fr&lang=en&lang=zh", "https://savejensen.ai/"],
    ["/en", "https://savejensen.ai/"],
    ["/en/", "https://savejensen.ai/"],
    ["/en/index.html?utm_source=x", "https://savejensen.ai/?utm_source=x"],
    ["/index.html", "https://savejensen.ai/"],
    ["/zh", "https://savejensen.ai/zh/"],
    ["/zh/index.html?a=b", "https://savejensen.ai/zh/?a=b"],
    ["/en/?lang=fr&a=1", "https://savejensen.ai/?lang=fr&a=1"],
  ];
  for (const [path, want] of cases) {
    const r = await get("GET", path);
    assert.equal(r.status, 301, path);
    assert.equal(r.headers.get("Location"), want, path);
    // no loop: the target is served, not redirected again
    const next = await get("GET", want.replace("https://savejensen.ai", ""));
    assert.equal(next.status, 200, "target of " + path);
  }
  // secondary host + legacy link: still a single hop
  const one = await get("GET", "/?lang=en&a=1", { host: "https://www.savejensen.com" });
  assert.equal(one.status, 301);
  assert.equal(one.headers.get("Location"), "https://savejensen.ai/?a=1");
  // not ours to rewrite: other values, other paths, the API, and non-GET requests
  for (const path of ["/?lang=fr", "/?lang=", "/?language=en", "/assets/site.css?lang=en", "/admin/?lang=en", "/zh/?a=1"]) {
    assert.equal((await get("GET", path)).status, 200, path);
  }
  const api = await get("GET", "/api/state?lang=en");
  assert.equal(api.status, 200);
  assert.equal(typeof api.data.cheers.total, "number");
  assert.notEqual((await get("POST", "/?lang=en", { body: {} })).status, 301);
});

const msg = (over = {}) => ({ nickname: "渲染开发者", content: "第一次用 CUDA 跑通模型的那个晚上，我决定转行。", consentPublic: true, lang: "zh", idempotencyKey: "key-0001-aaaa", ...over });

test("secondary hosts redirect permanently and keep path and query", async () => {
  const env = makeEnv();
  for (const h of ["https://www.savejensen.ai", "https://savejensen.com", "https://www.savejensen.com"]) {
    const r = await client(env)("GET", "/en/?a=1&b=two", { host: h });
    assert.equal(r.status, 301);
    assert.equal(r.headers.get("Location"), "https://savejensen.ai/?a=1&b=two");
  }
  const ok = await client(env)("GET", "/");
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("X-Content-Type-Options"), "nosniff");
  const adm = await client(env)("GET", "/admin/");
  assert.match(adm.headers.get("X-Robots-Tag"), /noindex/);
});

test("support: server-confirmed, one record per device, withdraw, same-origin only", async () => {
  const env = makeEnv();
  const a = client(env), b = client(env);
  const init = await a("GET", "/api/state");
  assert.deepEqual(init.data, { supportCount: 0, supported: false, message: null, cheers: { total: 0, mine: 0, epoch: 0 }, shares: 0 });
  assert.match(init.setCookie, /^sj_device=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Strict$/);
  assert.equal((await a("GET", "/api/state")).setCookie, null, "an existing credential is not reissued");

  assert.equal((await a("POST", "/api/support", { origin: null })).status, 403);
  assert.equal((await a("POST", "/api/support", { origin: "https://evil.example" })).status, 403);

  const first = await a("POST", "/api/support");
  assert.equal(first.status, 200);
  assert.deepEqual(first.data, { supported: true, supportCount: 1 });
  assert.equal(first.setCookie, null, "mutations never issue credentials");
  // The raw token is never stored, only a hash.
  const token = init.setCookie.split(";")[0].split("=")[1];
  assert.equal(env._db.prepare("SELECT COUNT(*) n FROM supports WHERE device_hash = ?").get(token).n, 0);

  assert.equal((await a("POST", "/api/support")).data.supportCount, 1, "repeat from the same device does not add");
  assert.equal((await b("POST", "/api/support")).data.supportCount, 2);
  assert.equal((await a("GET", "/api/state")).data.supported, true);

  assert.deepEqual((await a("DELETE", "/api/support")).data, { supported: false, supportCount: 1 });
  assert.equal((await a("GET", "/api/state")).data.supported, false);
  assert.equal((await a("POST", "/api/support")).data.supportCount, 2, "can support again after withdrawing");
});

test("messages: validation, automatic screening, immediate public display", async () => {
  const env = makeEnv();
  const a = client(env);
  assert.equal((await a("POST", "/api/messages", { body: msg({ consentPublic: false }) })).data.error, "consent_required");
  assert.equal((await a("POST", "/api/messages", { body: msg({ nickname: "a" }) })).data.error, "invalid_nickname");
  assert.equal((await a("POST", "/api/messages", { body: msg({ content: "x".repeat(281) }) })).data.error, "invalid_content");
  assert.equal((await a("POST", "/api/messages", { raw: "{not json" })).data.error, "bad_json");
  assert.equal((await a("POST", "/api/messages", { raw: JSON.stringify({ pad: "x".repeat(60000) }) })).status, 413);

  assert.equal(screen("nick", "see https://example.com now"), "blocked_link");
  assert.equal(screen("nick", "visit foo-bar.xyz"), "blocked_link");
  assert.equal(screen("nick", "mail me a@b.co"), "blocked_contact");
  assert.equal(screen("nick", "call 138 0013 8000"), "blocked_contact");
  assert.equal(screen("nick", "加微信聊"), "blocked_contact");
  assert.equal(screen("nick", "you are a BITCH"), "blocked_abuse");
  assert.equal(screen("nick", "哈哈哈哈哈哈哈哈哈哈哈哈"), "blocked_repeat");
  assert.equal(screen("渲染开发者", "The RTX 3080 got me through 2020."), null);
  assert.equal(screen("Kysely user", "I build apps in Scunthorpe."), null, "ordinary words must not be mistaken for insults");
  assert.equal(screen("开发者", "我不支持他复职，但愿意听取其他人的理由。"), null);
  assert.equal(screen("Builder", "I disagree with the request for his return."), null);
  assert.equal(screen("nick", "you are f u c k ing rude"), "blocked_abuse");
  assert.equal(screen("nick", "go to example.biz"), "blocked_link");
  assert.equal(screen("Save Jensen Team", "Welcome!"), "reserved_nickname");

  const env2 = makeEnv();
  const c = client(env2);
  assert.equal((await c("POST", "/api/messages", { body: msg({ content: "看这里 http://spam.example" }) })).status, 422);

  const xss = '<img src=x onerror=alert(1)> thanks';
  const sent = await c("POST", "/api/messages", { body: msg({ content: xss }) });
  assert.equal(sent.status, 201);
  assert.equal(sent.data.message.status, "approved");
  assert.equal(sent.data.message.content, xss, "stored as plain text; clients render with textContent");
  assert.match(sent.headers.get("Content-Type"), /application\/json/);

  const published = (await c("GET", "/api/messages")).data;
  assert.equal(published.messages.length, 1, "immediately visible without an admin action");
  assert.equal(published.messages[0].id, sent.data.message.id);
  assert.equal(published.messages[0].approvedAt, sent.data.message.createdAt);
  assert.equal((await c("GET", "/api/state")).data.message.status, "approved");

  const retry = await c("POST", "/api/messages", { body: msg({ content: xss }) });
  assert.equal(retry.status, 200);
  assert.equal(retry.data.message.id, sent.data.message.id, "same idempotency key returns the same row");
  assert.equal((await c("POST", "/api/messages", { body: msg({ idempotencyKey: "key-0002-bbbb" }) })).status, 409, "one active message per device");
  assert.equal(env2._db.prepare("SELECT COUNT(*) n FROM messages").get().n, 1);
  await c("DELETE", "/api/messages/mine");
  const withdrawnRetry = await c("POST", "/api/messages", { body: msg({ content: xss }) });
  assert.equal(withdrawnRetry.data.message.status, "withdrawn", "a late retry never republishes a withdrawn message");
  assert.equal((await c("GET", "/api/messages")).data.messages.length, 0);
});

test("admin: bearer token, approve shows on wall, withdraw removes at once and cannot be revived", async () => {
  const env = makeEnv();
  const user = client(env), adm = client(env, "198.51.100.7");
  const id = (await user("POST", "/api/messages", { body: msg() })).data.message.id;
  // Historical pending rows remain manageable after immediate publishing is enabled.
  env._db.prepare("UPDATE messages SET status = 'pending', reviewed_at = NULL WHERE id = ?").run(id);

  assert.equal((await adm("GET", "/api/admin/messages")).status, 401);
  assert.equal((await adm("GET", "/api/admin/messages", { token: "wrong" })).status, 401);
  assert.equal((await adm("GET", "/api/admin/messages?token=" + ADMIN)).status, 401, "token in URL is not accepted");
  const list = await adm("GET", "/api/admin/messages?status=pending", { token: ADMIN });
  assert.equal(list.data.messages.length, 1);
  assert.equal("device_hash" in list.data.messages[0], false);

  assert.equal((await adm("POST", `/api/admin/messages/${id}/approve`, { token: ADMIN, origin: "https://evil.example" })).status, 403);
  assert.equal((await adm("POST", `/api/admin/messages/${id}/approve`, { token: ADMIN })).data.status, "approved");
  const wall = (await user("GET", "/api/messages")).data.messages;
  assert.equal(wall.length, 1);
  assert.deepEqual(Object.keys(wall[0]).sort(), ["approvedAt", "avatar", "content", "id", "nickname"]);

  assert.equal((await adm("POST", `/api/admin/messages/${id}/hide`, { token: ADMIN })).data.status, "hidden");
  assert.equal((await user("GET", "/api/messages")).data.messages.length, 0);
  assert.equal((await adm("POST", `/api/admin/messages/${id}/approve`, { token: ADMIN })).data.status, "approved");

  assert.deepEqual((await user("DELETE", "/api/messages/mine")).data, { withdrawn: true, message: null });
  assert.equal((await user("GET", "/api/messages")).data.messages.length, 0, "gone from the wall immediately");
  assert.equal((await user("GET", "/api/state")).data.message, null);
  const revive = await adm("POST", `/api/admin/messages/${id}/approve`, { token: ADMIN });
  assert.equal(revive.status, 409);
  assert.equal(revive.data.status, "withdrawn");
  assert.equal((await user("GET", "/api/messages")).data.messages.length, 0);

  const env2 = makeEnv(); delete env2.ADMIN_TOKEN;
  assert.equal((await client(env2)("GET", "/api/admin/messages", { token: "" })).status, 503, "no token configured means admin is off");
});

test("rate limiting by short-lived IP hash; raw IP is not stored", async () => {
  const env = makeEnv();
  const ip = "192.0.2.55";
  let last;
  for (let i = 0; i < 7; i++) last = await client(env, ip)("POST", "/api/messages", { body: msg({ idempotencyKey: "key-000" + i + "-zzzz" }) });
  assert.equal(last.status, 429);
  assert.equal(last.data.error, "rate_limited");
  assert.equal((await client(env, "192.0.2.56")("POST", "/api/messages", { body: msg() })).status, 201, "another address is unaffected");
  const keys = env._db.prepare("SELECT k FROM rate_limits").all().map((r) => r.k).join(" ");
  assert.equal(keys.includes(ip), false);
});

test("regression: writes without a credential are refused and create no rows, even when concurrent", async () => {
  const env = makeEnv();
  const rows = () => env._db.prepare("SELECT (SELECT COUNT(*) FROM supports) + (SELECT COUNT(*) FROM messages) AS n").get().n;
  const fresh = () => client(env)("POST", "/api/support", { noInit: true });
  const both = await Promise.all([fresh(), fresh()]);
  assert.deepEqual(both.map((r) => r.status), [428, 428]);
  assert.equal(both[0].data.error, "device_required");
  const twoMsgs = await Promise.all([0, 1].map(() => client(env)("POST", "/api/messages", { body: msg(), noInit: true })));
  assert.deepEqual(twoMsgs.map((r) => r.status), [428, 428]);
  assert.equal((await client(env)("DELETE", "/api/support", { noInit: true })).status, 428);
  assert.equal((await client(env)("DELETE", "/api/messages/mine", { noInit: true })).status, 428);
  assert.equal(rows(), 0, "no orphan business rows");

  // One device, initialised once, then the same request fired twice at the same time.
  const c = client(env);
  await c("GET", "/api/state");
  const s2 = await Promise.all([c("POST", "/api/support"), c("POST", "/api/support")]);
  assert.deepEqual(s2.map((r) => r.data.supportCount), [1, 1]);
  const m2 = await Promise.all([c("POST", "/api/messages", { body: msg() }), c("POST", "/api/messages", { body: msg() })]);
  assert.equal(new Set(m2.map((r) => r.data.message.id)).size, 1, "same key, same row");
  assert.equal(rows(), 2, "exactly one support and one message");
});

test("regression: oversized streamed body is cut off early with 413", async () => {
  const env = makeEnv();
  const c = client(env);
  const cookie = (await c("GET", "/api/state")).setCookie.split(";")[0];
  let pulled = 0, cancelled = false;
  const total = 256; // 256 x 4 KiB = 1 MiB if fully read
  const body = new ReadableStream({
    pull(ctrl) { pulled++; if (pulled > total) ctrl.close(); else ctrl.enqueue(new Uint8Array(4096).fill(120)); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const res = await worker.fetch(new Request(ORIGIN + "/api/messages", { method: "POST", duplex: "half", body, headers: { Origin: ORIGIN, Cookie: cookie, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9" } }), env);
  assert.equal(res.status, 413);
  assert.equal(cancelled, true, "the upload is cancelled");
  assert.ok(pulled <= 14, `read ${pulled} of 256 chunks, expected to stop right after the 40 KiB limit`);
  assert.equal(env._db.prepare("SELECT COUNT(*) n FROM messages").get().n, 0);
});

test("withdrawing has its own quota and still works when the submit quota is used up", async () => {
  const env = makeEnv();
  const c = client(env, "192.0.2.77");
  assert.equal((await c("POST", "/api/messages", { body: msg() })).status, 201);
  let last;
  for (let i = 0; i < 6; i++) last = await c("POST", "/api/messages", { body: msg({ idempotencyKey: "other-key-" + i }) });
  assert.equal(last.status, 429, "submit quota exhausted");
  assert.deepEqual((await c("DELETE", "/api/messages/mine")).data, { withdrawn: true, message: null });
});

test("cheers: repeatable, server-counted, idempotent batches, withdraw cannot be replayed back", async () => {
  const env = makeEnv();
  const a = client(env), b = client(env, "203.0.113.2");
  const cheer = (c, delta, key, epoch = 0, extra = {}) => c("POST", "/api/cheer", { body: { delta, idempotencyKey: key, epoch }, ...extra });
  const counter = () => env._db.prepare("SELECT n FROM counters WHERE name='cheers'").get().n;

  assert.equal((await cheer(a, 1, "k-aaaaaaa1", 0, { noInit: true })).status, 428, "needs the device credential first");
  await a("GET", "/api/state");
  for (const bad of [0, -1, 10001, 1.5, "3", null]) assert.equal((await cheer(a, bad, "k-bad00000")).data.error, "invalid_delta");
  assert.equal((await a("POST", "/api/cheer", { body: { delta: 1, epoch: 0 } })).data.error, "invalid_key");
  assert.equal(counter(), 0);

  assert.deepEqual((await cheer(a, 7, "k-aaaaaaa1")).data, { cheers: { total: 7, mine: 7, epoch: 0 }, added: 7 });
  const again = await cheer(a, 7, "k-aaaaaaa1");
  assert.equal(again.data.duplicate, true);
  assert.equal(again.data.cheers.total, 7, "a retried batch is not counted twice");
  assert.equal((await cheer(a, 50, "k-aaaaaaa2")).data.cheers.mine, 57, "no per-device cap: the same device can keep going");
  assert.equal((await cheer(b, 3, "k-bbbbbbb1")).data.cheers.total, 60);
  assert.deepEqual((await a("GET", "/api/cheers")).data, { total: 60, shares: 0 });
  assert.deepEqual((await a("GET", "/api/state")).data.cheers, { total: 60, mine: 57, epoch: 0 });

  const w = await a("DELETE", "/api/cheer");
  assert.deepEqual(w.data.cheers, { total: 3, mine: 0, epoch: 1 });
  assert.equal((await cheer(a, 7, "k-aaaaaaa1", 0)).status, 409, "old key + old epoch is refused");
  assert.equal((await cheer(a, 5, "k-aaaaaaa9", 0)).data.error, "stale_epoch", "a batch queued before the withdraw is refused");
  assert.equal((await cheer(a, 7, "k-aaaaaaa1", 1)).data.duplicate, true, "replaying an old key under the new epoch adds nothing");
  assert.equal(counter(), 3);
  assert.equal((await a("DELETE", "/api/cheer")).data.cheers.total, 3, "withdrawing twice does not subtract twice");
  assert.equal((await cheer(a, 2, "k-aaaaaaa3", 2)).data.cheers.total, 5, "can cheer again afterwards");
});

test("super boost migration preserves old batches, totals and withdrawn epochs", () => {
  const db = new DatabaseSync(":memory:");
  for (const m of ["0001_init.sql", "0002_cheers.sql", "0003_avatars.sql"]) db.exec(readFileSync(new URL("../migrations/" + m, import.meta.url), "utf8"));
  db.exec("INSERT INTO cheer_batches VALUES ('active', 'old-active', 50, 0, 100); INSERT INTO cheer_batches VALUES ('withdrawn', 'old-withdrawn', 10, 0, 101)");
  db.exec("UPDATE counters SET n = n - 10 WHERE name = 'cheers'; UPDATE cheers SET total = 0, epoch = 1 WHERE device_hash = 'withdrawn'");
  const rows = () => db.prepare("SELECT * FROM cheer_batches ORDER BY device_hash").all();
  const devices = () => db.prepare("SELECT * FROM cheers ORDER BY device_hash").all();
  const before = { rows: rows(), devices: devices() };
  db.exec("BEGIN");
  db.exec(readFileSync(new URL("../migrations/0004_super_boost.sql", import.meta.url), "utf8"));
  db.exec("COMMIT");
  assert.deepEqual(rows(), before.rows);
  assert.deepEqual(devices(), before.devices);
  assert.equal(db.prepare("SELECT n FROM counters WHERE name='cheers'").get().n, 50, "copying history must not count it again");
  db.exec("INSERT OR IGNORE INTO cheer_batches VALUES ('active', 'old-active', 50, 0, 100)");
  db.exec("INSERT INTO cheer_batches VALUES ('active', 'new-boost', 1000, 0, 102)");
  assert.equal(db.prepare("SELECT n FROM counters WHERE name='cheers'").get().n, 1050);
  assert.equal(db.prepare("SELECT total FROM cheers WHERE device_hash='active'").get().total, 1050);
  assert.throws(() => db.exec("INSERT INTO cheer_batches VALUES ('active', 'too-large', 10001, 0, 103)"), /CHECK/);
  assert.throws(() => db.exec("INSERT INTO share_batches VALUES ('active', 'share-large', 51, 103)"), /CHECK/);
  db.close();
});

test("+10 and +1000 energy: repeated boosts, lost reply, batch bound and withdrawal stay exact", async () => {
  const env = makeEnv(), c = client(env);
  const cheer = (delta, key, epoch = 0) => c("POST", "/api/cheer", { body: { delta, idempotencyKey: key, epoch } });
  assert.equal((await cheer(10, "boost-000001")).data.cheers.total, 10);
  assert.equal((await cheer(1000, "boost-000002")).data.cheers.total, 1010);
  assert.equal((await cheer(1000, "boost-000002")).data.duplicate, true);
  env.DB.fail = { match: "INTO cheer_batches", when: "after" };
  assert.equal((await cheer(10000, "boost-000003")).status, 500);
  const retry = await cheer(10000, "boost-000003");
  assert.equal(retry.data.duplicate, true);
  assert.equal(retry.data.cheers.total, 11010, "a lost reply does not count ten boosts twice");
  assert.equal((await cheer(1000, "boost-000004")).data.cheers.total, 12010);
  assert.equal((await cheer(10001, "boost-000005")).data.error, "invalid_delta");
  const undone = await c("DELETE", "/api/cheer");
  assert.deepEqual(undone.data.cheers, { total: 0, mine: 0, epoch: 1 });
  assert.equal((await cheer(1000, "boost-000006", 0)).status, 409);
  assert.equal((await cheer(1000, "boost-000002", 1)).data.duplicate, true);
  assert.equal((await cheer(1000, "boost-000007", 1)).data.cheers.total, 1000);
});

test("share clicks: counted per press, retries not double counted, needs credential and valid delta", async () => {
  const env = makeEnv();
  const a = client(env);
  const share = (delta, key, extra = {}) => a("POST", "/api/share", { body: { delta, idempotencyKey: key }, ...extra });
  assert.equal((await share(1, "s-00000001", { noInit: true })).status, 428);
  assert.equal((await share(0, "s-00000001")).data.error, "invalid_delta");
  assert.equal((await share(99, "s-00000001")).data.error, "invalid_delta");
  assert.deepEqual((await share(2, "s-00000001")).data, { shares: 2, added: 2 });
  assert.deepEqual((await share(2, "s-00000001")).data, { shares: 2, duplicate: true });
  assert.equal((await share(1, "s-00000002")).data.shares, 3, "repeat clicks are allowed");
  assert.equal((await a("GET", "/api/state")).data.shares, 3);
  assert.equal((await a("GET", "/api/cheers")).data.shares, 3);
});

test("regression: a failed cheer/share write never loses or doubles counts on retry", async () => {
  const env = makeEnv();
  const c = client(env);
  await c("GET", "/api/state");
  const cheer = (delta, key, epoch = 0) => c("POST", "/api/cheer", { body: { delta, idempotencyKey: key, epoch } });
  const share = (delta, key) => c("POST", "/api/share", { body: { delta, idempotencyKey: key } });
  const totals = () => Object.fromEntries(env._db.prepare("SELECT name, n FROM counters").all().map((r) => [r.name, r.n]));

  env.DB.fail = { match: "INTO cheer_batches", when: "before" };
  assert.equal((await cheer(7, "f-00000001")).status, 500);
  assert.deepEqual(totals(), { cheers: 0, shares: 0 }, "nothing half-written");
  assert.deepEqual((await cheer(7, "f-00000001")).data, { cheers: { total: 7, mine: 7, epoch: 0 }, added: 7 }, "retry is counted, not treated as a duplicate");

  env.DB.fail = { match: "INTO cheer_batches", when: "after" };
  assert.equal((await cheer(5, "f-00000002")).status, 500, "write happened but the reply was lost");
  const retry = await cheer(5, "f-00000002");
  assert.equal(retry.data.duplicate, true);
  assert.equal(retry.data.cheers.total, 12, "counted exactly once");

  env.DB.fail = { match: "INTO share_batches", when: "before" };
  assert.equal((await share(2, "f-0000000s")).status, 500);
  assert.deepEqual((await share(2, "f-0000000s")).data, { shares: 2, added: 2 });
  env.DB.fail = { match: "INTO share_batches", when: "after" };
  assert.equal((await share(3, "f-0000000t")).status, 500);
  assert.deepEqual((await share(3, "f-0000000t")).data, { shares: 5, duplicate: true });
  assert.deepEqual(totals(), { cheers: 12, shares: 5 });
  assert.equal(env._db.prepare("SELECT total FROM cheers").get().total, 12, "device total matches the site total");
});

test("regression: withdraw wins every race; first-time withdraw leaves a tombstone; old keys never replay", async () => {
  const env = makeEnv();
  const c = client(env);
  await c("GET", "/api/state");
  const cheer = (delta, key, epoch) => c("POST", "/api/cheer", { body: { delta, idempotencyKey: key, epoch } });
  const site = () => env._db.prepare("SELECT n FROM counters WHERE name='cheers'").get().n;

  // Withdraw before ever cheering: a batch created earlier (epoch 0) must still be refused afterwards.
  assert.deepEqual((await c("DELETE", "/api/cheer")).data.cheers, { total: 0, mine: 0, epoch: 1 });
  const late = await cheer(7, "r-00000001", 0);
  assert.equal(late.status, 409);
  assert.equal(late.data.error, "stale_epoch");
  assert.equal(site(), 0);

  // Have 3, a +7 created under that epoch is paused, the withdraw lands first, then the +7 arrives.
  assert.equal((await cheer(3, "r-00000002", 1)).data.cheers.total, 3);
  assert.deepEqual((await c("DELETE", "/api/cheer")).data.cheers, { total: 0, mine: 0, epoch: 2 });
  assert.equal((await cheer(7, "r-00000003", 1)).status, 409, "the paused batch does not bring cheers back");
  assert.equal(site(), 0);

  // Keys are kept for good: replaying an old key under the current epoch adds nothing, however old it is.
  assert.equal((await cheer(5, "r-00000004", 2)).data.cheers.total, 5);
  env._db.exec("UPDATE cheer_batches SET created_at = created_at - 30 * 86400000");
  for (let i = 0; i < 200; i++) await c("GET", "/api/cheers");
  const replay = await cheer(5, "r-00000004", 2);
  assert.equal(replay.data.duplicate, true);
  assert.equal(replay.data.cheers.total, 5, "still 5, not 10");
  assert.equal((await cheer(1, "x", 2)).data.error, "invalid_key");
  assert.equal((await c("POST", "/api/cheer", { body: { delta: 1, idempotencyKey: "r-00000009" } })).data.error, "invalid_epoch");
});

// A structurally valid baseline JPEG header (SOI, SOF0 with the given size, padding, EOI). Enough for the server's checks.
function fakeJpeg(w, h, pad = 120) {
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0];
  const com = [0xff, 0xfe, (pad + 2) >> 8, (pad + 2) & 255, ...new Array(pad).fill(0x20)];
  return Buffer.from([0xff, 0xd8, ...com, ...sof, 0xff, 0xd9]);
}
const b64 = (buf) => Buffer.from(buf).toString("base64");

test("avatar: validated on the server, public only while approved, deleted on withdraw", async () => {
  const env = makeEnv();
  const user = client(env), other = client(env, "203.0.113.50"), adm = client(env, "198.51.100.7");
  const send = (c, avatar, key) => c("POST", "/api/messages", { body: msg({ avatar, idempotencyKey: key }) });
  const rows = () => env._db.prepare("SELECT COUNT(*) n FROM message_avatars").get().n;
  let badN = 0;

  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>'.padEnd(200));
  const html = Buffer.from("<!doctype html><script>alert(1)</script>".padEnd(200));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(200).fill(0)]);
  for (const [name, a] of Object.entries({
    svg: { mime: "image/svg+xml", data: b64(svg) }, svgAsJpeg: { mime: "image/jpeg", data: b64(svg) }, html: { mime: "image/jpeg", data: b64(html) },
    png: { mime: "image/png", data: b64(png) }, tooWide: { mime: "image/jpeg", data: b64(fakeJpeg(512, 96)) }, tooSmall: { mime: "image/jpeg", data: b64(fakeJpeg(8, 8)) },
    tooBig: { mime: "image/jpeg", data: b64(fakeJpeg(96, 96, 25000)) }, wrongMime: { mime: "image/webp", data: b64(fakeJpeg(96, 96)) },
    notBase64: { mime: "image/jpeg", data: "<svg>" }, noData: { mime: "image/jpeg" }, string: "data:image/jpeg;base64,AAAA",
  })) {
    const r = await send(client(env, "203.0.114." + (++badN)), a, "av-bad-" + name.padEnd(8, "0"));
    assert.equal(r.status, 422, name);
    assert.equal(r.data.error, "invalid_avatar", name);
  }
  assert.equal(rows(), 0);
  assert.equal(env._db.prepare("SELECT COUNT(*) n FROM messages").get().n, 0, "a rejected avatar does not leave a message behind");

  const jpeg = fakeJpeg(96, 96);
  const sent = await send(other, { mime: "image/jpeg", data: b64(jpeg) }, "av-good-0001");
  assert.equal(sent.status, 201);
  assert.equal(sent.data.message.hasAvatar, true);
  const id = sent.data.message.id;
  assert.equal(rows(), 1);
  const again = await send(other, { mime: "image/jpeg", data: b64(jpeg) }, "av-good-0001");
  assert.equal(again.data.duplicate, true);
  assert.equal(again.data.message.hasAvatar, true, "a retried submit reports the avatar too");
  const second = await send(other, undefined, "av-good-0002");
  assert.equal(second.status, 409);
  assert.equal(second.data.message.hasAvatar, true, "and so does the 409 for an existing message");
  assert.equal(rows(), 1);
  assert.equal((await other("GET", "/api/state")).data.message.hasAvatar, true);

  assert.equal((await user("GET", "/api/avatars/" + id)).status, 200, "avatar publishes with its message");
  assert.equal((await adm("GET", `/api/admin/messages/${id}/avatar`)).status, 401);
  const forAdmin = await worker.fetch(new Request(ORIGIN + `/api/admin/messages/${id}/avatar`, { headers: { Authorization: "Bearer " + ADMIN, "CF-Connecting-IP": "198.51.100.7" } }), env);
  assert.equal(forAdmin.status, 200);
  assert.equal((await adm("GET", "/api/admin/messages?status=approved", { token: ADMIN })).data.messages[0].hasAvatar, true);

  const pub = await worker.fetch(new Request(ORIGIN + "/api/avatars/" + id), env);
  assert.equal(pub.status, 200);
  assert.equal(pub.headers.get("Content-Type"), "image/jpeg");
  assert.equal(pub.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(pub.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(Buffer.from(await pub.arrayBuffer()), jpeg);
  assert.equal((await user("GET", "/api/messages")).data.messages[0].avatar, true);

  await adm("POST", `/api/admin/messages/${id}/hide`, { token: ADMIN });
  assert.equal((await user("GET", "/api/avatars/" + id)).status, 404, "hidden: not public");
  await adm("POST", `/api/admin/messages/${id}/approve`, { token: ADMIN });
  assert.equal((await user("GET", "/api/avatars/" + id)).status, 200);

  assert.equal((await other("DELETE", "/api/messages/mine")).data.withdrawn, true);
  assert.equal((await user("GET", "/api/avatars/" + id)).status, 404, "withdrawn: not public");
  assert.equal(rows(), 0, "and the bytes are gone");
  const gone = await worker.fetch(new Request(ORIGIN + `/api/admin/messages/${id}/avatar`, { headers: { Authorization: "Bearer " + ADMIN, "CF-Connecting-IP": "198.51.100.7" } }), env);
  assert.equal(gone.status, 404);

  const plain = await send(user, undefined, "av-none-0001");
  assert.equal(plain.status, 201);
  assert.equal(plain.data.message.hasAvatar, false, "avatar stays optional");
});

test("regression: wall pagination does not drop rows that share one reviewed_at", async () => {
  const env = makeEnv();
  const ins = env._db.prepare("INSERT INTO messages (id, device_hash, nickname, content, lang, status, consent_public, created_at, reviewed_at) VALUES (?, ?, 'n', ?, 'zh', 'approved', 1, ?, ?)");
  const ids = [];
  for (let i = 0; i < 45; i++) {
    const id = "00000000-0000-4000-8000-" + String(i).padStart(12, "0");
    ids.push(id);
    ins.run(id, "dev" + i, "m" + i, 1000 + i, i < 42 ? 5000 : 4000 + i); // 42 rows with the same reviewed_at
  }
  const c = client(env);
  const seen = [];
  let next = "", pages = 0;
  do {
    const r = await c("GET", "/api/messages" + (next ? "?before=" + encodeURIComponent(next) : ""));
    assert.ok(r.data.messages.length <= 20);
    seen.push(...r.data.messages.map((m) => m.id));
    next = r.data.next;
    pages++;
  } while (next && pages < 10);
  assert.equal(pages, 3);
  assert.equal(seen.length, 45);
  assert.equal(new Set(seen).size, 45, "no duplicates");
  assert.deepEqual([...seen].sort(), [...ids].sort(), "nothing skipped");
  assert.equal((await c("GET", "/api/messages?before=garbage")).data.messages.length, 20, "a malformed cursor falls back to the first page");
});


test("HEAD uses the same one-hop locale redirect; explicit language wins on all host aliases", async () => {
  const get = client(makeEnv());
  for (const host of ["https://savejensen.ai", "https://www.savejensen.ai", "https://savejensen.com", "https://www.savejensen.com"]) {
    for (const method of ["GET", "HEAD"]) {
      const r = await get(method, "/en/index.html?lang=zh&ref=post", { host });
      assert.equal(r.status, 301);
      assert.equal(r.headers.get("Location"), "https://savejensen.ai/zh/?ref=post");
    }
  }
  for (const path of ["/", "/zh/"]) assert.equal((await get("GET", path)).status, 200);
  assert.notEqual((await get("POST", "/en/", { body: {} })).status, 301);
});

const joinBoard = (nickname, expectedVersion=0) => ({ nickname, consentPublic:true, expectedVersion });
const boost = (delta,key='board-boost-001',epoch=0) => ({delta,idempotencyKey:key,epoch});
test('leaderboard: opt-in, private identifiers, consent, late join after leaving, energy stays intact',async()=>{
 const env=makeEnv(),a=client(env),anon=client(env,'203.0.113.2');
 assert.equal((await anon('PUT','/api/leaderboard/profile',{body:joinBoard('Anon'),noInit:true})).status,428);
 await a('POST','/api/cheer',{body:boost(1000)});
 assert.deepEqual((await anon('GET','/api/leaderboard')).data.entries,[]);
 assert.equal((await a('PUT','/api/leaderboard/profile',{body:{...joinBoard('Ada'),consentPublic:false}})).status,400);
 assert.equal((await a('PUT','/api/leaderboard/profile',{body:joinBoard('Save Jensen Team')})).data.error,'reserved_nickname');
 let j=await a('PUT','/api/leaderboard/profile',{body:joinBoard('Ada')});assert.equal(j.status,200);assert.equal(j.data.profile.version,1);
 let board=(await a('GET','/api/leaderboard')).data;assert.equal(board.mine.rank,1);assert.equal(board.entries[0].energy,1000);
 let pub=(await anon('GET','/api/leaderboard')).data;assert.equal(pub.mine,null);assert.equal(pub.profile,null);
 assert.equal(/device_hash|idem_key|sj_device/.test(JSON.stringify(pub)),false);
 await a('DELETE','/api/leaderboard/profile');
 assert.equal((await a('PUT','/api/leaderboard/profile',{body:joinBoard('Ada')})).status,409);
 board=(await a('GET','/api/leaderboard')).data;assert.equal(board.profile.enabled,false);assert.equal(board.entries.length,0);
 assert.equal((await a('GET','/api/state')).data.cheers.mine,1000);
 j=await a('PUT','/api/leaderboard/profile',{body:joinBoard('Ada',board.profile.version)});assert.equal(j.status,200);
 assert.equal((await a('GET','/api/leaderboard')).data.entries.length,1);
 assert.equal((await a('GET','/api/leaderboard')).data.mine.energy,1000);
 // A leave arriving before the very first join also leaves a version tombstone.
 await anon('DELETE','/api/leaderboard/profile');
 assert.equal((await anon('PUT','/api/leaderboard/profile',{body:joinBoard('Another')})).status,409);
});

test('leaderboard: UTC boundary, cross-day retry, withdrawal epochs, zero score and new contribution',async()=>{
 const oldNow=Date.now;let t=Date.UTC(2026,10,13)-1;Date.now=()=>t;
 try{
 const env=makeEnv(),a=client(env);
 await a('PUT','/api/leaderboard/profile',{body:joinBoard('Builder')});
 await a('POST','/api/cheer',{body:boost(1000)});
 assert.equal((await a('GET','/api/leaderboard?period=today')).data.mine.energy,1000);
 t++;
 assert.equal((await a('GET','/api/leaderboard?period=today')).data.mine,null);
 assert.equal((await a('GET','/api/leaderboard?period=today')).data.day,'2026-11-13');
 await a('POST','/api/cheer',{body:boost(1000)});
 assert.equal((await a('GET','/api/leaderboard?period=today')).data.mine,null);
 await a('POST','/api/cheer',{body:boost(10,'board-newday-001')});
 assert.equal((await a('GET','/api/leaderboard?period=today')).data.mine.energy,10);
 assert.equal((await a('GET','/api/leaderboard')).data.mine.energy,1010);
 await a('DELETE','/api/cheer');
 for(const q of ['','?period=today'])assert.equal((await a('GET','/api/leaderboard'+q)).data.mine,null);
 assert.equal((await a('POST','/api/cheer',{body:boost(1000,'late-old-epoch')})).status,409);
 await a('POST','/api/cheer',{body:boost(1000,'new-epoch-001',1)});
 for(const q of ['','?period=today'])assert.equal((await a('GET','/api/leaderboard'+q)).data.mine.energy,1000);
 }finally{Date.now=oldNow}
});

test('leaderboard: deterministic ties, bounded top 20, own rank outside top and gap',async()=>{
 const env=makeEnv();let last;
 for(let i=0;i<25;i++){
  const a=client(env,'203.0.113.'+(i+1));
  await a('PUT','/api/leaderboard/profile',{body:joinBoard('Builder '+i)});
  const r=await a('POST','/api/cheer',{body:boost(i<2?1000:1000-i*10)});assert.equal(r.status,200);
  last=a;
 }
 const board=(await last('GET','/api/leaderboard')).data;
 assert.equal(board.entries.length,20);assert.equal(board.entries[0].rank,1);assert.equal(board.entries[1].rank,1);assert.equal(board.entries[2].rank,3);
 assert.equal(board.mine.rank,25);assert.equal(board.mine.energy,760);assert.equal(board.mine.toNext,20);
 assert.deepEqual((await last('GET','/api/leaderboard')).data.entries.map(e=>e.id),board.entries.map(e=>e.id));
 assert.equal(board.entries.some(e=>e.id===board.mine.id),false);
});

test('leaderboard: administrator hiding cannot be self-overridden or expose another device',async()=>{
 const env=makeEnv(),a=client(env),b=client(env,'203.0.113.2'),admin=client(env,'203.0.113.9');
 await a('PUT','/api/leaderboard/profile',{body:joinBoard('Builder A')});await a('POST','/api/cheer',{body:boost(1000)});
 const before=(await a('GET','/api/leaderboard')).data;
 assert.equal((await admin('POST','/api/admin/leaderboard/'+before.profile.id+'/hide')).status,401);
 assert.equal((await admin('POST','/api/admin/leaderboard/'+before.profile.id+'/hide',{token:ADMIN})).status,200);
 const hidden=(await a('GET','/api/leaderboard')).data;assert.equal(hidden.mine,null);assert.equal(hidden.entries.length,0);
 assert.equal((await a('PUT','/api/leaderboard/profile',{body:joinBoard('New name',hidden.profile.version)})).data.error,'profile_hidden');
 await b('DELETE','/api/leaderboard/profile');
 assert.equal((await a('GET','/api/leaderboard')).data.profile.hidden,true);
 await a('DELETE','/api/leaderboard/profile');
 const search=(await admin('GET','/api/admin/leaderboard?q='+before.profile.id,{token:ADMIN})).data.profiles;
 assert.equal(search.length,1);assert.equal(search[0].enabled,false);assert.equal(search[0].hidden,true);
 assert.equal((await admin('GET','/api/admin/leaderboard',{token:ADMIN})).data.profiles.length,0);
 await admin('POST','/api/admin/leaderboard/'+before.profile.id+'/restore',{token:ADMIN});
 assert.equal((await a('GET','/api/leaderboard')).data.entries.length,0,'admin restore respects user opt-out');
 assert.equal((await a('GET','/api/state')).data.cheers.mine,1000);
 assert.equal((await a('GET','/api/leaderboard?period=bad')).status,400);
});

test('leaderboard: avatar belongs to current device and disappears on message hide/withdraw',async()=>{
 const env=makeEnv(),a=client(env),b=client(env,'203.0.113.2'),admin=client(env,'203.0.113.9');
 const post=await a('POST','/api/messages',{body:msg({avatar:{mime:'image/jpeg',data:b64(fakeJpeg(96,96))}})});
 assert.equal(post.status,201);
 await a('PUT','/api/leaderboard/profile',{body:joinBoard('Avatar owner')});await a('POST','/api/cheer',{body:boost(1000)});
 await b('PUT','/api/leaderboard/profile',{body:{...joinBoard('Other supporter'),avatarId:post.data.message.id}});await b('POST','/api/cheer',{body:boost(10)});
 assert.equal((await a('GET','/api/leaderboard')).data.mine.avatarId,post.data.message.id);
 assert.equal((await b('GET','/api/leaderboard')).data.mine.avatarId,null);
 await admin('POST','/api/admin/messages/'+post.data.message.id+'/hide',{token:ADMIN});
 assert.equal((await a('GET','/api/leaderboard')).data.mine.avatarId,null);
 await admin('POST','/api/admin/messages/'+post.data.message.id+'/approve',{token:ADMIN});
 await a('DELETE','/api/messages/mine');
 assert.equal((await a('GET','/api/leaderboard')).data.mine.avatarId,null);
 assert.equal((await a('GET','/api/leaderboard')).data.mine.energy,1000);
});
