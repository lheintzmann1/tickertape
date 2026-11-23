#!/usr/bin/env node
// Fetches every feed listed in opml/*.opml (each unique URL once), merges new items
// into data/items/<feedId>.json, prunes old ones and records feed health in data/state.json.
//
//   node scripts/fetch-feeds.mjs [--data ./data] [--only <substring>]
import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseOpml, flattenFeeds, feedId } from '../src/lib/opml.js';
import { parseFeed, decodeBody } from './lib/feed.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);
const argVal = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const DATA = path.resolve(argVal('--data') || process.env.DATA_DIR || path.join(ROOT, 'data'));
const ONLY = argVal('--only');
const config = JSON.parse(await readFile(path.join(ROOT, 'tickertape.config.json'), 'utf8'));
const UA = (config.userAgent || 'Tickertape/1.0').replace('{repo}', process.env.GITHUB_REPOSITORY || 'local');
const DAY = 86_400_000;
const now = Date.now();

const readJson = async (p, fallback) => {
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch {
    return fallback;
  }
};

// 1. Collect unique feeds across all OPML files -----------------------------------------
const opmlDir = path.join(ROOT, 'opml');
const files = (await readdir(opmlDir)).filter((f) => f.toLowerCase().endsWith('.opml')).sort();
const feeds = new Map(); // id -> { id, url, names:Set }
for (const file of files) {
  let doc;
  try {
    doc = parseOpml(await readFile(path.join(opmlDir, file), 'utf8'));
  } catch (e) {
    console.error(`✗ ${file}: ${e.message}`);
    continue;
  }
  for (const f of flattenFeeds(doc)) {
    const id = feedId(f.xmlUrl);
    if (!feeds.has(id)) feeds.set(id, { id, url: f.xmlUrl, name: f.text });
  }
}
let list = [...feeds.values()];
if (ONLY) list = list.filter((f) => f.url.includes(ONLY) || f.name.includes(ONLY));
console.log(`${files.length} OPML files, ${feeds.size} unique feeds${ONLY ? `, ${list.length} selected` : ''}`);

await mkdir(path.join(DATA, 'items'), { recursive: true });
const state = await readJson(path.join(DATA, 'state.json'), { feeds: {} });
state.feeds ||= {};

// 2. Fetch, grouped by host: one host at a time per worker, with a polite gap between requests.
const byHost = new Map();
for (const f of list) {
  let host = 'invalid';
  try { host = new URL(f.url).host; } catch {}
  if (!byHost.has(host)) byHost.set(host, []);
  byHost.get(host).push(f);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(feed, prev) {
  const headers = {
    'User-Agent': UA,
    Accept: 'application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8',
    'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
  };
  if (prev?.etag) headers['If-None-Match'] = prev.etag;
  if (prev?.lastModified) headers['If-Modified-Since'] = prev.lastModified;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(feed.url, { headers, redirect: 'follow', signal: AbortSignal.timeout(config.timeoutMs || 20000) });
      if (res.status >= 500 && attempt === 0) {
        await sleep(2000);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt === 0) await sleep(2000);
    }
  }
  throw lastErr;
}

