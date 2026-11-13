// Static SEO checks on the built deploy package (server/public). Run the build first.
// Run: node --test work/save-jensen/server/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const PUB = fileURLToPath(new URL("../public/", import.meta.url));
const SITE = "https://savejensen.ai";
const MODIFIED = "2026-11-13";
const read = (p) => readFileSync(join(PUB, p), "utf8");
const CJK = /[㐀-鿿]/;
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function parse(file) {
  const html = read(file);
  const head = html.slice(0, html.indexOf("</head>"));
  const tags = (re) => [...head.matchAll(re)].map((m) => m[1]);
  const meta = (attr, name) => tags(new RegExp(`<meta ${attr}="${name}" content="([^"]*)">`, "g")).map(unesc);
  const one = (list, what) => { assert.equal(list.length, 1, `${file}: exactly one ${what}, got ${list.length}`); return list[0]; };
  const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
  return {
    file, html,
    lang: one([...html.matchAll(/<html lang="([^"]+)"/g)].map((m) => m[1]), "html lang"),
    title: unesc(one(tags(/<title>([^<]*)<\/title>/g), "title")),
    desc: one(meta("name", "description"), "description"),
    robots: one(meta("name", "robots"), "robots meta"),
    canonical: one(tags(/<link rel="canonical" href="([^"]*)">/g), "canonical"),
    hreflang: [...head.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g)].map((m) => m[1] + " " + m[2]).sort(),
    og: (k) => one(meta("property", "og:" + k), "og:" + k),
    tw: (k) => one(meta("name", "twitter:" + k), "twitter:" + k),
    graph: one(ld, "JSON-LD block")["@graph"],
    context: ld[0]["@context"],
    imgs: [...html.matchAll(/<img\b[^>]*>/g)].map((m) => Object.fromEntries([...m[0].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], unesc(a[2])]))),
  };
}

const zh = parse("zh/index.html"), en = parse("index.html");
const PAGES = [[zh, SITE + "/zh/", "zh-CN", "zh-Hans", "zh_CN"], [en, SITE + "/", "en", "en", "en_US"]];
const HREFLANG = [`en ${SITE}/`, `x-default ${SITE}/`, `zh-Hans ${SITE}/zh/`];

function jpegSize(buf) {       // real dimensions from the SOF marker
  let i = 2;
  while (i < buf.length) {
    assert.equal(buf[i], 0xff);
    const m = buf[i + 1], len = buf.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
    i += 2 + len;
  }
  throw new Error("no SOF");
}

test("each language has its own title, description, canonical and social tags", () => {
  for (const [p, url, htmlLang, , locale] of PAGES) {
    assert.equal(p.lang, htmlLang);
    assert.equal(p.canonical, url, "self-canonical on the HTTPS primary host");
    assert.equal(p.og("url"), url);
    assert.equal(p.og("locale"), locale);
    assert.equal(p.og("site_name"), "Save Jensen");
    assert.equal(p.og("type"), "website");
    assert.equal(p.tw("card"), "summary_large_image");
    assert.equal(p.tw("title"), p.og("title"));
    assert.equal(p.tw("description"), p.og("description"));
    assert.equal(p.tw("image"), p.og("image"));
    assert.match(p.robots, /^index, follow/);
    assert.ok(p.title.startsWith("Save Jensen"), "the site name leads the title");
    for (const k of ["title", "desc"]) assert.ok(p[k].length > 20);
    assert.ok(!p.html.includes("data-en"), "no untranslated template attributes");
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(p.html), "no unfilled placeholders");
  }
  for (const s of [zh.title, zh.desc, zh.og("title"), zh.og("description"), zh.og("image:alt"), zh.tw("image:alt")]) assert.ok(CJK.test(s), "Chinese page text is Chinese: " + s);
  for (const s of [en.title, en.desc, en.og("title"), en.og("description"), en.og("image:alt"), en.tw("image:alt")]) assert.ok(!CJK.test(s), "English page text is English: " + s);
  assert.ok(en.title.length <= 65, "English title fits a result line: " + en.title.length);
  assert.ok(en.desc.length <= 200, "English description is not cut hard: " + en.desc.length);
  assert.ok(zh.title.length <= 45 && zh.desc.length <= 110);
  assert.notEqual(zh.title, en.title);
  assert.notEqual(zh.desc, en.desc);
});

