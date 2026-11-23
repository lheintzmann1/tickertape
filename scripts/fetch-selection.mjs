#!/usr/bin/env node
// Builds data/selection.json from the repo's issues labelled "saved" that the repo
// owner opened. Anyone can open an issue on a public repo, so other authors are ignored.
// GitHub returns body_html already sanitized, which is what the site renders.
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const repo = process.env.GITHUB_REPOSITORY;
const owner = process.env.GITHUB_REPOSITORY_OWNER || repo?.split('/')[0];
const token = process.env.GITHUB_TOKEN;
const out = path.join(DATA, 'selection.json');
await mkdir(DATA, { recursive: true });

if (!repo || !token) {
  console.log('GITHUB_REPOSITORY / GITHUB_TOKEN not set: no saved items.');
  await writeFile(out, '[]');
  process.exit(0);
}

const items = [];
for (let page = 1; page < 20; page++) {
  const url = `https://api.github.com/repos/${repo}/issues?labels=saved&state=all&creator=${encodeURIComponent(owner)}&per_page=100&page=${page}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.full+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!res.ok) {
    console.error(`Issues: HTTP ${res.status}`);
    break;
  }
  const batch = await res.json();
  for (const is of batch) {
    if (is.pull_request) continue;
    let meta = {};
    const m = /<!--\s*tickertape:(\{[\s\S]*?\})\s*-->/.exec(is.body || '');
    if (m) {
      try { meta = JSON.parse(m[1]); } catch {}
    }
    items.push({
      number: is.number,
      title: is.title,
      issueUrl: is.html_url,
      state: is.state,
      createdAt: is.created_at,
      updatedAt: is.updated_at,
      labels: is.labels.map((l) => l.name).filter((n) => n !== 'saved'),
      bodyHtml: is.body_html || '',
      link: meta.link || '',
      view: meta.view || '',
      source: meta.source || '',
      published: meta.published || null,
    });
  }
  if (batch.length < 100) break;
}
await writeFile(out, JSON.stringify(items));
console.log(`Saved items: ${items.length}.`);
