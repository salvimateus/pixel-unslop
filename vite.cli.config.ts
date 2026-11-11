import { chmodSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const OUT_DIR = 'dist-cli';
const FILE_NAME = 'pixel-unslop.cjs';
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

/** Marks the bundle as executable, so `./dist-cli/pixel-unslop.cjs` runs directly in WSL. */
function executable(): Plugin {
  return {
    name: 'pixel-unslop-executable',
    apply: 'build',
    writeBundle() {
      chmodSync(join(OUT_DIR, FILE_NAME), 0o755);
    },
  };
}

/** The CLI as one CommonJS file for Node 20 or newer, with every dependency inside. */
export default defineConfig({
  publicDir: false,
  clearScreen: false,
  define: { __PIXEL_UNSLOP_VERSION__: JSON.stringify(version) },
  plugins: [executable()],
  ssr: { noExternal: true, target: 'node' },
  build: {
    ssr: 'src/cli/main.ts',
    outDir: OUT_DIR,
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    sourcemap: false,
    copyPublicDir: false,
    rolldownOptions: {
      external: [...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
      output: {
        format: 'cjs',
        entryFileNames: FILE_NAME,
        codeSplitting: false,
        banner: '#!/usr/bin/env node',
      },
    },
  },
});
