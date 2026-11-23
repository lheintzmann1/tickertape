// Build-time loader (Node only): reads opml/, tickertape.config.json and the data directory.
import fs from 'node:fs';
import path from 'node:path';
import { parseOpml, flattenFeeds, feedId, slugFromFilename } from './opml.js';

const ROOT = process.cwd();
const DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));

const readJson = (p, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
};

let cache;
export function loadSite() {
  if (cache) return cache;
  const config = readJson(path.join(ROOT, 'tickertape.config.json'), {});
  const state = readJson(path.join(DATA, 'state.json'), { feeds: {} });
  const selection = readJson(path.join(DATA, 'selection.json'), []);
  const repo = process.env.GITHUB_REPOSITORY || config.repo || '';
  const configured = Object.keys(config.views || {});

  const files = fs
    .readdirSync(path.join(ROOT, 'opml'))
    .filter((f) => f.toLowerCase().endsWith('.opml'))
    .sort((a, b) => {
      const ia = configured.indexOf(slugFromFilename(a));
      const ib = configured.indexOf(slugFromFilename(b));
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.localeCompare(b);
    });

  const views = [];
  files.forEach((file) => {
    const slug = slugFromFilename(file);
    const raw = fs.readFileSync(path.join(ROOT, 'opml', file), 'utf8');
    let doc;
    try {
      doc = parseOpml(raw);
    } catch (e) {
      console.warn(`[tickertape] skipping ${file}: ${e.message}`);
      return;
    }
    const vc = config.views?.[slug] || {};
    const feeds = flattenFeeds(doc).map((f) => ({ ...f, id: feedId(f.xmlUrl) }));
    views.push({
      slug,
      file,
      raw,
      title: doc.title || slug,
      label: vc.label || doc.title || slug,
      doc,
      feeds,
    });
  });

  const itemCache = new Map();
  const itemsOf = (id) => {
    if (!itemCache.has(id)) itemCache.set(id, readJson(path.join(DATA, 'items', `${id}.json`), []));
    return itemCache.get(id);
  };

  cache = { config, state, selection, repo, views, itemsOf, siteTitle: config.siteTitle || 'Tickertape' };
  return cache;
}

/** Items of one view, newest first, deduplicated (a feed may sit in two categories). */
export function viewItems(view) {
  const { itemsOf } = loadSite();
  const seen = new Set();
  const out = [];
  for (const f of view.feeds) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    for (const it of itemsOf(f.id)) out.push({ ...it, feed: f.id });
  }
  return out.sort((a, b) => b.date - a.date);
}

/** Compact tree for the client: folders {n, c:[...]}, feeds {n, id}. */
export function compactTree(nodes) {
  return nodes.map((n) => (n.type === 'feed' ? { n: n.text, id: feedId(n.xmlUrl) } : { n: n.text, c: compactTree(n.children) }));
}

export function viewPayload(view) {
  const { state, repo } = loadSite();
  const feeds = {};
  for (const f of view.feeds) {
    const s = state.feeds?.[f.id] || {};
    feeds[f.id] = { n: f.text, site: f.htmlUrl || s.siteUrl || '', err: s.error || null, ok: s.lastSuccess || null };
  }
  return {
    slug: view.slug,
    label: view.label,
    title: view.title,
    repo,
    updatedAt: state.updatedAt || null,
    tree: compactTree(view.doc.children),
    feeds,
    items: viewItems(view).map((it) => ({ i: it.id, f: it.feed, t: it.title, l: it.link, d: it.date, s: it.summary, a: it.author || undefined, g: it.dateGuessed ? 1 : undefined })),
  };
}