async function processFeed(feed) {
  const prev = state.feeds[feed.id] || {};
  const rec = { ...prev, url: feed.url, name: feed.name, lastAttempt: new Date(now).toISOString() };
  const itemsPath = path.join(DATA, 'items', `${feed.id}.json`);
  const existing = await readJson(itemsPath, []);
  try {
    const res = await request(feed, prev);
    rec.lastStatus = res.status;
    if (res.status === 304) {
      Object.assign(rec, { lastSuccess: rec.lastAttempt, error: null, consecutiveFailures: 0 });
      state.feeds[feed.id] = rec;
      return { feed, status: 304, added: 0 };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 403 || res.status === 429 ? ' (access denied: the site may block bots or GitHub’s servers)' : ''}`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength > 15 * 1024 * 1024) throw new Error('Feed too large (> 15 MB)');
    const body = decodeBody(buf, res.headers.get('content-type') || '');
    const parsed = parseFeed(body, { url: res.url || feed.url, summaryLength: config.summaryLength || 320 });

    const byId = new Map(existing.map((it) => [it.id, it]));
    let added = 0;
    for (const it of parsed.items) {
      const id = feedId(feed.id + '|' + it.rawId);
      const old = byId.get(id);
      let date = it.date;
      if (date && date > now + DAY) date = null; // ignore far-future dates
      if (old) {
        Object.assign(old, { title: it.title, link: it.link || old.link, summary: it.summary, author: it.author });
        if (date) old.date = date;
      } else {
        byId.set(id, { id, title: it.title, link: it.link, date: date || now, summary: it.summary, author: it.author, firstSeen: now, ...(date ? {} : { dateGuessed: true }) });
        added++;
      }
    }
    const items = prune([...byId.values()]);
    const kept = new Set(items.map((i) => i.id));
    added = [...byId.keys()].filter((id) => kept.has(id) && !existing.some((e) => e.id === id)).length;
    await writeFile(itemsPath, JSON.stringify(items));
    Object.assign(rec, {
      etag: res.headers.get('etag') || null,
      lastModified: res.headers.get('last-modified') || null,
      lastSuccess: rec.lastAttempt,
      error: null,
      consecutiveFailures: 0,
      feedTitle: parsed.title || rec.feedTitle || '',
      siteUrl: parsed.siteUrl || rec.siteUrl || '',
      itemCount: items.length,
      lastItemsInFeed: parsed.items.length,
    });
    state.feeds[feed.id] = rec;
    return { feed, status: res.status, added };
  } catch (e) {
    const msg = e.name === 'TimeoutError' ? `Timed out after ${(config.timeoutMs || 20000) / 1000} s` : e.cause?.code ? `${e.message} (${e.cause.code})` : e.message;
    Object.assign(rec, { error: msg, consecutiveFailures: (prev.consecutiveFailures || 0) + 1, itemCount: existing.length });
    // A feed that keeps failing still gets its old items pruned.
    if (existing.length) await writeFile(itemsPath, JSON.stringify(prune(existing)));
    state.feeds[feed.id] = rec;
    return { feed, error: msg };
  }
}

function prune(items) {
  const cutoff = now - (config.retentionDays || 60) * DAY;
  items.sort((a, b) => b.date - a.date);
  const keep = config.keepLatestPerFeed ?? 10;
  return items.filter((it, i) => i < keep || it.date >= cutoff).slice(0, config.maxItemsPerFeed || 300);
}

const hosts = [...byHost.entries()].sort((a, b) => b[1].length - a[1].length); // longest queues first
const results = [];
let next = 0;
async function worker() {
  while (next < hosts.length) {
    const [host, group] = hosts[next++];
    const gap = config.hostIntervalsMs?.[host] ?? 300;
    for (let i = 0; i < group.length; i++) {
      if (i) await sleep(gap);
      const r = await processFeed(group[i]);
      results.push(r);
      const tag = r.error ? '✗' : r.status === 304 ? '=' : '✓';
      console.log(`${tag} ${r.feed.name.slice(0, 60).padEnd(60)} ${r.error ?? (r.status === 304 ? 'unchanged' : `+${r.added}`)}`);
    }
  }
}
const t0 = Date.now();
await Promise.all(Array.from({ length: Math.min(config.concurrency || 10, hosts.length) }, worker));

// 3. Forget feeds that are no longer in any OPML file (only on a full run).
if (!ONLY) {
  for (const id of Object.keys(state.feeds)) {
    if (!feeds.has(id)) {
      delete state.feeds[id];
      const p = path.join(DATA, 'items', `${id}.json`);
      if (existsSync(p)) await rm(p);
    }
  }
}

state.updatedAt = new Date(now).toISOString();
state.lastRun = { durationMs: Date.now() - t0, ok: results.filter((r) => !r.error).length, failed: results.filter((r) => r.error).length, added: results.reduce((s, r) => s + (r.added || 0), 0) };
await writeFile(path.join(DATA, 'state.json'), JSON.stringify(state, null, 1));
console.log(`\nDone in ${(state.lastRun.durationMs / 1000).toFixed(1)} s: ${state.lastRun.ok} OK, ${state.lastRun.failed} failing, ${state.lastRun.added} new items.`);
