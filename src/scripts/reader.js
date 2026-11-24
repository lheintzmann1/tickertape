// Client-side reader. Plain HTML output; state lives in the URL hash (#c=category&p=7&q=…&u=1)
// and read items in localStorage (per browser).
const DAY = 86_400_000;
const PAGE = 100;
const SEP = ' › ';
const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const fmtTime = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const fmtDate = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
const fmtDay = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fmtFull = new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeStyle: 'short' });

const dayKey = (t) => fmtDate.format(t);
function dayLabel(t) {
  const k = dayKey(t);
  const s = fmtDay.format(t);
  if (k === dayKey(Date.now())) return `Today, ${s}`;
  if (k === dayKey(Date.now() - DAY)) return `Yesterday, ${s}`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else e.setAttribute(k, v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c);
  return e;
};
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

export async function startReader(root) {
  const slug = root.dataset.slug;
  const $ = (id) => document.getElementById(id);
  const listEl = $('list');

  let data;
  try {
    const res = await fetch(root.dataset.src);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (e) {
    listEl.replaceChildren(el('p', {}, `Could not load the items (${e.message}). Reload the page; if it keeps failing, check the latest run in the repository’s Actions tab.`));
    return;
  }

  // ---- indexes ----
  const feedPaths = {};
  (function walk(nodes, p) {
    for (const n of nodes) {
      if (n.id) (feedPaths[n.id] ||= []).push(p);
      else walk(n.c, [...p, n.n]);
    }
  })(data.tree, []);
  const itemsById = new Map();
  for (const it of data.items) {
    it.x = norm(`${it.t} ${it.s || ''} ${data.feeds[it.f]?.n || ''}`);
    itemsById.set(it.i, it);
  }

  const READ_KEY = `tickertape:read:${slug}`;
  const read = new Set(store.get(READ_KEY, []).filter((id) => itemsById.has(id)));
  const saveRead = () => store.set(READ_KEY, [...read]);
  saveRead();

  // ---- state <-> hash ----
  const st = { scope: 'all', period: 7, q: '', unread: false };
  function readHash() {
    const h = new URLSearchParams(location.hash.slice(1));
    st.scope = h.get('c') ? 'c:' + h.get('c') : h.get('s') ? 's:' + h.get('s') : 'all';
    st.period = h.has('p') ? Number(h.get('p')) || 0 : 7;
    st.q = h.get('q') || '';
    st.unread = h.get('u') === '1';
  }
  function hashFor(over = {}) {
    const s = { ...st, ...over };
    const h = new URLSearchParams();
    if (s.scope.startsWith('c:')) h.set('c', s.scope.slice(2));
    if (s.scope.startsWith('s:')) h.set('s', s.scope.slice(2));
    if (s.period !== 7) h.set('p', String(s.period));
    if (s.q) h.set('q', s.q);
    if (s.unread) h.set('u', '1');
    return '#' + h.toString().replace(/\+/g, '%20');
  }
  const writeHash = () => {
    const h = hashFor();
    history.replaceState(null, '', h === '#' ? location.pathname : h);
  };
  readHash();

  // ---- filtering ----
  function baseMatches() {
    const cutoff = st.period ? Date.now() - st.period * DAY : -Infinity;
    const terms = norm(st.q).split(/\s+/).filter(Boolean);
    return data.items.filter((it) => it.d >= cutoff && terms.every((t) => it.x.includes(t)));
  }
  function inScope(it) {
    if (st.scope === 'all') return true;
    if (st.scope.startsWith('s:')) return it.f === st.scope.slice(2);
    const key = st.scope.slice(2);
    return (feedPaths[it.f] || []).some((p) => {
      const k = p.join(SEP);
      return k === key || k.startsWith(key + SEP);
    });
  }

  // ---- tree (re-rendered with counts on every refresh) ----
  function renderTree(base) {
    const unreadByFeed = {};
    for (const it of base) if (!read.has(it.i)) unreadByFeed[it.f] = (unreadByFeed[it.f] || 0) + 1;
    const count = (ids) => ids.reduce((s, id) => s + (unreadByFeed[id] || 0), 0);
    const link = (scope, label, n, extra) => [scope === st.scope ? el('b', {}, label) : el('a', { href: hashFor({ scope }) }, label), n ? ` (${n})` : '', extra || ''];
    const build = (nodes, p) =>
      el(
        'ul',
        {},
        nodes.map((n) => {
          if (n.id) {
            const f = data.feeds[n.id] || {};
            return el('li', { class: 'feed' }, link('s:' + n.id, n.n, unreadByFeed[n.id], f.err ? el('small', { title: f.err }, ' [failing]') : null));
          }
          const path = [...p, n.n];
          const ids = [];
          (function collect(c) {
            for (const x of c) x.id ? ids.push(x.id) : collect(x.c);
          })(n.c);
          return el('li', { class: 'dir' }, link('c:' + path.join(SEP), n.n, count(ids)), build(n.c, path));
        }),
      );
    const top = build(data.tree, []);
    top.prepend(el('li', { class: 'all' }, link('all', 'Whole list', count(Object.keys(data.feeds)))));
    $('tree').replaceChildren(top, el('p', {}, el('small', {}, 'In brackets: unread items in the selected period.')));
  }

  // Items published within one fetch cycle (3 hours) of the latest fetch get a "NEW!" stamp.
  const fresh = data.updatedAt ? Date.parse(data.updatedAt) - 3 * 3_600_000 : 0;

  // ---- list ----
  let current = [];
  let rendered = 0;
  let lastDay = null;
  let cursor = -1;

  function refresh() {
    writeHash();
    const base = baseMatches();
    renderTree(base);
    current = base.filter((it) => inScope(it) && (!st.unread || !read.has(it.i)));

    if ($('q').value !== st.q) $('q').value = st.q;
    $('period').value = String(st.period);
    $('unread').checked = st.unread;

    const parts = [];
    const backToAll = el('a', { href: hashFor({ scope: 'all' }) }, 'whole list');
    if (st.scope.startsWith('c:')) parts.push('Category: ', el('b', {}, st.scope.slice(2)), ' (', backToAll, '). ');
    if (st.scope.startsWith('s:')) {
      const f = data.feeds[st.scope.slice(2)] || {};
      parts.push('Feed: ', f.site ? el('a', { href: f.site }, el('b', {}, f.n)) : el('b', {}, f.n), ' (', backToAll, '). ');
      if (f.err) parts.push(`Last fetch failed: ${f.err}. `);
    }
    const unreadN = current.filter((it) => !read.has(it.i)).length;
    const periodTxt = st.period ? (st.period === 1 ? 'in the last 24 hours' : `in the last ${st.period} days`) : 'over the whole retention period';
    parts.push(
      current.length
        ? `${current.length} ${st.unread ? 'unread ' : ''}item${current.length === 1 ? '' : 's'}${st.unread ? '' : `, ${unreadN} unread`}, ${periodTxt}`
        : `No items ${periodTxt}`,
      st.q ? `, matching “${st.q}”` : '',
      '.',
    );
    $('scope').replaceChildren(...parts);

    listEl.replaceChildren();
    rendered = 0;
    lastDay = null;
    cursor = -1;
    $('more').replaceChildren();
    if (!current.length) {
      const msg = !data.items.length
        ? 'No items yet. They appear after the next fetch (the “Update feeds” workflow in the repository’s Actions tab).'
        : st.unread
          ? 'All caught up here. Untick “unread only” or pick a longer period.'
          : 'Nothing matches these filters: pick a longer period or another search.';
      listEl.append(el('p', {}, el('i', {}, msg)));
      return;
    }
    renderMore();
  }

  function renderMore() {
    const frag = document.createDocumentFragment();
    const end = Math.min(current.length, rendered + PAGE);
    for (let i = rendered; i < end; i++) {
      const it = current[i];
      const k = dayKey(it.d);
      if (k !== lastDay) {
        lastDay = k;
        frag.append(el('h2', {}, dayLabel(it.d)));
      }
      frag.append(itemBlock(it));
    }
    rendered = end;
    listEl.append(frag);
    const more = $('more');
    more.replaceChildren();
    if (rendered < current.length) {
      const b = el('button', { type: 'button', onclick: renderMore }, `Show ${Math.min(PAGE, current.length - rendered)} more (${current.length - rendered} left)`);
      more.append(b);
      observer.observe(b);
    }
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries)
        if (e.isIntersecting) {
          observer.unobserve(e.target);
          renderMore();
        }
    },
    { rootMargin: '800px' },
  );

  function itemBlock(it) {
    const feed = data.feeds[it.f] || { n: '?' };
    const box = el('div', { class: 'item' + (read.has(it.i) ? ' read' : ''), 'data-id': it.i });
    const mark = () => setRead(it.i, true, box);
    const title = it.l
      ? el('a', { class: 't', href: it.l, target: '_blank', rel: 'noopener noreferrer', onclick: mark, onauxclick: (e) => e.button === 1 && mark() }, it.t)
      : el('span', { class: 't' }, it.t);
    // Feeds that only give a date land on midnight UTC: no time shown then.
    const dateOnly = it.d % DAY === 0;
    const when = dateOnly ? fmtDate.format(it.d) : `${fmtDate.format(it.d)} ${fmtTime.format(it.d)}`;
    const path = feedPaths[it.f]?.[0];
    const toggle = el('a', { href: '#', class: 'toggle' }, read.has(it.i) ? 'mark unread' : 'mark read');
    toggle.addEventListener('click', (e) => {
      e.preventDefault();
      setRead(it.i, !read.has(it.i), box);
    });
    const meta = el(
      'p',
      {},
      'Source: ',
      feed.site ? el('a', { href: feed.site }, feed.n) : feed.n,
      it.a ? ` (${it.a})` : '',
      path?.length ? ` | Category: ${path.at(-1)}` : '',
      ` | Date: ${when}${it.g ? ' (first seen)' : ''} | `,
      toggle,
      data.repo && it.l ? [' | ', el('a', { href: selectionUrl(it), target: '_blank', rel: 'noopener', class: 'keep', title: 'Save with notes (opens a GitHub issue)' }, 'save')] : null,
    );
    const isNew = !it.g && fresh && it.d > fresh;
    box.append(el('h3', {}, isNew ? el('span', { class: 'new-badge', title: 'published in the 3 hours before the latest fetch' }, 'NEW!') : null, title), meta);
    if (it.s) box.append(el('p', {}, it.s));
    box._item = it;
    return box;
  }

  function setRead(id, value, box) {
    value ? read.add(id) : read.delete(id);
    saveRead();
    if (box) {
      box.classList.toggle('read', value);
      const t = box.querySelector('.toggle');
      if (t) t.textContent = value ? 'mark unread' : 'mark read';
    }
    renderTree(baseMatches());
  }

  function selectionUrl(it) {
    const feed = data.feeds[it.f] || {};
    const path = (feedPaths[it.f]?.[0] || []).join(SEP);
    const meta = JSON.stringify({ link: it.l, view: slug, source: feed.n, published: new Date(it.d).toISOString() }).replace(/-->/g, '--\\u003e');
    const md = (s) => s.replace(/([\\[\]*_`])/g, '\\$1');
    const body = [
      `> **[${md(it.t)}](${it.l})**`,
      `> ${feed.n}, list ${data.label}${path ? `${SEP}${path}` : ''}, published ${fmtDate.format(it.d)}`,
      '',
      '### Notes',
      '',
      '',
      '### Why it matters',
      '',
      '',
      `<!-- tickertape:${meta} -->`,
    ].join('\n');
    return `https://github.com/${data.repo}/issues/new?` + new URLSearchParams({ labels: 'saved', title: it.t, body }).toString();
  }

  // ---- controls ----
  let qTimer;
  $('q').addEventListener('input', (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      st.q = e.target.value.trim();
      refresh();
    }, 200);
  });
  $('period').addEventListener('change', (e) => {
    st.period = Number(e.target.value);
    refresh();
  });
  $('unread').addEventListener('change', (e) => {
    st.unread = e.target.checked;
    refresh();
  });
  $('mark-all').addEventListener('click', () => {
    const batch = current.filter((it) => !read.has(it.i)).map((it) => it.i);
    if (!batch.length) return;
    batch.forEach((id) => read.add(id));
    saveRead();
    for (const b of listEl.querySelectorAll('.item')) {
      b.classList.add('read');
      b.querySelector('.toggle').textContent = 'mark unread';
    }
    renderTree(baseMatches());
    const undo = el('a', { href: '#' }, 'undo');
    undo.addEventListener('click', (e) => {
      e.preventDefault();
      batch.forEach((id) => read.delete(id));
      saveRead();
      refresh();
    });
    $('scope').replaceChildren(`${batch.length} item${batch.length === 1 ? '' : 's'} marked as read (`, undo, ').');
  });
  window.addEventListener('hashchange', () => {
    readHash();
    refresh();
  });
  window.addEventListener('storage', (e) => {
    if (e.key !== READ_KEY) return;
    read.clear();
    for (const id of store.get(READ_KEY, [])) read.add(id);
    for (const b of listEl.querySelectorAll('.item')) b.classList.toggle('read', read.has(b.dataset.id));
    renderTree(baseMatches());
  });

  $('export-read').addEventListener('click', (e) => {
    e.preventDefault();
    const a = el('a', { href: URL.createObjectURL(new Blob([JSON.stringify({ slug, read: [...read] })], { type: 'application/json' })), download: `tickertape-read-${slug}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('import-read').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const j = JSON.parse(await file.text());
      for (const id of j.read || []) if (itemsById.has(id)) read.add(id);
      saveRead();
      refresh();
    } catch {
      alert('This file is not a valid read-state export.');
    }
    e.target.value = '';
  });

  // keyboard
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
    if (e.key === '/' && !typing) {
      e.preventDefault();
      $('q').focus();
      return;
    }
    if (e.key === 'Escape' && typing) return document.activeElement.blur();
    if (typing) return;
    const rows = [...listEl.querySelectorAll('.item')];
    if (!rows.length) return;
    const move = (d) => {
      rows[cursor]?.classList.remove('cur');
      cursor = Math.max(0, Math.min(rows.length - 1, cursor + d));
      rows[cursor].classList.add('cur');
      rows[cursor].scrollIntoView({ block: 'nearest' });
      if (cursor > rows.length - 10 && rendered < current.length) renderMore();
    };
    const row = rows[cursor];
    if (e.key === 'j') move(1);
    else if (e.key === 'k') move(-1);
    else if ((e.key === 'o' || e.key === 'Enter') && row?._item.l) {
      window.open(row._item.l, '_blank', 'noopener');
      setRead(row._item.i, true, row);
    } else if (e.key === 'm' && row) row.querySelector('.toggle').click();
    else if (e.key === 's' && row) row.querySelector('.keep')?.click();
    else return;
    e.preventDefault();
  });

  $('updated').textContent = data.updatedAt ? `Feeds fetched ${fmtFull.format(Date.parse(data.updatedAt))}.` : 'Feeds not fetched yet.';
  refresh();
}
