import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../auth-worker/worker.js';

const env = { GITHUB_CLIENT_ID: 'Iv1.abc', GITHUB_CLIENT_SECRET: 's3cret', ALLOWED_ORIGINS: 'https://nathan.github.io' };
const W = 'https://tickertape-auth.example.workers.dev';

async function startLogin(ret = 'https://nathan.github.io/rss/admin/') {
  const res = await worker.fetch(new Request(`${W}/login?return=${encodeURIComponent(ret)}`), env);
  return res;
}

test('login redirects to GitHub with PKCE and state, and sets a cookie', async () => {
  const res = await startLogin();
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get('Location'));
  assert.equal(loc.origin + loc.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(loc.searchParams.get('client_id'), 'Iv1.abc');
  assert.equal(loc.searchParams.get('redirect_uri'), `${W}/callback`);
  assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(loc.searchParams.get('code_challenge').length >= 43);
  assert.match(res.headers.get('Set-Cookie'), /^tt_oauth=.+HttpOnly; Secure; SameSite=Lax/);
  assert.ok(!res.headers.get('Location').includes('s3cret'));
});

test('login refuses origins that are not allowed', async () => {
  const res = await startLogin('https://evil.example/steal');
  assert.equal(res.status, 403);
});

test('callback exchanges the code with secret + verifier and returns the token in the fragment', async () => {
  const login = await startLogin();
  const state = new URL(login.headers.get('Location')).searchParams.get('state');
  const cookie = login.headers.get('Set-Cookie').split(';')[0];
  const realFetch = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = { url, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ access_token: 'ghu_TOKEN', token_type: 'bearer' }), { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const res = await worker.fetch(new Request(`${W}/callback?code=CODE&state=${state}`, { headers: { Cookie: cookie } }), env);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('Location'), 'https://nathan.github.io/rss/admin/#gh_token=ghu_TOKEN');
    assert.equal(sent.url, 'https://github.com/login/oauth/access_token');
    assert.equal(sent.body.client_secret, 's3cret');
    assert.equal(sent.body.code, 'CODE');
    assert.ok(sent.body.code_verifier.length >= 43);
    assert.match(res.headers.get('Set-Cookie'), /Max-Age=0/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('callback rejects a wrong state', async () => {
  const login = await startLogin();
  const cookie = login.headers.get('Set-Cookie').split(';')[0];
  const res = await worker.fetch(new Request(`${W}/callback?code=CODE&state=forged`, { headers: { Cookie: cookie } }), env);
  assert.equal(res.status, 400);
});

test('callback passes GitHub errors back to the page', async () => {
  const login = await startLogin();
  const state = new URL(login.headers.get('Location')).searchParams.get('state');
  const cookie = login.headers.get('Set-Cookie').split(';')[0];
  const res = await worker.fetch(new Request(`${W}/callback?error=access_denied&error_description=The+user+has+denied&state=${state}`, { headers: { Cookie: cookie } }), env);
  assert.equal(res.headers.get('Location'), 'https://nathan.github.io/rss/admin/#auth_error=The%20user%20has%20denied');
});