test("hreflang is the same complete set on both pages and in the sitemap", () => {
  assert.deepEqual(zh.hreflang, HREFLANG);
  assert.deepEqual(en.hreflang, HREFLANG);
  const sm = read("sitemap.xml");
  const urls = [...sm.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => m[1]);
  assert.deepEqual(urls.map((u) => /<loc>([^<]+)<\/loc>/.exec(u)[1]), [SITE + "/", SITE + "/zh/"], "only the two indexable pages");
  for (const u of urls) {
    assert.equal(/<lastmod>([^<]+)<\/lastmod>/.exec(u)[1], MODIFIED);
    assert.deepEqual([...u.matchAll(/hreflang="([^"]+)" href="([^"]+)"/g)].map((m) => m[1] + " " + m[2]).sort(), HREFLANG);
  }
  assert.ok(!/admin|\/api|[?&]lang=/.test(sm));
});

test("robots.txt, the admin page and the 404 page", () => {
  const lines = read("robots.txt").trim().split("\n").filter(Boolean);
  assert.deepEqual(lines, ["User-agent: *", "Allow: /", "Disallow: /api/", `Sitemap: ${SITE}/sitemap.xml`]);
  // /admin/ must stay crawlable so that its noindex can be read
  assert.match(read("admin/index.html"), /<meta name="robots" content="noindex, nofollow">/);
  const nf = read("404.html");
  assert.match(nf, /<meta name="robots" content="noindex">/);
  assert.ok(!/rel="canonical"|application\/ld\+json/.test(nf));
});

test("crawlable body: one h1, the real sections, and every image has alt and size", () => {
  for (const [p] of PAGES) {
    assert.equal((p.html.match(/<h1\b/g) || []).length, 1);
    for (const id of ["rally", "timeline", "hub", "support", "letter", "discord"]) assert.ok(p.html.includes(`id="${id}"`), id);
    assert.ok((p.html.match(/<h2\b/g) || []).length >= 6);
    assert.ok(p.html.includes("nvidianews.nvidia.com"), "the timeline is prerendered with its sources");
    assert.equal(p.imgs.length, 5);
    for (const im of p.imgs) {
      assert.ok(im.alt && im.alt.length > 8, "alt: " + im.src);
      assert.ok(Number(im.width) > 0 && Number(im.height) > 0, "size: " + im.src);
      const f = im.src.split("assets/")[1];
      assert.deepEqual(jpegSize(readFileSync(join(PUB, "assets", f))), [Number(im.width), Number(im.height)], "declared size is the real size: " + f);
    }
    assert.equal(p.imgs.filter((im) => im.loading !== "lazy").length, 1, "only the hero image loads eagerly");
  }
  assert.ok(zh.imgs.every((im) => CJK.test(im.alt)) && en.imgs.every((im) => !CJK.test(im.alt)));
  const h1 = (p) => /<h1\b[^>]*>([^<]*)</.exec(p.html)[1];
  assert.ok(CJK.test(h1(zh)) && !CJK.test(h1(en)));
});

test("the share image is a public 1200x630 JPEG at the declared address", () => {
  for (const [p] of PAGES) {
    assert.equal(p.og("image"), SITE + "/assets/og-save-jensen.jpg");
    assert.deepEqual([p.og("image:width"), p.og("image:height"), p.og("image:type")], ["1200", "630", "image/jpeg"]);
  }
  assert.deepEqual(jpegSize(readFileSync(join(PUB, "assets/og-save-jensen.jpg"))), [1200, 630]);
  assert.ok(!/assets/.test(read("robots.txt")), "assets are not blocked");
});

