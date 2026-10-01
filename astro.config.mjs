// @ts-check
import node from '@astrojs/node';
import { defineConfig } from 'astro/config';

// The site is rendered by the bot's own Express server (src/web/server.ts), which
// passes live data and settings to pages as Astro.locals.web (src/web/api.ts).
export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'middleware' }),
  srcDir: './web',
  publicDir: './public',
  outDir: './web-dist',
  vite: {
    // Express depends on an older `cookie` than Astro; bundle Astro's copy into the
    // server build so the built pages don't pick up Express's version at runtime.
    ssr: { noExternal: ['cookie'] },
  },
});
