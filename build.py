#!/usr/bin/env python3
"""Build English / and Chinese /zh/ into server/public.
Run: python3 build.py. Only whitelisted public assets are emitted.
"""
import html, json, os, re, shutil, struct, zlib
from html.parser import HTMLParser

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'src')
PUB = os.path.join(HERE, 'server', 'public')
PHOTOS = os.path.join(SRC, 'photos')
SITE = 'https://savejensen.ai'
MODIFIED = '2026-11-13'  # the day the page itself last changed (Beijing time); set by hand, never from the build clock
CHECKED = {'zh': '2026-11-12 约 21:58（北京时间 UTC+8，人工核查）', 'en': 'Nov 12, 2026, about 21:58 Beijing time (UTC+8), manually checked'}
E = lambda s: html.escape(str(s), quote=True)

PAGE = {
    'zh': dict(path='/zh/', html_lang='zh-CN', hreflang='zh-Hans', og_locale='zh_CN', root='../', alt_href='../', alt_lang='en', alt_text='EN', alt_label='Switch to English', self_href='./',
               title='Save Jensen · 支持者社区｜支持黄仁勋重返领导岗位：时间线、应援与公开信',
               desc='Save Jensen 是由支持者发起的社区。NVIDIA 已于 2026 年 11 月 12 日宣布黄仁勋辞任；我们表达感谢，并希望他重返领导岗位、继续推动 AI。站内有按来源核对的时间线、应援与留言、已发出的公开信。',
               og_title='Save Jensen · 支持者社区｜支持黄仁勋重返领导岗位，继续推动 AI', og_desc='由支持者发起。NVIDIA 已于 2026-11-12 宣布其辞任；我们表达感谢，并希望他回来继续推动 AI。',
               og_alt='黄仁勋身穿黑色皮衣站在舞台上（SC18，2018 年，档案照片）', person='黄仁勋', person_alt='Jensen Huang', site_desc='由支持者发起的独立社区：支持黄仁勋重返领导岗位，继续推动 AI。'),
    'en': dict(path='/', html_lang='en', hreflang='en', og_locale='en_US', root='', alt_href='zh/', alt_lang='zh-CN', alt_text='中文', alt_label='切换到中文', self_href='./',
               title='Save Jensen — Bring Jensen Huang Back | Supporters Community',
               desc='A community started by supporters. NVIDIA announced Jensen Huang’s resignation on Nov 12, 2026; we ask for his return. Source-checked timeline, cheers, messages and our open letter to NVIDIA.',
               og_title='Save Jensen · Supporters community — Bring Jensen back. Keep building AI.', og_desc='Started by supporters. NVIDIA announced his resignation on Nov 12, 2026; we say thank you and ask for his return to keep building AI.',
               og_alt='Jensen Huang on stage in a black leather jacket (SC18, 2018, archive photo)', person='Jensen Huang', person_alt='黄仁勋', site_desc='An independent community started by supporters: bring Jensen Huang back, keep building AI.'),
}

IMAGES = [  # file, w, h, creator type/name, license, source page, credit text
    ('jensen-sc18.jpg', 1280, 848, 'Person', 'Raysonho', 'https://creativecommons.org/publicdomain/zero/1.0/', 'https://commons.wikimedia.org/wiki/File:JensenHuangSC18.jpg', 'Raysonho @ Open Grid Scheduler / Scalable Grid Engine (CC0 1.0)'),
    ('jensen-stanford-students.jpg', 1280, 960, 'Person', 'Anders Eidesvik', 'https://creativecommons.org/licenses/by-sa/4.0/', 'https://commons.wikimedia.org/wiki/File:Jensen_huang_stanford_2026-04-30_024.jpg', 'Anders Eidesvik (CC BY-SA 4.0)'),
    ('jensen-award-2023.jpg', 1350, 1464, 'Organization', '總統府 (Office of the President, Taiwan)', 'https://creativecommons.org/licenses/by/2.0/', 'https://commons.wikimedia.org/wiki/File:Jensen_Huang_20231109.jpg', '總統府 / Office of the President, Taiwan; crop by Yu tptw (CC BY 2.0)'),
    ('jensen-stanford-panorama.jpg', 1280, 408, 'Person', 'Anders Eidesvik', 'https://creativecommons.org/licenses/by-sa/4.0/', 'https://commons.wikimedia.org/wiki/File:Jensen_huang_stanford_2026-04-30_014.jpg', 'Anders Eidesvik (CC BY-SA 4.0)'),
    ('jensen-stanford-portrait.jpg', 960, 1280, 'Person', 'Anders Eidesvik', 'https://creativecommons.org/licenses/by-sa/4.0/', 'https://commons.wikimedia.org/wiki/File:Jensen_huang_stanford_2026-04-30_008.jpg', 'Anders Eidesvik (CC BY-SA 4.0)'),
]

VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'}
ATTR_SWAP = {'data-en-placeholder': 'placeholder', 'data-en-label': 'aria-label', 'data-en-alt': 'alt'}


class Localizer(HTMLParser):
    """Emit the template in one language: Chinese keeps element content, English swaps in data-en."""

    def __init__(self, lang):
        super().__init__(convert_charrefs=False)
        self.lang, self.out, self.skip = lang, [], 0

    def handle_starttag(self, tag, attrs):
        if self.skip:
            if tag not in VOID:
                self.skip += 1
            return
        d = dict(attrs)
        if not any(k == 'data-en' or k in ATTR_SWAP for k in d):
            self.out.append(self.get_starttag_text())
            return
        en_html = d.pop('data-en', None)
        for k, target in ATTR_SWAP.items():
            if k in d:
                v = d.pop(k)
                if self.lang == 'en':
                    d[target] = v
        self.out.append('<' + tag + ''.join(' %s' % k if v is None else ' %s="%s"' % (k, E(v)) for k, v in d.items()) + '>')
        if en_html is not None and self.lang == 'en':
            self.out.append(en_html)
            if tag not in VOID:
                self.skip = 1

    def handle_endtag(self, tag):
        if self.skip:
            self.skip -= 1
            if self.skip:
                return
        self.out.append('</%s>' % tag)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)

    def _raw(self, s):
        if not self.skip:
            self.out.append(s)

    def handle_data(self, d): self._raw(d)
    def handle_entityref(self, n): self._raw('&%s;' % n)
    def handle_charref(self, n): self._raw('&#%s;' % n)
    def handle_comment(self, d): self._raw('<!--%s-->' % d)
    def handle_decl(self, d): self._raw('<!%s>' % d)


def localize(tpl, lang):
    p = Localizer(lang)
    p.feed(tpl)
    p.close()
    return ''.join(p.out)


# ---------- prerendered content ----------
TZ = {'EST': -5, 'EDT': -4, 'PST': -8, 'PDT': -7, 'PT': -8, 'ET': -5, 'GMT': 0, 'UTC': 0}


def utc_ms(published):
    """Published time as shown on the source page -> UTC ms. Date-only = 00:00 UTC. Unknown = ''."""
    m = re.match(r'^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{1,2}):(\d{2})\s*([A-Z]{2,4})?)?', published or '')
    if not m:
        return ''
    import calendar
    y, mo, d, hh, mm, tz = m.groups()
    base = calendar.timegm((int(y), int(mo), int(d), int(hh or 0), int(mm or 0), 0))
    return str((base - TZ.get(tz, 0) * 3600) * 1000)


def pick(o, key, lang):
    return o.get(key + 'En', o[key]) if lang == 'en' else o[key]


KIND = {'official': ('官方', 'Official'), 'media': ('媒体', 'Media'), 'unverified': ('待核实', 'Unverified'), 'community': ('社区', 'Community')}
L = lambda pair, lang: pair[1] if lang == 'en' else pair[0]


def src_links(src, lang):
    return '<ul class="srcs">' + ''.join('<li><a href="%s" target="_blank" rel="noopener noreferrer">%s ↗</a></li>' % (E(u), E(en if lang == 'en' else zh)) for zh, en, u in src) + '</ul>'