test("JSON-LD: types, references, URLs and language match the page", () => {
  const BANNED = /Organization|Rating|Review|FAQ|Question|Article|SearchAction|potentialAction|InteractionCounter|interactionStatistic|DonateAction|MonetaryAmount|signature|jobTitle|worksFor/;
  for (const [p, url, , hreflang] of PAGES) {
    assert.equal(p.context, "https://schema.org");
    const raw = JSON.stringify(p.graph);
    // creator of one photo is a government office: that is photo credit, not a claim about this site
    assert.ok(!BANNED.test(raw.replace(/"creator":\{"@type":"Organization"/g, "")), "no invented entities or numbers");
    const ids = new Map(p.graph.flatMap((n) => [n, ...(Array.isArray(n.image) ? n.image : [])]).filter((n) => n["@id"] && Object.keys(n).length > 1).map((n) => [n["@id"], n]));
    const refs = [];
    (function walk(v) { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") { if (v["@id"] && Object.keys(v).length === 1) refs.push(v["@id"]); Object.values(v).forEach(walk); } })(p.graph);
    assert.ok(refs.length >= 6);
    for (const r of refs) assert.ok(ids.has(r), `${p.file}: reference ${r} is defined in the same graph`);
    for (const id of ids.keys()) assert.ok(id.startsWith(SITE + "/"), id);

    const site = ids.get(SITE + "/#website"), page = ids.get(url + "#webpage"), person = ids.get(SITE + "/#jensen-huang");
    assert.equal(site["@type"], "WebSite");
    assert.equal(site.name, "Save Jensen");
    assert.equal(site.url, SITE + "/");
    assert.ok(!("publisher" in site) && !("potentialAction" in site));
    assert.deepEqual(page["@type"], ["AboutPage", "CollectionPage"]);
    assert.equal(page.url, p.canonical);
    assert.equal(page.name, p.title);
    assert.equal(page.description, p.desc);
    assert.equal(page.inLanguage, hreflang);
    assert.equal(page.dateModified, MODIFIED);
    assert.ok(!("datePublished" in page) && !("author" in page));
    assert.equal(person["@type"], "Person");
    assert.ok(p.html.includes(person.name), "the person's name is on the page");
    assert.deepEqual(Object.keys(person).sort(), ["@id", "@type", "alternateName", "image", "name", "subjectOf"]);

    // images: exactly the photos shown on the page, with the visible alt text, real size and licence data
    const shown = new Map(p.imgs.map((im) => [im.src.split("assets/")[1], im]));
    assert.equal(page.image.length, shown.size);
    for (const io of page.image) {
      const f = io.contentUrl.split("/assets/")[1], im = shown.get(f);
      assert.ok(im, "image is on the page: " + f);
      assert.ok(existsSync(join(PUB, "assets", f)));
      assert.equal(io.caption, im.alt);
      assert.deepEqual([io.width, io.height], [Number(im.width), Number(im.height)]);
      for (const k of ["license", "acquireLicensePage", "creditText", "copyrightNotice"]) assert.ok(io[k], k);
      assert.match(io.license, /^https:\/\/creativecommons\.org\//);
    }
    assert.equal(page.primaryImageOfPage["@id"], SITE + "/assets/jensen-sc18.jpg#image");
  }
  const personName = (p) => p.graph.find((n) => n["@type"] === "Person").name;
  assert.equal(personName(zh), "黄仁勋");
  assert.equal(personName(en), "Jensen Huang");
});

test("the deploy package holds only the whitelisted files", () => {
  const all = [];
  (function walk(d, rel) { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p, rel + f + "/") : all.push(rel + f); } })(PUB, "");
  assert.equal(all.length, 17);
  assert.ok(all.every((f) => /\.(html|css|js|jpg|png|txt|xml)$/.test(f)), "no internal documents");
});


test("default English and Chinese links, direct giving and immutable letter", () => {
  const data = JSON.parse(readFileSync(new URL("../../src/data.json", import.meta.url), "utf8"));
  for (const [p, language, switchTo] of [[en, "en", "zh/"], [zh, "zh", "../"]]) {
    assert.ok(p.html.includes('id="langBtn" href="' + switchTo + '"'));
    assert.ok(p.html.includes('id="give"'));
    for (const url of ["https://github.com/chatjesus/save-jensen", "https://numfocus.org/donate", "https://numfocus.org/donate-to-numpy", "https://numfocus.org/donate-to-scikit-learn"]) assert.ok(p.html.includes('href="' + url + '"'));
    const letters = JSON.parse(/id="sj-letters">([\s\S]*?)<\/script>/.exec(p.html)[1]);
    assert.deepEqual(letters, data.LET);
    assert.ok(p.html.includes(language === "en" ? "receives no money or commission" : "不经手资金"));
  }
  assert.ok(!existsSync(join(PUB, "en")), "old English path is handled by Worker, not a duplicate page");
});
