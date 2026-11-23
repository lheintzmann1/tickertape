import { defineConfig } from 'astro/config';

// In GitHub Actions, SITE_URL and BASE_PATH come from actions/configure-pages,
// so the same build works for user.github.io/<repo>/ and for a custom domain.
export default defineConfig({
  site: process.env.SITE_URL || undefined,
  base: process.env.BASE_PATH || '/',
  trailingSlash: 'ignore',
  build: { format: 'directory' },
  devToolbar: { enabled: false },
});