def render(data, lang):
    r = {}
    r['TLFILTER'] = ''.join('<button class="chip" type="button" data-k="%s" aria-pressed="%s">%s</button>' % (k, 'true' if k == 'all' else 'false', L(n, lang))
                            for k, n in [('all', ('全部', 'All')), ('official', KIND['official']), ('media', KIND['media']), ('unverified', KIND['unverified'])])
    r['TL'] = ''.join(
        '<li class="{k}" data-kind="{k}"><div class="tdate"><b>{d}</b><span class="b {k}">{kn}</span></div><div><h3>{t}</h3><p class="when">{w}</p>'
        '<details><summary>{more}</summary><div><p>{b}</p>{s}</div></details></div></li>'.format(
            k=t['kind'], d=E(t['d']), kn=L(KIND[t['kind']], lang), t=E(pick(t, 'title', lang)), w=E(pick(t, 'when', lang)),
            more=L(('详情与来源', 'Details and sources'), lang), b=E(pick(t, 'body', lang)), s=src_links(t['src'], lang)) for t in data['TL'])
    r['FUTURE'] = ''.join(
        '<div><span class="b {k}">{kn}</span><h3>{t}</h3><p class="when" style="margin:0 0 10px">{w}</p><p>{b}</p>{s}</div>'.format(
            k=t['kind'], kn=L(KIND[t['kind']], lang), t=E(pick(t, 'title', lang)), w=E(pick(t, 'when', lang)), b=E(pick(t, 'body', lang)), s=src_links(t['src'], lang)) for t in data['FUTURE'])
    cats = {c[0]: (c[1], c[2]) for c in data['CATS']}
    r['CATS'] = ''.join('<button class="chip" type="button" data-c="%s" aria-pressed="%s">%s</button>' % (c[0], 'true' if c[0] == 'all' else 'false', E(L((c[1], c[2]), lang))) for c in data['CATS'])
    items = [dict(i, _t=utc_ms(i['publishedAt']), _n=n) for n, i in enumerate(data['ITEMS'])]
    items.sort(key=lambda i: (i['_t'] == '', -(int(i['_t']) if i['_t'] else 0), i['_n']))  # newest first, undated last
    cards = []
    for idx, i in enumerate(items):
        opened = i['verificationStatus'] == 'opened'
        search = ' '.join([i['title'], i['summary'], i.get('summaryEn', ''), i['sourceName']]).lower()
        cards.append(
            '<article class="card{first}" data-id="{id}" data-type="{type}" data-t="{t}" data-n="{n}" data-featured="{feat}" data-search="{search}">'
            '<div class="cmeta"><span class="b {st}">{stn}</span><span>{date}</span><span>{cat} · {fmt}{featl}</span></div>'
            '<div><h3 lang="en">{title}</h3><p>{summary}</p><p class="note">{source} · {chk} {checked} · {ver}</p></div>'
            '<div class="foot"><a class="btn sm" href="{url}" target="_blank" rel="noopener noreferrer">{read} ↗</a>'
            '<button class="btn sm js-fav jsonly" type="button" aria-pressed="false">{save}</button></div></article>'.format(
                first=' first' if idx == 0 else '', id=E(i['id']), type=E(i['type']), t=i['_t'], n=i['_n'], feat='1' if i['featured'] else '', search=E(search),
                st=i['sourceType'], stn=L(KIND[i['sourceType']], lang), date=E(i['publishedAt']) if i['publishedAt'] else L(('页面未标注日期', 'no date on page'), lang),
                cat=E(L(cats[i['type']], lang)), fmt=E(L(data['FMT'][i['format']], lang)), featl=(' · ' + L(('精选', 'Featured'), lang)) if i['featured'] else '',
                title=E(i['title']), summary=E(pick(i, 'summary', lang)), source=E(pick(i, 'sourceName', lang)), chk=L(('核对', 'checked'), lang), checked=E(i['checkedAt']),
                ver=L(('已打开原文', 'source opened'), lang) if opened else L(('仅核对归档列表', 'archive listing only'), lang), url=E(i['sourceUrl']),
                read=(L(('阅读原文', 'Read source'), lang) if opened else L(('官方归档', 'Official archive'), lang)), save=L(('☆ 收藏', '☆ Save'), lang)))
    r['HUB'] = ''.join(cards)
    r['STEPS'] = ''.join('<li class="%s"%s><b>%s</b>%s%s</li>' % ({'done': 'done', 'cur': 'cur', 'todo': ''}[s['state']], ' aria-current="step"' if s['state'] == 'cur' else '',
                                                                E(s[lang][0]), E(s[lang][1]), L((' · 未开始', ' · not started'), lang) if s['state'] == 'todo' else '') for s in data['STG'])
    r['LETTER'] = E(data['LET'][lang])
    r['LETTERS_JSON'] = json.dumps(data['LET'], ensure_ascii=False).replace('</', '<\\/')
    return r


