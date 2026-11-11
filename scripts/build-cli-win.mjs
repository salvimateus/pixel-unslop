// Builds dist-cli/pixel-unslop-cli.exe: a Node single executable application for Windows x64,
// made from WSL with the bundled CLI (run "npm run build:cli" first).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NODE_VERSION = 'v24.10.0';
const NODE_URL = `https://nodejs.org/dist/${NODE_VERSION}/win-x64/node.exe`;
/** From SHASUMS256.txt of the same release. */
const NODE_SHA256 = '93d6b1a22733fb035b19649041c0574b1a890df75ebce9d5e6e1bbe35d12b4a8';
const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = join(root, '.cache');
const cachedNode = join(cacheDir, `node-${NODE_VERSION}-win-x64.exe`);
const outDir = join(root, 'dist-cli');
const bundle = join(outDir, 'pixel-unslop.cjs');
const seaConfig = join(cacheDir, 'sea-config.json');
const blob = join(cacheDir, 'pixel-unslop-cli.blob');
const output = join(outDir, 'pixel-unslop-cli.exe');

function fail(message) {
  console.error(`build-cli-win: ${message}`);
  process.exit(1);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function downloadNode() {
  if (existsSync(cachedNode) && sha256(readFileSync(cachedNode)) === NODE_SHA256) return;
  console.log(`Downloading ${NODE_URL}`);
  // A plain request: no cookies, no credentials, no identifying headers.
  const response = await fetch(NODE_URL, { headers: { 'user-agent': 'node' }, credentials: 'omit' });
  if (!response.ok) fail(`download failed: HTTP ${response.status} for ${NODE_URL}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = sha256(bytes);
  if (digest !== NODE_SHA256) fail(`SHA-256 mismatch for node.exe: got ${digest}, expected ${NODE_SHA256}.`);
  const partial = `${cachedNode}.part`;
  writeFileSync(partial, bytes);
  renameSync(partial, cachedNode);
}

async function main() {
  if (process.version !== NODE_VERSION) {
    fail(`the local Node is ${process.version}, but the blob must come from ${NODE_VERSION} (the same version as the downloaded node.exe). Run this script with Node ${NODE_VERSION}.`);
  }
  if (!existsSync(bundle)) fail(`${bundle} is missing. Run "npm run build:cli" first.`);
  mkdirSync(cacheDir, { recursive: true });
  await downloadNode();

  writeFileSync(
    seaConfig,
    JSON.stringify(
      { main: bundle, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false },
      null,
      2,
    ),
  );
  rmSync(blob, { force: true });
  execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });
  if (!existsSync(blob)) fail('node did not write the SEA blob.');

  const staging = `${output}.part`;
  rmSync(staging, { force: true });
  copyFileSync(cachedNode, staging);
  const require = createRequire(import.meta.url);
  const { inject } = require('postject');
  await inject(staging, 'NODE_SEA_BLOB', readFileSync(blob), { sentinelFuse: SENTINEL_FUSE, overwrite: true });
  rmSync(output, { force: true });
  renameSync(staging, output);
  // The executable bit lets WSL run the exe through interop; Windows ignores it.
  chmodSync(output, 0o755);
  console.log(`Wrote ${output}`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
