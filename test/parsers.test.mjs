import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { parseFeed, toPlainText, decodeBody } from '../scripts/lib/feed.mjs';
import { parseOpml, serializeOpml, flattenFeeds, feedId } from '../src/lib/opml.js';

test('RSS 2.0 with CDATA, HTML descriptions and dc:date', () => {
  const xml = `<?xml version="1.0"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom"><channel>
    <title>Korben</title><link>https://korben.info/</link><atom:link rel="self" href="https://korben.info/feed"/>
    <item><title><![CDATA[L'IA & le COBOL]]></title><link>https://korben.info/a.html</link><guid isPermaLink="false">id-1</guid>
      <pubDate>Mon, 23 Nov 2026 09:00:00 +0100</pubDate><description><![CDATA[<p>Un <b>test</b> &amp; plus&nbsp;: «&nbsp;ok&nbsp;»</p><script>alert(1)</script>]]></description><dc:creator>Korben</dc:creator></item>
    <item><title>Sans date</title><link>/relatif</link><dc:date>2026-11-22T08:00:00Z</dc:date></item>
  </channel></rss>`;
  const f = parseFeed(xml, { url: 'https://korben.info/feed' });
  assert.equal(f.title, 'Korben');
  assert.equal(f.items[0].title, "L'IA & le COBOL");
  assert.equal(f.items[0].summary, 'Un test & plus : « ok »');
  assert.equal(f.items[0].rawId, 'id-1');
  assert.equal(f.items[0].author, 'Korben');
  assert.equal(f.items[0].date, Date.parse('2026-11-23T08:00:00Z'));
  assert.equal(f.items[1].link, 'https://korben.info/relatif');
  assert.equal(f.items[1].date, Date.parse('2026-11-22T08:00:00Z'));
});

test('Google News: description repeating the title is dropped', () => {
  const xml = `<rss><channel><title>t</title><item><title>COBOL is back - Les Echos</title><link>https://news.google.com/rss/articles/x</link>
    <description>&lt;a href="https://news.google.com/x"&gt;COBOL is back - Les Echos&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font color="#6f6f6f"&gt;Les Echos&lt;/font&gt;</description></item></channel></rss>`;
  const f = parseFeed(xml, { url: 'https://news.google.com/rss' });
  assert.equal(f.items[0].summary, '');
});

test('Atom (arXiv style) with multiple links', () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>arXiv</title><link href="https://arxiv.org/" rel="alternate"/>
    <entry><id>http://arxiv.org/abs/2611.00001v1</id><title>COBOL  to Java
      with LLMs</title><updated>2026-11-20T10:00:00Z</updated><published>2026-11-19T10:00:00Z</published>
      <summary>We study…</summary><author><name>A. Turing</name></author>
      <link href="http://arxiv.org/pdf/2611.00001v1" rel="related" type="application/pdf"/><link href="http://arxiv.org/abs/2611.00001v1" rel="alternate" type="text/html"/></entry></feed>`;
  const f = parseFeed(xml, { url: 'https://export.arxiv.org/api/query' });
  const it = f.items[0];
  assert.equal(it.title, 'COBOL to Java with LLMs');
  assert.equal(it.link, 'http://arxiv.org/abs/2611.00001v1');
  assert.equal(it.date, Date.parse('2026-11-19T10:00:00Z'));
  assert.equal(it.author, 'A. Turing');
});

test('RSS 1.0 / RDF', () => {
  const xml = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
    <channel rdf:about="https://x/"><title>RDF</title><link>https://x/</link></channel>
    <item rdf:about="https://x/1"><title>Un</title><link>https://x/1</link><dc:date>2026-11-01T00:00:00Z</dc:date></item></rdf:RDF>`;
  const f = parseFeed(xml, { url: 'https://x/rss' });
  assert.equal(f.items.length, 1);
  assert.equal(f.items[0].rawId, 'https://x/1');
});

test('JSON Feed', () => {
  const f = parseFeed(JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'J', items: [{ id: '1', url: 'https://j/1', title: 'Hello', content_html: '<p>Hi</p>', date_published: '2026-11-01T00:00:00Z' }] }), { url: 'https://j/feed.json' });
  assert.equal(f.items[0].summary, 'Hi');
});

test('javascript: links are rejected', () => {
  const f = parseFeed(`<rss><channel><item><title>x</title><link>javascript:alert(1)</link></item></channel></rss>`, { url: 'https://a/' });
  assert.equal(f.items[0].link, '');
});

test('ISO-8859-1 body decoding', () => {
  const latin = Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><rss><channel><title>Caf\xe9</title></channel></rss>', 'latin1');
  assert.match(decodeBody(latin, 'text/xml'), /Café/);
});

test('double-escaped HTML is stripped', () => {
  assert.equal(toPlainText('&lt;p&gt;Bonjour&lt;/p&gt;'), 'Bonjour');
});

test('OPML round trip keeps every feed, order and wrapper on the real files', async () => {
  for (const file of await readdir(new URL('../opml/', import.meta.url))) {
    const xml = await readFile(new URL(`../opml/${file}`, import.meta.url), 'utf8');
    const doc = parseOpml(xml);
    const again = parseOpml(serializeOpml(doc));
    assert.deepEqual(again.children, doc.children, file);
    assert.equal(again.wrapped, doc.wrapped);
    assert.equal(again.title, doc.title);
    assert.ok(flattenFeeds(doc).length > 40, file);
  }
});

test('OPML escaping and special characters survive', () => {
  const doc = { title: 'A & B "C"', head: {}, wrapped: false, children: [{ type: 'folder', text: 'Web, langages & <frameworks>', attrs: {}, children: [{ type: 'feed', text: "L'œil", xmlUrl: 'https://x/?a=1&b=2', htmlUrl: '', attrs: {} }] }] };
  const back = parseOpml(serializeOpml(doc));
  assert.equal(back.title, doc.title);
  assert.deepEqual(back.children, doc.children);
});

test('feedId is stable', () => {
  assert.equal(feedId('https://hnrss.org/frontpage'), feedId(' https://hnrss.org/frontpage '));
  assert.match(feedId('x'), /^[0-9a-f]{16}$/);
});