# ---------- head: meta, hreflang, Open Graph, JSON-LD ----------
def image_objects(alts):
    """One ImageObject per photo on the page. caption is the alt text a visitor gets for that photo in this language."""
    out = []
    for f, w, h, ctype, cname, lic, page, credit in IMAGES:
        o = {'@type': 'ImageObject', '@id': '%s/assets/%s#image' % (SITE, f), 'url': '%s/assets/%s' % (SITE, f), 'contentUrl': '%s/assets/%s' % (SITE, f),
             'width': w, 'height': h, 'encodingFormat': 'image/jpeg', 'caption': alts[f],
             'license': lic, 'acquireLicensePage': page, 'creditText': credit, 'copyrightNotice': credit, 'creator': {'@type': ctype, 'name': cname}}
        out.append(o)
    return out


PERSON_ID = SITE + '/#jensen-huang'


def head(lang, alts):
    p = PAGE[lang]
    url = SITE + p['path']
    # The same three nodes sit behind both pages, so every @id used below resolves inside each page's own graph.
    # WebSite: the site name stays "Save Jensen" in both languages. No publisher Organization is claimed.
    graph = [
        {'@type': 'WebSite', '@id': SITE + '/#website', 'url': SITE + '/', 'name': 'Save Jensen', 'alternateName': ['Save Jensen · 支持者社区', 'savejensen.ai'],
         'description': p['site_desc'], 'inLanguage': ['zh-Hans', 'en'], 'about': {'@id': PERSON_ID}},
        {'@type': ['AboutPage', 'CollectionPage'], '@id': url + '#webpage', 'url': url, 'name': p['title'], 'description': p['desc'], 'inLanguage': p['hreflang'],
         'isPartOf': {'@id': SITE + '/#website'}, 'about': {'@id': PERSON_ID}, 'mainEntity': {'@id': PERSON_ID}, 'dateModified': MODIFIED,
         'primaryImageOfPage': {'@id': '%s/assets/jensen-sc18.jpg#image' % SITE}, 'image': image_objects(alts)},
        # The person the site is about. Only a name and photos shown on the page: no job title (it changed on 2026-11-12).
        {'@type': 'Person', '@id': PERSON_ID, 'name': p['person'], 'alternateName': p['person_alt'],
         'image': {'@id': '%s/assets/jensen-sc18.jpg#image' % SITE}, 'subjectOf': {'@id': url + '#webpage'}},
    ]
    ld = json.dumps({'@context': 'https://schema.org', '@graph': graph}, ensure_ascii=False, indent=1).replace('</', '<\\/')
    redirect = ('(function(){var m=/[?&]lang=(zh|en)\\b/.exec(location.search);if(!m)return;var q=location.search.replace(/([?&])lang=(zh|en)(&|$)/,function(_,a,b,c){return c?a:""});'
                'if(m[1]!=="%s")location.replace("%s"+q+location.hash);else if(history.replaceState)history.replaceState(null,"",location.pathname+q+location.hash)})();' % (lang, p['alt_href']))
    og = SITE + '/assets/og-save-jensen.jpg'
    lines = [
        '<meta charset="utf-8">', '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<title>%s</title>' % E(p['title']), '<meta name="description" content="%s">' % E(p['desc']),
        '<meta name="robots" content="index, follow, max-image-preview:large">',
        '<link rel="canonical" href="%s">' % url,
        '<link rel="alternate" hreflang="zh-Hans" href="%s/zh/">' % SITE, '<link rel="alternate" hreflang="en" href="%s/">' % SITE, '<link rel="alternate" hreflang="x-default" href="%s/">' % SITE,
        '<meta property="og:type" content="website">', '<meta property="og:site_name" content="Save Jensen">', '<meta property="og:url" content="%s">' % url,
        '<meta property="og:title" content="%s">' % E(p['og_title']), '<meta property="og:description" content="%s">' % E(p['og_desc']),
        '<meta property="og:locale" content="%s">' % p['og_locale'], '<meta property="og:locale:alternate" content="%s">' % PAGE['en' if lang == 'zh' else 'zh']['og_locale'],
        '<meta property="og:image" content="%s">' % og, '<meta property="og:image:width" content="1200">', '<meta property="og:image:height" content="630">',
        '<meta property="og:image:type" content="image/jpeg">', '<meta property="og:image:alt" content="%s">' % E(p['og_alt']),
        '<meta name="twitter:card" content="summary_large_image">', '<meta name="twitter:title" content="%s">' % E(p['og_title']),
        '<meta name="twitter:description" content="%s">' % E(p['og_desc']), '<meta name="twitter:image" content="%s">' % og, '<meta name="twitter:image:alt" content="%s">' % E(p['og_alt']),
        '<meta name="theme-color" content="#0b0b0a">',
        '<link rel="icon" type="image/png" sizes="192x192" href="%sfavicon.png">' % p['root'], '<link rel="apple-touch-icon" href="%sfavicon.png">' % p['root'],
        '<link rel="preload" as="image" href="%sassets/jensen-sc18.jpg" fetchpriority="high">' % p['root'],
        '<link rel="stylesheet" href="%sassets/site.css">' % p['root'],
        '<script>%s</script>' % redirect,
        '<script type="application/ld+json">\n%s\n</script>' % ld,
    ]
    return '\n'.join(lines)


