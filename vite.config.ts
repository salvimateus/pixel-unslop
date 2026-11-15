import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const GTM_ID = 'GTM-N8Q27V3V';

/** Google Tag Manager, only in the Vercel production build of the web app. */
function googleTagManager(): Plugin {
  return {
    name: 'pixel-unslop-gtm',
    apply: 'build',
    transformIndexHtml() {
      return [
        { tag: 'script', attrs: { async: true, src: `https://www.googletagmanager.com/gtm.js?id=${GTM_ID}` }, injectTo: 'head-prepend' },
        {
          tag: 'script',
          children: "\n  window.dataLayer = window.dataLayer || [];\n  function gtag(){dataLayer.push(arguments);}\n  gtag('js', new Date());\n",
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}

export default defineConfig({
  plugins: [svelte(), ...(process.env.VERCEL_ENV === 'production' ? [googleTagManager()] : [])],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  worker: { format: 'es' },
  build: { target: 'esnext' },
});
