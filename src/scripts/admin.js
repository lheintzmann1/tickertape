// OPML editor.
// - Offline: edits are downloaded as files.
// - Connected (GitHub sign-in through the auth helper, or a personal access token):
//   one commit per save through the Git Data API (blobs → tree → commit → ref),
//   so several files change atomically.
import { parseOpml, serializeOpml, flattenFeeds, slugFromFilename } from '../lib/opml.js';

const API = 'https://api.github.com';
const EPOCH = new Date(0);
const TOKEN_KEY = 'tickertape:gh-token';
const CONN_KEY = 'tickertape:gh-conn';
const REMEMBER_KEY = 'tickertape:gh-remember';
let uidSeq = 0;

const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c);
  return e;
};
const put = (box, ...kids) => box.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
const action = (label, fn, attrs = {}) => el('button', { type: 'button', onclick: fn, ...attrs }, label);
const linkAction = (label, fn) => el('a', { href: '#', onclick: (e) => (e.preventDefault(), fn()) }, label);
const hostOf = (u) => {
  try {
    return new URL(u).host.replace(/^www\./, '');
  } catch {
    return '';
  }
};
const isHttp = (u) => {
  try {
    return /^https?:$/.test(new URL(u).protocol);
  } catch {
    return false;
  }
};
const b64 = (str) => {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const tagUids = (nodes) => {
  for (const n of nodes) {
    n._uid ??= ++uidSeq;
    if (n.children) tagUids(n.children);
  }
};
const snapshot = (doc) => serializeOpml(doc, { now: EPOCH });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Feed URL builders for common sources.
const TEMPLATES = {
  'gnews-en': { label: 'Keywords', ph: '"mainframe modernization"', build: (q) => gnews(q, 'en') },
  'gnews-fr': { label: 'Keywords (French)', ph: 'mainframe banque', build: (q) => gnews(q, 'fr') },
  hn: { label: 'Keywords', ph: 'COBOL', build: (q) => ({ xmlUrl: `https://hnrss.org/newest?q=${encodeURIComponent(q.trim()).replace(/%20/g, '+')}`, htmlUrl: `https://hn.algolia.com/?q=${encodeURIComponent(q.trim())}`, text: `[Hacker News] "${q.trim()}"` }) },
  reddit: { label: 'Subreddit name', ph: 'mainframe', build: (q) => { const s = q.replace(/^\/?r\//, '').trim(); return { xmlUrl: `https://www.reddit.com/r/${s}/.rss`, htmlUrl: `https://www.reddit.com/r/${s}/`, text: `[Reddit] r/${s}` }; } },
  'gh-releases': { label: 'Repository (owner/name)', ph: 'openmainframeproject/cobol-check', build: (q) => { const r = q.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, ''); return { xmlUrl: `https://github.com/${r}/releases.atom`, htmlUrl: `https://github.com/${r}/releases`, text: `[GitHub releases] ${r}` }; } },
  arxiv: { label: 'Keywords', ph: 'COBOL translation', build: (q) => { const t = q.trim().split(/\s+/).map((w) => `all:${encodeURIComponent(w)}`).join('+AND+'); return { xmlUrl: `https://export.arxiv.org/api/query?search_query=${t}&sortBy=submittedDate&sortOrder=descending&max_results=30`, htmlUrl: `https://arxiv.org/search/?query=${encodeURIComponent(q.trim())}&searchtype=all`, text: `[arXiv] ${q.trim()}` }; } },
  devto: { label: 'Tag', ph: 'cobol', build: (q) => { const t = q.replace(/^#/, '').trim().toLowerCase(); return { xmlUrl: `https://dev.to/feed/tag/${t}`, htmlUrl: `https://dev.to/t/${t}`, text: `[DEV] #${t}` }; } },
  so: { label: 'Tag', ph: 'cobol', build: (q) => { const t = q.toLowerCase().trim(); return { xmlUrl: `https://stackoverflow.com/feeds/tag?tagnames=${encodeURIComponent(t)}&sort=newest`, htmlUrl: `https://stackoverflow.com/questions/tagged/${encodeURIComponent(t)}`, text: `[Stack Overflow] [${t}]` }; } },
};
function gnews(q, lang) {
  const loc = lang === 'fr' ? 'hl=fr&gl=FR&ceid=FR:fr' : 'hl=en-US&gl=US&ceid=US:en';
  const query = encodeURIComponent(`${q.trim()} when:7d`).replace(/%20/g, '+');
  return { xmlUrl: `https://news.google.com/rss/search?q=${query}&${loc}`, htmlUrl: `https://news.google.com/search?q=${query}&${loc}`, text: `[Google News ${lang.toUpperCase()}] ${q.trim()}` };
}

export function startAdmin(boot) {
  const $ = (id) => document.getElementById(id);
  const S = {
    base: boot.base,
    repo: boot.repo,
    branch: boot.branch || 'main',
    token: null,
    login: null,
    via: null, // 'github' | 'pat'
    files: [], // { name, doc, baseline, isNew, deleted, undo: [] }
    current: null,
    selected: null,
    collapsed: new Set(),
    filter: '',
    config: structuredClone(boot.config || {}),
    configBaseline: JSON.stringify(boot.config || {}, null, 2),
  };
  const cur = () => S.files.find((f) => f.name === S.current);
  const slugOf = (f) => slugFromFilename(f.name);
  const viewCfg = (f) => S.config.views?.[slugOf(f)] || {};
  const configText = () => JSON.stringify(S.config, null, 2) + '\n';
  const configDirty = () => JSON.stringify(S.config, null, 2) !== S.configBaseline;
  const isDirty = (f) => f.deleted || f.isNew || snapshot(f.doc) !== f.baseline;
  const dirtyFiles = () => S.files.filter(isDirty);
  const anyDirty = () => dirtyFiles().length > 0 || configDirty();
  const labelOf = (f) => viewCfg(f).label || f.doc.title || f.name;

  // ---------- connection ----------
  const connForm = $('conn-form');
  const savedConn = JSON.parse(localStorage.getItem(CONN_KEY) || 'null');
  connForm.repo.value = savedConn?.repo || S.repo || '';
  connForm.branch.value = savedConn?.branch || S.branch;

  if (boot.authUrl) {
    $('gh-login').hidden = false;
    $('gh-remember').checked = localStorage.getItem(REMEMBER_KEY) === '1';
    $('gh-connect').addEventListener('click', () => {
      if (anyDirty() && !confirm('Signing in reloads the page. Unsaved changes will be lost. Continue?')) return;
      localStorage.setItem(REMEMBER_KEY, $('gh-remember').checked ? '1' : '0');
      const back = location.origin + location.pathname;
      location.href = `${boot.authUrl}/login?return=${encodeURIComponent(back)}`;
    });
  } else {
    $('pat-summary').textContent = 'Connect with a personal access token';
  }

  function storeToken(token, remember, meta) {
    (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, JSON.stringify({ token, ...meta }));
    (remember ? sessionStorage : localStorage).removeItem(TOKEN_KEY);
  }
  function readToken() {
    const raw = sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return { token: raw, via: 'pat' };
    }
  }
  function forgetToken() {
    sessionStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_KEY);
  }

  // Coming back from the auth helper: #gh_token=… or #auth_error=…
  const hash = new URLSearchParams(location.hash.slice(1));
  let authError = null;
  if (hash.has('gh_token')) {
    storeToken(hash.get('gh_token'), localStorage.getItem(REMEMBER_KEY) === '1', { via: 'github' });
    history.replaceState(null, '', location.pathname + location.search); // drop the token from the address bar and history
  } else if (hash.has('auth_error')) {
    authError = hash.get('auth_error');
    history.replaceState(null, '', location.pathname + location.search);
  }

  async function gh(path, opts = {}) {
    const res = await fetch(API + path, {
      ...opts,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        Authorization: `Bearer ${S.token}`,
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...opts.headers,
      },
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        msg += `: ${(await res.json()).message}`;
      } catch {}
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : opts.raw ? res.text() : res.json();
  }
  const raw = (path) => gh(path, { raw: true, headers: { Accept: 'application/vnd.github.raw+json' } });

  const setStatus = (...parts) => put($('conn-status'), ...parts);
  function connectedStatus() {
    setStatus(
      `Connected${S.login ? ` as ${S.login}` : ''} to ${S.repo} (branch ${S.branch}). “Save to GitHub” creates a commit, then the site rebuilds. `,
      linkAction('Sign out', () => {
        forgetToken();
        S.token = null;
        setStatus('Signed out. Offline mode: changes are downloaded as files.');
        $('gh-login').hidden = !boot.authUrl;
        renderSavebar();
      }),
    );
    $('gh-login').hidden = true;
  }

  // Checks the token, then loads the files from GitHub.
  async function useToken(token, repo, branch) {
    S.token = token;
    const [user, info] = await Promise.all([gh('/user').catch(() => null), gh(`/repos/${repo}`)]);
    if (info.permissions && !info.permissions.push) throw new Error('this account cannot write to the repository');
    S.repo = repo;
    S.branch = branch;
    S.login = user?.login || null;
    await loadFromGitHub();
  }

  connForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (anyDirty() && !confirm('Connecting reloads the files from GitHub. Unsaved changes will be lost. Continue?')) return;
    const token = connForm.token.value.trim();
    const repo = connForm.repo.value.trim();
    const branch = connForm.branch.value.trim() || 'main';
    setStatus('Connecting…');
    try {
      await useToken(token, repo, branch);
      storeToken(token, connForm.remember.checked, { via: 'pat' });
      localStorage.setItem(CONN_KEY, JSON.stringify({ repo, branch }));
      connectedStatus();
      $('conn-details').open = false;
    } catch (err) {
      S.token = null;
      setStatus(el('b', {}, `Could not connect: ${err.message}.`), ' Check the repository name and the token’s permissions (Contents: Read and write).');
      if (!S.files.length) await loadOffline();
    }
    renderAll();
  });

  // ---------- loading ----------
  function addFile(name, xml) {
    const doc = parseOpml(xml);
    tagUids(doc.children);
    S.files.push({ name, doc, baseline: snapshot(doc), isNew: false, deleted: false, undo: [] });
  }
  async function loadOffline() {
    S.files = [];
    const results = await Promise.allSettled(boot.files.map(async (name) => [name, await (await fetch(`${S.base}opml/${name}`)).text()]));
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      try {
        addFile(...r.value);
      } catch (e) {
        console.warn(r.value[0], e);
      }
    }
  }
  async function loadFromGitHub() {
    const ref = encodeURIComponent(S.branch);
    const list = await gh(`/repos/${S.repo}/contents/opml?ref=${ref}`).catch((e) => {
      if (e.status === 404) return [];
      throw e;
    });
    const opmls = list.filter((x) => x.type === 'file' && /\.opml$/i.test(x.name));
    const texts = await Promise.all(opmls.map((x) => raw(`/repos/${S.repo}/contents/opml/${encodeURIComponent(x.name)}?ref=${ref}`)));
    S.files = [];
    opmls.forEach((x, i) => {
      try {
        addFile(x.name, texts[i]);
      } catch (e) {
        alert(`${x.name} could not be read: ${e.message}`);
      }
    });
    try {
      S.config = JSON.parse(await raw(`/repos/${S.repo}/contents/tickertape.config.json?ref=${ref}`));
      S.configBaseline = JSON.stringify(S.config, null, 2);
    } catch {}
    sortFiles();
    if (!S.files.some((f) => f.name === S.current)) S.current = S.files[0]?.name || null;
    S.selected = null;
  }
  function sortFiles() {
    const order = Object.keys(S.config.views || {});
    S.files.sort((a, b) => {
      const ia = order.indexOf(slugOf(a));
      const ib = order.indexOf(slugOf(b));
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.name.localeCompare(b.name);
    });
  }

  // ---------- tree helpers ----------
  function find(uid, nodes = cur()?.doc.children, parent = null) {
    if (!nodes) return null;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n._uid === uid) return { node: n, list: nodes, index: i, parent };
      if (n.children) {
        const r = find(uid, n.children, n);
        if (r) return r;
      }
    }
    return null;
  }
  const contains = (node, uid) => !!node.children?.some((c) => c._uid === uid || contains(c, uid));
  const countFeeds = (n) => n.children.reduce((s, c) => s + (c.type === 'feed' ? 1 : countFeeds(c)), 0);
  function folders(nodes = cur()?.doc.children || [], depth = 0, out = []) {
    for (const n of nodes) {
      if (n.type !== 'folder') continue;
      out.push({ node: n, depth });
      folders(n.children, depth + 1, out);
    }
    return out;
  }
  const folderOptions = (exclude) =>
    folders()
      .filter((x) => !exclude || (x.node._uid !== exclude._uid && !contains(exclude, x.node._uid)))
      .map((x) => el('option', { value: String(x.node._uid) }, `${'   '.repeat(x.depth)}${x.node.text}`));

  function mutate(fn) {
    const f = cur();
    f.undo.push(structuredClone(f.doc));
    if (f.undo.length > 60) f.undo.shift();
    fn(f.doc);
    tagUids(f.doc.children);
    renderAll();
  }
  function moveNode(uid, targetUid, pos) {
    if (uid === targetUid) return;
    const src = find(uid);
    if (!src) return;
    if (targetUid != null && contains(src.node, targetUid)) return; // a category can't go inside itself
    mutate((doc) => {
      src.list.splice(src.index, 1);
      if (targetUid == null) return void doc.children.push(src.node);
      const t = find(targetUid);
      if (pos === 'inside') {
        t.node.children.push(src.node);
        S.collapsed.delete(t.node._uid);
      } else t.list.splice(t.index + (pos === 'after' ? 1 : 0), 0, src.node);
    });
  }
  const targetList = (folderUid) => (folderUid == null || folderUid === '' ? cur().doc.children : find(Number(folderUid))?.node.children || cur().doc.children);
  function currentFolderUid() {
    const s = S.selected != null && find(S.selected);
    if (!s) return '';
    return s.node.type === 'folder' ? s.node._uid : (s.parent?._uid ?? '');
  }

  // ---------- rendering ----------
  function renderAll() {
    renderFiles();
    renderEditor();
    renderSavebar();
  }

  function renderFiles() {
    if (!S.files.length) return put($('file-list'), el('i', {}, 'No OPML files.'));
    put(
      $('file-list'),
      S.files.map((f, i) => {
        const name = f.deleted ? el('s', {}, labelOf(f)) : labelOf(f);
        const mark = isDirty(f) ? ' *' : '';
        const item = f.name === S.current ? el('b', {}, name, mark) : [linkAction(name, () => ((S.current = f.name), (S.selected = null), (S.filter = ''), renderAll())), mark];
        return [i > 0 ? ' | ' : '', item];
      }),
      anyDirty() ? el('small', {}, ' (* = unsaved changes)') : null,
    );
  }

  function renderEditor() {
    const box = $('editor');
    const f = cur();
    if (!f) return put(box, el('p', {}, el('i', {}, 'Create a list or import an OPML file to get started.')));
    const slug = slugOf(f);
    const head = el(
      'fieldset',
      {},
      el('legend', {}, `List: opml/${f.name}`),
      el('p', {}, el('label', {}, 'Title: ', el('input', { size: 70, value: f.doc.title, onchange: (e) => mutate((d) => (d.title = e.target.value.trim())) }))),
      el('p', {}, el('label', {}, 'Short name (site menu): ', el('input', { size: 24, value: viewCfg(f).label || '', placeholder: f.doc.title.slice(0, 24), onchange: (e) => setLabel(f, e.target.value.trim()) }))),
      el(
        'p',
        {},
        `${plural(flattenFeeds(f.doc).length, 'feed')}. Published at `,
        el('a', { href: `${S.base}${slug}/` }, `${S.base}${slug}/`),
        '. ',
        f.deleted ? [el('b', {}, 'Will be deleted on save. '), action('Keep this list', () => ((f.deleted = false), renderAll()))] : action('Delete this list', () => deleteFile(f)),
      ),
    );
    const tools = el(
      'p',
      {},
      action('Add feeds', () => openFeedDialog()),
      ' ',
      action('Add category', addFolder),
      ' ',
      action('Collapse all', () => (folders().forEach((x) => S.collapsed.add(x.node._uid)), renderTree())),
      ' ',
      action('Expand all', () => (S.collapsed.clear(), renderTree())),
      ' | ',
      el('label', {}, 'Filter: ', el('input', { type: 'search', size: 20, value: S.filter, oninput: (e) => ((S.filter = e.target.value), renderTree()) })),
      el('br'),
      el('label', {}, 'Import an OPML file into the selected category: ', el('input', { type: 'file', accept: '.opml,.xml,text/xml', onchange: importInto })),
    );
    put(box, head, tools, el('div', { id: 'tree-box' }), el('p', {}, el('small', {}, 'Click a name to edit it. Drag and drop: on the top or bottom of a row to place before or after it, on the middle of a category to move into it.')));
    renderTree();
  }

  function setLabel(f, label) {
    const views = (S.config.views ||= {});
    const next = { ...(views[slugOf(f)] || {}) };
    if (label) next.label = label;
    else delete next.label;
    views[slugOf(f)] = next;
    renderAll();
  }

  function renderTree() {
    const f = cur();
    const box = $('tree-box');
    if (!box || !f) return;
    if (!f.doc.children.length) return put(box, el('p', {}, el('i', {}, 'This list is empty: add a category or some feeds.')));
    const dupes = new Map();
    for (const x of flattenFeeds(f.doc)) dupes.set(x.xmlUrl, (dupes.get(x.xmlUrl) || 0) + 1);
    const q = S.filter.trim().toLowerCase();
    const match = (n) => (n.type === 'feed' ? `${n.text} ${n.xmlUrl}`.toLowerCase().includes(q) : n.text.toLowerCase().includes(q) || n.children.some(match));

    const build = (nodes) =>
      nodes
        .filter((n) => !q || match(n))
        .map((n) => {
          const isFolder = n.type === 'folder';
          const open = q ? true : !S.collapsed.has(n._uid);
          const nameLink = linkAction(n.text, () => select(S.selected === n._uid ? null : n._uid));
          const row = el(
            'div',
            { class: 'row', draggable: 'true' },
            isFolder
              ? [linkAction(open ? '[−]' : '[+]', () => (S.collapsed.has(n._uid) ? S.collapsed.delete(n._uid) : S.collapsed.add(n._uid), renderTree())), ' ', el('b', {}, nameLink), ` (${countFeeds(n)})`]
              : [nameLink, el('small', {}, ` (${hostOf(n.xmlUrl) || 'invalid URL'})`)],
            !isFolder && dupes.get(n.xmlUrl) > 1 ? el('small', {}, el('b', {}, ' [duplicate]')) : null,
            !isFolder && !isHttp(n.xmlUrl) ? el('small', {}, el('b', {}, ' [invalid URL]')) : null,
          );
          wireDnd(row, n);
          const li = el('li', {}, row);
          if (S.selected === n._uid) li.append(inspector(n));
          if (isFolder && open && n.children.length) li.append(el('ul', {}, build(n.children)));
          return li;
        });

    const rootDrop = el('p', { class: 'row' }, el('small', {}, '[ drop here to move to the top level ]'));
    rootDrop.addEventListener('dragover', (e) => (e.preventDefault(), rootDrop.classList.add('drop-inside')));
    rootDrop.addEventListener('dragleave', () => rootDrop.classList.remove('drop-inside'));
    rootDrop.addEventListener('drop', (e) => {
      e.preventDefault();
      rootDrop.classList.remove('drop-inside');
      moveNode(Number(e.dataTransfer.getData('text/plain')), null, 'inside');
    });
    const list = build(f.doc.children);
    put(box, list.length ? el('ul', { id: 'etree' }, list) : el('p', {}, el('i', {}, 'No feed matches the filter.')), q ? null : rootDrop);
  }

  let dragUid = null;
  function wireDnd(row, n) {
    row.addEventListener('dragstart', (e) => {
      dragUid = n._uid;
      e.dataTransfer.setData('text/plain', String(n._uid));
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
    const posOf = (e) => {
      const r = row.getBoundingClientRect();
      const y = (e.clientY - r.top) / r.height;
      if (n.type === 'folder') return y < 0.28 ? 'before' : y > 0.72 ? 'after' : 'inside';
      return y < 0.5 ? 'before' : 'after';
    };
    const clear = () => row.classList.remove('drop-before', 'drop-after', 'drop-inside');
    row.addEventListener('dragover', (e) => {
      if (dragUid == null || dragUid === n._uid) return;
      e.preventDefault();
      clear();
      row.classList.add('drop-' + posOf(e));
    });
    row.addEventListener('dragleave', clear);
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      clear();
      const uid = Number(e.dataTransfer.getData('text/plain'));
      dragUid = null;
      moveNode(uid, n._uid, posOf(e));
    });
  }

  function select(uid) {
    S.selected = uid;
    renderTree();
    if (uid != null) document.querySelector('#etree fieldset input')?.focus();
  }

  // Inline edit form, shown under the selected row.
  function inspector(n) {
    const { list, index } = find(n._uid);
    const isFeed = n.type === 'feed';
    const field = (label, key, size, type = 'text') =>
      el('p', {}, el('label', {}, `${label}:`, el('br'), el('input', { type, size, value: n[key] || '', onchange: (e) => mutate(() => (find(n._uid).node[key] = e.target.value.trim())) })));
    const moveSel = el(
      'select',
      { onchange: (e) => e.target.value !== '__' && moveInto(n._uid, e.target.value) },
      el('option', { value: '__' }, 'Move to…'),
      el('option', { value: '' }, 'Top level'),
      folderOptions(n),
    );
    return el(
      'fieldset',
      {},
      el('legend', {}, isFeed ? 'Edit feed' : 'Edit category'),
      field('Name', 'text', 50),
      isFeed ? field('Feed URL', 'xmlUrl', 70, 'url') : null,
      isFeed ? field('Website URL', 'htmlUrl', 70, 'url') : null,
      isFeed
        ? el(
            'p',
            {},
            el('a', { href: n.xmlUrl, target: '_blank', rel: 'noopener' }, 'open feed'),
            ' | ',
            el('a', { href: `https://validator.w3.org/feed/check.cgi?url=${encodeURIComponent(n.xmlUrl)}`, target: '_blank', rel: 'noopener' }, 'validate (W3C)'),
            n.htmlUrl ? [' | ', el('a', { href: n.htmlUrl, target: '_blank', rel: 'noopener' }, 'open website')] : null,
          )
        : el('p', {}, action('Add feeds here', () => openFeedDialog(n._uid)), ' ', action('Add subcategory', addFolder)),
      el(
        'p',
        {},
        action('Move up', () => shift(n._uid, -1), { disabled: index === 0 }),
        ' ',
        action('Move down', () => shift(n._uid, 1), { disabled: index === list.length - 1 }),
        ' ',
        moveSel,
        ' ',
        action(isFeed ? 'Remove feed' : 'Delete category', () => removeNode(n)),
        ' ',
        action('Close', () => select(null)),
      ),
    );
  }

  function shift(uid, d) {
    mutate(() => {
      const { list, index } = find(uid);
      const [x] = list.splice(index, 1);
      list.splice(index + d, 0, x);
    });
  }
  function moveInto(uid, folderUid) {
    mutate(() => {
      const src = find(uid);
      src.list.splice(src.index, 1);
      targetList(folderUid).push(src.node);
    });
  }
  function removeNode(n) {
    if (n.type === 'folder' && countFeeds(n) > 0 && !confirm(`Delete “${n.text}” and its ${plural(countFeeds(n), 'feed')}? You can undo until you save.`)) return;
    S.selected = null;
    mutate(() => {
      const h = find(n._uid);
      h.list.splice(h.index, 1);
    });
  }
  function addFolder() {
    const name = prompt('Name of the new category');
    if (!name?.trim()) return;
    const node = { type: 'folder', text: name.trim(), attrs: {}, children: [] };
    const where = currentFolderUid();
    mutate(() => targetList(where).push(node));
    select(node._uid);
  }

  // ---------- "add feeds" dialog ----------
  const form = $('feed-form');
  const mode = () => form.mode.value;
  form.addEventListener('change', (e) => {
    if (e.target.name === 'mode') {
      form.querySelectorAll('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== mode()));
      $('feed-error').textContent = '';
    }
  });
  const tplPreview = () => {
    const t = TEMPLATES[form.tpl.value];
    $('tpl-label').textContent = t.label;
    form.tplValue.placeholder = t.ph;
    const v = form.tplValue.value.trim();
    put($('tpl-preview'), v ? [t.build(v).text, el('br'), t.build(v).xmlUrl] : '');
  };
  form.tpl.addEventListener('change', tplPreview);
  form.tplValue.addEventListener('input', tplPreview);

  function openFeedDialog(folderUid = currentFolderUid()) {
    form.reset();
    form.querySelectorAll('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== 'url'));
    $('feed-error').textContent = '';
    put(form.folder, el('option', { value: '' }, 'Top level'), folderOptions());
    form.folder.value = String(folderUid ?? '');
    tplPreview();
    $('dlg-feed').showModal();
  }
  form.addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'ok') return;
    const fail = (msg) => {
      e.preventDefault();
      $('feed-error').textContent = msg;
    };
    let feeds = [];
    if (mode() === 'url') {
      const u = form.xmlUrl.value.trim();
      if (!isHttp(u)) return fail('Enter a URL that starts with https:// or http://.');
      feeds = [{ xmlUrl: u, text: form.text.value.trim() || hostOf(u), htmlUrl: form.htmlUrl.value.trim() }];
    } else if (mode() === 'tpl') {
      if (!form.tplValue.value.trim()) return fail('Enter a value for the template.');
      feeds = [TEMPLATES[form.tpl.value].build(form.tplValue.value)];
    } else {
      const bad = [];
      for (const l of form.bulk.value.split('\n').map((s) => s.trim()).filter(Boolean)) {
        const [a, b] = l.includes('|') ? l.split('|').map((s) => s.trim()) : [null, l];
        isHttp(b) ? feeds.push({ xmlUrl: b, text: a || hostOf(b), htmlUrl: '' }) : bad.push(l);
      }
      if (bad.length) return fail(`Invalid URL on these lines: ${bad.join(', ')}`);
      if (!feeds.length) return fail('Paste at least one URL.');
    }
    const existing = new Set(flattenFeeds(cur().doc).map((x) => x.xmlUrl));
    const dup = feeds.filter((x) => existing.has(x.xmlUrl)).length;
    if (dup && !confirm(`${plural(dup, 'feed')} already in this list. Add anyway?`)) return fail('');
    const nodes = feeds.map((x) => ({ type: 'feed', attrs: {}, ...x }));
    const where = form.folder.value;
    mutate(() => targetList(where).push(...nodes));
    if (nodes.length === 1) select(nodes[0]._uid);
  });

  // ---------- lists: new / import / delete ----------
  const nf = $('newfile-form');
  const syncUrl = () => ($('newfile-url').textContent = `${S.base}${nf.name.value || 'my-topic'}/`);
  nf.title.addEventListener('input', () => {
    if (!nf.name.dataset.touched) nf.name.value = slugFromFilename(nf.title.value.normalize('NFD').replace(/[̀-ͯ]/g, '')).slice(0, 40);
    syncUrl();
  });
  nf.name.addEventListener('input', () => ((nf.name.dataset.touched = '1'), syncUrl()));
  $('new-file').addEventListener('click', () => {
    nf.reset();
    delete nf.name.dataset.touched;
    syncUrl();
    $('dlg-newfile').showModal();
  });
  nf.addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'ok') return;
    const name = `${nf.name.value}.opml`;
    if (S.files.some((f) => f.name === name)) {
      e.preventDefault();
      return alert(`A file named ${name} already exists.`);
    }
    const doc = { title: nf.title.value.trim(), head: { dateCreated: new Date().toUTCString(), ...(S.login ? { ownerName: S.login } : {}) }, wrapped: false, children: [] };
    S.files.push({ name, doc, baseline: '', isNew: true, deleted: false, undo: [] });
    S.current = name;
    S.selected = null;
    renderAll();
  });
  $('import-new').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const doc = parseOpml(await file.text());
      tagUids(doc.children);
      const base = slugFromFilename(file.name.normalize('NFD').replace(/[̀-ͯ]/g, '')) || 'import';
      let name = `${base}.opml`;
      for (let i = 2; S.files.some((f) => f.name === name); i++) name = `${base}-${i}.opml`;
      S.files.push({ name, doc, baseline: '', isNew: true, deleted: false, undo: [] });
      S.current = name;
      renderAll();
    } catch (err) {
      alert(`Import failed: ${err.message}`);
    }
  });
  async function importInto(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const doc = parseOpml(await file.text());
      const node = { type: 'folder', text: doc.title || file.name.replace(/\.\w+$/, ''), attrs: {}, children: doc.children };
      const where = currentFolderUid();
      mutate(() => targetList(where).push(node));
      select(node._uid);
    } catch (err) {
      alert(`Import failed: ${err.message}`);
    }
  }
  function deleteFile(f) {
    if (f.isNew) {
      S.files = S.files.filter((x) => x !== f);
      S.current = S.files[0]?.name || null;
    } else {
      if (!confirm(`Delete opml/${f.name}? The list disappears from the site after you save. Git history keeps a copy.`)) return;
      f.deleted = true;
    }
    renderAll();
  }

  // ---------- save bar ----------
  function renderSavebar() {
    const files = dirtyFiles();
    const cfg = configDirty();
    $('savebar').hidden = !files.length && !cfg;
    const names = [...files.map((f) => (f.deleted ? `${f.name} (delete)` : f.isNew ? `${f.name} (new)` : f.name)), ...(cfg ? ['tickertape.config.json'] : [])];
    $('dirty-summary').textContent = names.length ? `Unsaved: ${names.join(', ')}.` : '';
    const msg = $('commit-msg');
    if (!msg.dataset.touched) msg.value = `Update ${names.map((n) => n.split(' ')[0]).join(', ')}`;
    $('undo').disabled = !cur()?.undo.length;
    $('save').hidden = !S.token;
    $('download').textContent = S.token ? 'Download' : 'Download changed files';
  }
  $('commit-msg').addEventListener('input', (e) => (e.target.dataset.touched = '1'));
  $('undo').addEventListener('click', () => {
    const f = cur();
    if (!f?.undo.length) return;
    f.doc = f.undo.pop();
    S.selected = null;
    renderAll();
  });
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName);
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !typing) {
      e.preventDefault();
      $('undo').click();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      if (S.token && anyDirty()) $('save').click();
    }
  });
  $('show-xml').addEventListener('click', () => {
    const f = cur();
    if (!f) return;
    $('xml-title').textContent = `opml/${f.name}`;
    $('xml-pre').textContent = serializeOpml(f.doc);
    $('dlg-xml').showModal();
  });
  $('download').addEventListener('click', () => {
    const out = dirtyFiles()
      .filter((f) => !f.deleted)
      .map((f) => [f.name, serializeOpml(f.doc), 'text/x-opml']);
    if (configDirty()) out.push(['tickertape.config.json', configText(), 'application/json']);
    out.forEach(([name, text, type], i) =>
      setTimeout(() => {
        const a = el('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      }, i * 300),
    );
    if (!S.token && out.length) setStatus(`${plural(out.length, 'file')} downloaded. Put the .opml files in the repository’s opml/ folder (tickertape.config.json at the root), then push.`);
  });

  function validate() {
    for (const f of dirtyFiles()) {
      if (f.deleted) continue;
      if (!f.doc.title) return `${f.name} has no title.`;
      const bad = flattenFeeds(f.doc).find((x) => !isHttp(x.xmlUrl));
      if (bad) return `${f.name}: invalid URL for “${bad.text}”.`;
    }
    return null;
  }

  $('save').addEventListener('click', async () => {
    const problem = validate();
    if (problem) return alert(problem);
    const btn = $('save');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const branch = encodeURIComponent(S.branch);
      const head = (await gh(`/repos/${S.repo}/git/ref/heads/${branch}`)).object.sha;
      const baseTree = (await gh(`/repos/${S.repo}/git/commits/${head}`)).tree.sha;
      const blob = async (text) => (await gh(`/repos/${S.repo}/git/blobs`, { method: 'POST', body: JSON.stringify({ content: b64(text), encoding: 'base64' }) })).sha;
      const files = dirtyFiles();
      const tree = [];
      for (const f of files) {
        tree.push({ path: `opml/${f.name}`, mode: '100644', type: 'blob', sha: f.deleted ? null : await blob(serializeOpml(f.doc)) });
        if (f.deleted && S.config.views?.[slugOf(f)]) delete S.config.views[slugOf(f)];
      }
      if (configDirty()) tree.push({ path: 'tickertape.config.json', mode: '100644', type: 'blob', sha: await blob(configText()) });
      const newTree = await gh(`/repos/${S.repo}/git/trees`, { method: 'POST', body: JSON.stringify({ base_tree: baseTree, tree }) });
      const commit = await gh(`/repos/${S.repo}/git/commits`, { method: 'POST', body: JSON.stringify({ message: $('commit-msg').value.trim() || 'Update feeds', tree: newTree.sha, parents: [head] }) });
      await gh(`/repos/${S.repo}/git/refs/heads/${branch}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha }) });
      S.files = S.files.filter((f) => !f.deleted);
      for (const f of S.files) {
        f.baseline = snapshot(f.doc);
        f.isNew = false;
      }
      S.configBaseline = JSON.stringify(S.config, null, 2);
      delete $('commit-msg').dataset.touched;
      if (!S.files.some((f) => f.name === S.current)) S.current = S.files[0]?.name || null;
      setStatus(el('b', {}, `Saved (commit ${commit.sha.slice(0, 7)}).`), ' The site is rebuilding, allow two to three minutes: ', el('a', { href: `https://github.com/${S.repo}/actions` }, 'follow it in Actions'), '.');
    } catch (e) {
      const conflict = e.status === 422 || e.status === 409;
      if (e.status === 401) {
        forgetToken();
        S.token = null;
      }
      alert(
        conflict
          ? `The branch changed while you were editing (${e.message}). Download your files so nothing is lost, then reload the page.`
          : e.status === 401
            ? 'Your GitHub session has expired. Download your changes, then sign in again.'
            : `Save failed: ${e.message}`,
      );
    } finally {
      btn.disabled = false;
      put(btn, el('b', {}, 'Save to GitHub'));
      renderAll();
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (!anyDirty()) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // ---------- boot ----------
  (async () => {
    const saved = readToken();
    const repo = saved?.via === 'github' ? S.repo : savedConn?.repo || S.repo;
    const branch = saved?.via === 'github' ? S.branch : savedConn?.branch || S.branch;
    if (saved && repo) {
      setStatus('Connecting…');
      try {
        await useToken(saved.token, repo, branch);
        S.via = saved.via;
        connectedStatus();
      } catch (e) {
        S.token = null;
        forgetToken();
        setStatus(el('b', {}, `Your saved session no longer works (${e.message}).`), boot.authUrl ? ' Sign in again.' : ' Connect again.');
        if (e.message.includes('cannot write') || e.status === 404) $('conn-status').append(' If you signed in with GitHub, check that the Tickertape GitHub App is installed on this repository.');
        await loadOffline();
      }
    } else {
      if (authError) setStatus(el('b', {}, `GitHub sign-in failed: ${authError}.`));
      await loadOffline();
    }
    sortFiles();
    S.current ||= S.files[0]?.name || null;
    renderAll();
  })().catch((e) => setStatus(el('b', {}, `Loading error: ${e.message}`)));
}