# ---------- small generated assets ----------
def write_png(path, size=192):
    """Favicon: near-black square with the green jacket mark (same shape as the old SVG icon)."""
    poly = [(9, 8), (16, 13), (23, 8), (26, 24), (6, 24)]
    def inside(x, y):
        c = False
        for i in range(len(poly)):
            (x1, y1), (x2, y2) = poly[i], poly[(i + 1) % len(poly)]
            if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
                c = not c
        return c
    raw = bytearray()
    for py in range(size):
        raw.append(0)
        for px in range(size):
            hits = sum(inside((px + dx) * 32 / size, (py + dy) * 32 / size) for dx in (.25, .75) for dy in (.25, .75)) / 4
            raw += bytes(int(a + (b - a) * hits) for a, b in zip((11, 11, 10), (182, 242, 46)))
    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    open(path, 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + chunk(b'IEND', b''))


NOT_FOUND = '''<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>404 · Save Jensen</title><link rel="icon" type="image/png" href="/favicon.png"><link rel="stylesheet" href="/assets/site.css"></head>
<body class="dark" style="min-height:100vh;display:grid;place-items:center;text-align:center"><main class="wrap"><p class="kicker" style="justify-content:center">404</p>
<h1 style="font-size:clamp(32px,6vw,64px);margin-bottom:18px">This page is not on the stage.<br><span lang="zh-CN">这一页不在舞台上。</span></h1>
<p><a class="btn pri" href="/">English home</a> <a class="btn" href="/zh/" lang="zh-CN">中文首页</a></p></main></body></html>
'''

ADMIN_CSS = '''.adm{background:var(--paper)}.adm main{padding-top:56px;padding-bottom:80px;max-width:860px}.adm h1{font-size:34px;margin-bottom:12px}
.adm label{margin-top:22px}.adm #tok{flex:1 1 260px;width:auto;min-height:44px}.adm #list{list-style:none;padding:0;margin:22px 0}
.adm #list li{border-top:1px solid var(--line);padding:18px 0}.adm #list p{white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0 12px;font-size:16px}
.adm .err{color:#a11d1d}.adm .chips{margin-top:14px}.adm .avadm{float:right;margin:0 0 8px 16px;border-radius:10px;border:1px solid var(--line);background:#eee}
'''


