// Tickertape sign-in helper: a Cloudflare Worker that completes GitHub's OAuth web flow.
//
// GitHub's token endpoint can't be called from a browser (no CORS) and still requires the
// app's client secret, so a static site needs a small server-side step. This is it:
//
//   /login?return=<page URL>  → redirects to GitHub's consent screen (with PKCE + state)
//   /callback                 → swaps the code for a user token, sends it back to the page
//                               in the URL fragment (#gh_token=…), which never reaches a server
//
// Settings (Worker → Settings → Variables and secrets):
//   GITHUB_CLIENT_ID      the GitHub App's client ID
//   GITHUB_CLIENT_SECRET  the GitHub App's client secret (type "Secret")
//   ALLOWED_ORIGINS       where tokens may be sent, comma-separated, e.g. https://you.github.io
//
// Nothing is stored: the token only passes through.

const COOKIE = 'tt_oauth';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/login') return await login(url, env);
      if (url.pathname === '/callback') return await callback(request, url, env);
      return text('Tickertape sign-in helper. Endpoints: /login, /callback.', 200);
    } catch (e) {
      return text(`Sign-in error: ${e.message}`, 500);
    }
  },
};

async function login(url, env) {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return text('The helper is not configured: set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.', 500);
  let back;
  try {
    back = new URL(url.searchParams.get('return') || '');
  } catch {
    return text('Missing or invalid "return" URL.', 400);
  }
  if (!allowed(env).includes(back.origin)) return text(`${back.origin} is not in ALLOWED_ORIGINS.`, 403);

  const state = crypto.randomUUID();
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const auth = new URL('https://github.com/login/oauth/authorize');
  auth.search = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: `${url.origin}/callback`,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  const cookie = encodeURIComponent(JSON.stringify({ state, verifier, back: back.href }));
  return redirect(auth.href, `${COOKIE}=${cookie}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
}

async function callback(request, url, env) {
  const raw = (request.headers.get('Cookie') || '').split(/;\s*/).find((c) => c.startsWith(COOKIE + '='));
  let saved;
  try {
    saved = JSON.parse(decodeURIComponent(raw.slice(COOKIE.length + 1)));
  } catch {
    return text('Sign-in expired or was started in another browser. Go back and click “Connect with GitHub” again.', 400);
  }
  if (!saved.state || saved.state !== url.searchParams.get('state')) return text('Invalid sign-in state. Go back and try again.', 400);
  const back = new URL(saved.back);
  if (!allowed(env).includes(back.origin)) return text('Return URL not allowed.', 403);
  const clear = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

  if (url.searchParams.get('error')) {
    back.hash = 'auth_error=' + encodeURIComponent(url.searchParams.get('error_description') || url.searchParams.get('error'));
    return redirect(back.href, clear);
  }
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'tickertape-auth' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code: url.searchParams.get('code'),
      redirect_uri: `${url.origin}/callback`,
      code_verifier: saved.verifier,
    }),
  });
  const data = await res.json().catch(() => ({}));
  back.hash = data.access_token ? 'gh_token=' + encodeURIComponent(data.access_token) : 'auth_error=' + encodeURIComponent(data.error_description || data.error || `HTTP ${res.status}`);
  return redirect(back.href, clear);
}

const allowed = (env) => (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const text = (body, status) => new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
const redirect = (location, cookie) =>
  new Response(null, { status: 302, headers: { Location: location, 'Set-Cookie': cookie, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
