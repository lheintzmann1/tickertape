// Normalizes RSS 2.0, RSS 1.0 (RDF), Atom and JSON Feed into one item shape.
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
  isArray: (name) => ['item', 'entry', 'link', 'category', 'author'].includes(name),
});

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', eacute: 'é', egrave: 'è', ecirc: 'ê', agrave: 'à', acirc: 'â', ccedil: 'ç', ocirc: 'ô', ucirc: 'û', ugrave: 'ù', icirc: 'î', iuml: 'ï', euml: 'ë', oelig: 'œ', Eacute: 'É', euro: '€', copy: '©', reg: '®', trade: '™', bull: '•', middot: '·', deg: '°' };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      try { return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : m; } catch { return m; }
    }
    return NAMED[code] ?? NAMED[code.toLowerCase()] ?? m;
  });
}

/** HTML → plain text. Everything we store is plain text, so nothing from a feed is ever rendered as HTML. */
export function toPlainText(html) {
  if (!html) return '';
  let s = String(html)
    .replace(/<(script|style|iframe|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr|blockquote)>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
  s = decodeEntities(s);
  // Entities may have been double-escaped (&amp;lt;p&amp;gt;): one more pass on leftover tags.
  if (/<[a-z/][^>]*>/i.test(s)) s = decodeEntities(s.replace(/<[^>]*>/g, ' '));
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\s+/g, ' ').trim();
}

export function truncate(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.–—-]+$/, '') + '…';
}

const txt = (v) => {
  if (v == null) return '';
  if (Array.isArray(v)) return txt(v[0]);
  if (typeof v === 'object') return String(v['#text'] ?? '');
  return String(v);
};

function parseDate(...candidates) {
  for (const c of candidates) {
    const s = txt(c).trim();
    if (!s) continue;
    let t = Date.parse(s);
    // "Mon, 23 Nov 2026 10:15:20 +0100" parses; some feeds use "2026-11-23 10:15:20" (no T)
    if (Number.isNaN(t)) t = Date.parse(s.replace(' ', 'T'));
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

function safeUrl(u, base) {
  if (!u) return '';
  try {
    const url = new URL(String(u).trim(), base || undefined);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function atomLink(links, base) {
  if (!links) return '';
  const arr = Array.isArray(links) ? links : [links];
  const pick =
    arr.find((l) => typeof l === 'object' && (!l['@_rel'] || l['@_rel'] === 'alternate') && (!l['@_type'] || /html/.test(l['@_type']))) ||
    arr.find((l) => typeof l === 'object' && (!l['@_rel'] || l['@_rel'] === 'alternate')) ||
    arr[0];
  return safeUrl(typeof pick === 'object' ? pick['@_href'] ?? pick['#text'] : pick, base);
}

function authorOf(...cands) {
  for (const c of cands) {
    if (!c) continue;
    const a = Array.isArray(c) ? c[0] : c;
    const name = typeof a === 'object' ? txt(a.name ?? a) : txt(a);
    if (name.trim()) return toPlainText(name).slice(0, 120);
  }
  return '';
}

function finish(raw, { base, summaryLength }) {
  const title = toPlainText(raw.title) || '(untitled)';
  let summary = toPlainText(raw.summary);
  // Google News & co. repeat the title as the description.
  if (summary && (summary === title || (summary.startsWith(title) && summary.length - title.length < 60))) summary = '';
  const link = safeUrl(raw.link, base);
  return {
    rawId: String(raw.id || link || title).trim(),
    title: truncate(title, 300),
    link,
    date: raw.date,
    summary: truncate(summary, summaryLength),
    author: raw.author || '',
  };
}

/**
 * @returns {{ title: string, siteUrl: string, items: Array }}
 */
export function parseFeed(body, { url, summaryLength = 320 } = {}) {
  const trimmed = body.trimStart();
  if (trimmed.startsWith('{')) return parseJsonFeed(JSON.parse(trimmed), { url, summaryLength });

  const doc = parser.parse(body);

  if (doc.rss?.channel || doc.channel) {
    const ch = doc.rss?.channel ?? doc.channel;
    const channel = Array.isArray(ch) ? ch[0] : ch;
    const siteUrl = safeUrl(txt(channel.link?.find?.((l) => typeof l === 'string' || !l['@_rel']) ?? channel.link), url);
    const items = (channel.item || []).map((it) =>
      finish(
        {
          id: txt(it.guid),
          title: txt(it.title),
          link: txt(it.link?.find?.((l) => typeof l === 'string' || l['#text']) ?? it.link) || (it.guid?.['@_isPermaLink'] !== 'false' ? txt(it.guid) : ''),
          date: parseDate(it.pubDate, it['dc:date'], it.published, it.updated, it['a10:updated']),
          summary: txt(it.description) || txt(it['content:encoded']),
          author: authorOf(it['dc:creator'], it.author),
        },
        { base: siteUrl || url, summaryLength },
      ),
    );
    return { title: toPlainText(txt(channel.title)), siteUrl, items };
  }

  const rdf = doc['rdf:RDF'] ?? doc.RDF;
  if (rdf) {
    const ch = Array.isArray(rdf.channel) ? rdf.channel[0] : rdf.channel || {};
    const siteUrl = safeUrl(txt(ch.link), url);
    const items = (rdf.item || []).map((it) =>
      finish(
        {
          id: it['@_rdf:about'] || txt(it.link),
          title: txt(it.title),
          link: txt(it.link),
          date: parseDate(it['dc:date'], it.pubDate),
          summary: txt(it.description),
          author: authorOf(it['dc:creator']),
        },
        { base: siteUrl || url, summaryLength },
      ),
    );
    return { title: toPlainText(txt(ch.title)), siteUrl, items };
  }

  if (doc.feed) {
    const f = doc.feed;
    const siteUrl = atomLink(f.link, url);
    const items = (f.entry || []).map((e) =>
      finish(
        {
          id: txt(e.id),
          title: txt(e.title),
          link: atomLink(e.link, siteUrl || url),
          date: parseDate(e.published, e.updated, e.issued, e.modified),
          summary: txt(e.summary) || txt(e.content) || txt(e['media:group']?.['media:description']),
          author: authorOf(e.author, f.author),
        },
        { base: siteUrl || url, summaryLength },
      ),
    );
    return { title: toPlainText(txt(f.title)), siteUrl, items };
  }

  throw new Error('Unrecognized feed format (not RSS, Atom or JSON Feed)');
}

function parseJsonFeed(j, { url, summaryLength }) {
  const siteUrl = safeUrl(j.home_page_url, url);
  const items = (j.items || []).map((it) =>
    finish(
      {
        id: it.id,
        title: it.title || it.content_text?.slice(0, 120),
        link: it.url || it.external_url,
        date: parseDate(it.date_published, it.date_modified),
        summary: it.summary || it.content_text || it.content_html,
        author: authorOf(it.authors?.[0]?.name, it.author?.name),
      },
      { base: siteUrl || url, summaryLength },
    ),
  );
  return { title: toPlainText(j.title), siteUrl, items };
}

/** Decode a response body using the charset from headers or the XML declaration. */
export function decodeBody(buf, contentType = '') {
  const bytes = new Uint8Array(buf);
  let charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (!charset) {
    const head = new TextDecoder('ascii').decode(bytes.slice(0, 200));
    charset = /encoding=["']([\w-]+)["']/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}