def main():
    data = json.load(open(os.path.join(SRC, 'data.json'), encoding='utf-8'))
    tpl = open(os.path.join(SRC, 'template.html'), encoding='utf-8').read()
    if os.path.isdir(PUB):
        shutil.rmtree(PUB)
    os.makedirs(os.path.join(PUB, 'assets'))
    os.makedirs(os.path.join(PUB, 'zh'))
    os.makedirs(os.path.join(PUB, 'admin'))

    for lang, p in PAGE.items():
        page = localize(tpl, lang)
        slots = render(data, lang)
        alts = {f: html.unescape(a) for f, a in re.findall(r'<img src="[^"]*assets/([\w.-]+)"[^>]*? alt="([^"]*)"', page)}
        slots.update(HEAD=head(lang, alts), HTML_LANG=p['html_lang'], ROOT=p['root'], ALT_HREF=p['alt_href'], ALT_LANG=p['alt_lang'], ALT_TEXT=p['alt_text'], ALT_LABEL=p['alt_label'], SELF_HREF=p['self_href'])
        for k, v in slots.items():
            page = page.replace('{{%s}}' % k, v)
        page = page.replace('<span class="js-checked"></span>', '<span class="js-checked">%s</span>' % CHECKED[lang])
        page = page.replace('<span id="stageName"></span>', '<span id="stageName">%s</span>' % L(('主办方公开信已发送 · 等待收件确认', 'Organizer letter sent · Awaiting acknowledgment'), lang))
        page = page.replace('<span id="orgContact"></span>', '<span id="orgContact">%s</span>' % L(('待配置（尚未公布）', 'to be configured (not published yet)'), lang))
        page = page.replace('<strong id="dcName" style="color:#fff"></strong>', '<strong id="dcName" style="color:#fff">Save Jensen | Builders &amp; Fans</strong>')
        left = re.findall(r'\{\{[A-Z_]+\}\}', page)
        assert not left, left
        assert 'data-en' not in page
        open(os.path.join(PUB, 'zh' if lang == 'zh' else '', 'index.html'), 'w', encoding='utf-8').write(page)

    # whitelist: only these files are published
    for f in ('site.css', 'app.js', 'admin.js'):
        shutil.copy(os.path.join(SRC, f), os.path.join(PUB, 'assets', f))
    open(os.path.join(PUB, 'assets', 'admin.css'), 'w', encoding='utf-8').write(ADMIN_CSS)
    shutil.copy(os.path.join(SRC, 'admin.html'), os.path.join(PUB, 'admin', 'index.html'))
    for f, *_ in IMAGES:
        shutil.copy(os.path.join(PHOTOS, f), os.path.join(PUB, 'assets', f))
    og = os.path.join(PHOTOS, 'og-save-jensen.jpg')
    if not os.path.exists(og):
        raise FileNotFoundError('Required checked-in image: src/photos/og-save-jensen.jpg')
    shutil.copy(og, os.path.join(PUB, 'assets', 'og-save-jensen.jpg'))
    write_png(os.path.join(PUB, 'favicon.png'))
    open(os.path.join(PUB, '404.html'), 'w', encoding='utf-8').write(NOT_FOUND)
    open(os.path.join(PUB, 'robots.txt'), 'w').write('User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: %s/sitemap.xml\n' % SITE)
    alt = ''.join('    <xhtml:link rel="alternate" hreflang="%s" href="%s%s"/>\n' % (h, SITE, u) for h, u in (('zh-Hans', '/zh/'), ('en', '/'), ('x-default', '/')))
    open(os.path.join(PUB, 'sitemap.xml'), 'w').write(
        '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' +
        ''.join('  <url>\n    <loc>%s%s</loc>\n    <lastmod>%s</lastmod>\n%s  </url>\n' % (SITE, u, MODIFIED, alt) for u in ('/', '/zh/')) + '</urlset>\n')

    files = sorted(os.path.relpath(os.path.join(d, f), PUB) for d, _, fs in os.walk(PUB) for f in fs)
    print('built %d files -> %s' % (len(files), os.path.relpath(PUB, HERE)))
    print('\n'.join('  ' + f for f in files))


if __name__ == '__main__':
    main()
