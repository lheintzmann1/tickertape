// Shared OPML model: parse + serialize. Runs in Node (fetcher, build) and in the browser (editor).
//
// Tree model:
//   doc  = { title, head: {..other head fields}, wrapped, children: Node[] }
//   Node = { type: 'folder', text, attrs, children: Node[] }
//        | { type: 'feed', text, xmlUrl, htmlUrl, attrs }
// `wrapped` is true when the whole body sat inside one outline that repeats the
// document title (a common export style). It is unwrapped for editing and
// restored on save, so files keep their original shape.
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => name === 'outline',
});

const KNOWN_ATTRS = new Set(['text', 'title', 'type', 'xmlUrl', 'htmlUrl']);

function attrsOf(el) {
  const out = {};
  for (const [k, v] of Object.entries(el || {})) {
    if (k.startsWith('@_')) out[k.slice(2)] = String(v);
  }
  return out;
}

function toNode(el) {
  const a = attrsOf(el);
  const extra = {};
  for (const [k, v] of Object.entries(a)) if (!KNOWN_ATTRS.has(k)) extra[k] = v;
  const text = (a.text ?? a.title ?? '').trim();
  if (a.xmlUrl) {
    return { type: 'feed', text: text || a.xmlUrl, xmlUrl: a.xmlUrl.trim(), htmlUrl: (a.htmlUrl || '').trim(), attrs: extra };
  }
  return { type: 'folder', text: text || 'Untitled', attrs: extra, children: (el.outline || []).map(toNode) };
}

export function parseOpml(xml) {
  const root = parser.parse(xml);
  const opml = root?.opml;
  if (!opml) throw new Error('Not an OPML file (no <opml> element found).');
  const headRaw = opml.head || {};
  const head = {};
  for (const [k, v] of Object.entries(headRaw)) {
    if (!k.startsWith('@_') && typeof v !== 'object') head[k] = String(v);
  }
  const title = head.title || '';
  delete head.title;
  let children = (opml.body?.outline || []).map(toNode);
  let wrapped = false;
  if (children.length === 1 && children[0].type === 'folder' && title && children[0].text === title) {
    children = children[0].children;
    wrapped = true;
  }
  return { title, head, wrapped, children };
}

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function attrString(pairs) {
  return pairs
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join('');
}

function serializeNode(n, depth) {
  const pad = '  '.repeat(depth);
  const extra = Object.entries(n.attrs || {});
  if (n.type === 'feed') {
    return `${pad}<outline${attrString([['type', 'rss'], ['text', n.text], ['title', n.text], ['xmlUrl', n.xmlUrl], ['htmlUrl', n.htmlUrl], ...extra])}/>`;
  }
  const open = `${pad}<outline${attrString([['text', n.text], ['title', n.text], ...extra])}`;
  if (!n.children?.length) return `${open}/>`;
  return [`${open}>`, ...n.children.map((c) => serializeNode(c, depth + 1)), `${pad}</outline>`].join('\n');
}

export function serializeOpml(doc, { now = new Date() } = {}) {
  const head = { ...doc.head, dateModified: now.toUTCString() };
  const headLines = [`    <title>${esc(doc.title)}</title>`];
  for (const [k, v] of Object.entries(head)) {
    if (/^[A-Za-z][\w.-]*$/.test(k)) headLines.push(`    <${k}>${esc(v)}</${k}>`);
  }
  const depth = doc.wrapped ? 3 : 2;
  let body = doc.children.map((c) => serializeNode(c, depth)).join('\n');
  if (doc.wrapped) {
    const t = attrString([['text', doc.title], ['title', doc.title]]);
    body = doc.children.length ? `    <outline${t}>\n${body}\n    </outline>` : `    <outline${t}/>`;
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head>',
    ...headLines,
    '  </head>',
    '  <body>',
    body,
    '  </body>',
    '</opml>',
    '',
  ].join('\n');
}

/** Every feed in document order, with its category path. */
export function flattenFeeds(doc) {
  const out = [];
  const walk = (nodes, path) => {
    for (const n of nodes) {
      if (n.type === 'feed') out.push({ ...n, path });
      else walk(n.children, [...path, n.text]);
    }
  };
  walk(doc.children, []);
  return out;
}

/** Stable short id for a feed URL (FNV-1a 64-bit, hex). Same result in Node and browsers. */
export function feedId(url) {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const bytes = new TextEncoder().encode(String(url).trim());
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

export function slugFromFilename(name) {
  return name.replace(/\.opml$/i, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}
