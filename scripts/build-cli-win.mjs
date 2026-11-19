// Builds dist-cli/pixel-unslop-cli.exe: a Node single executable application for Windows x64,
// made from WSL with the bundled CLI (run "npm run build:cli" first).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NODE_VERSION = 'v24.10.0';
const NODE_URL = `https://nodejs.org/dist/${NODE_VERSION}/win-x64/node.exe`;
/** From SHASUMS256.txt of the same release. */
const NODE_SHA256 = '93d6b1a22733fb035b19649041c0574b1a890df75ebce9d5e6e1bbe35d12b4a8';
const LINUX_NODE_URL = `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.gz`;
/** From SHASUMS256.txt of the same release. */
const LINUX_NODE_SHA256 = '2b03c5417ce0b1076780df00e01da373bead3b4b80d1c78c1ad10ee7b918d90c';
const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = join(root, '.cache');
const cachedNode = join(cacheDir, `node-${NODE_VERSION}-win-x64.exe`);
const cachedLinuxTarball = join(cacheDir, `node-${NODE_VERSION}-linux-x64.tar.gz`);
const outDir = join(root, 'dist-cli');
const bundle = join(outDir, 'pixel-unslop.cjs');
const seaConfig = join(cacheDir, 'sea-config.json');
const blob = join(cacheDir, 'pixel-unslop-cli.blob');
const output = join(outDir, 'pixel-unslop-cli.exe');

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function download(url, path, expectedSha256) {
  if (existsSync(path) && sha256(readFileSync(path)) === expectedSha256) return;
  console.log(`Downloading ${url}`);
  // A plain request: no cookies, no credentials, no identifying headers.
  const response = await fetch(url, { headers: { 'user-agent': 'node' }, credentials: 'omit' });
  if (!response.ok) fail(`download failed: HTTP ${response.status} for ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = sha256(bytes);
  if (digest !== expectedSha256) fail(`SHA-256 mismatch for ${url}: got ${digest}, expected ${expectedSha256}.`);
  const partial = `${path}.part`;
  writeFileSync(partial, bytes);
  renameSync(partial, path);
}

/** Deletes cached Node files of other versions and unfinished downloads, so a version bump replaces the old files. */
function pruneCache() {
  const current = new Set([`node-${NODE_VERSION}-win-x64.exe`, `node-${NODE_VERSION}-linux-x64.tar.gz`]);
  for (const name of readdirSync(cacheDir)) {
    const match = /^(node-v[^/]+-(?:win-x64\.exe|linux-x64\.tar\.gz))(\.part)?$/.exec(name);
    if (match && (match[2] || !current.has(match[1]))) rmSync(join(cacheDir, name), { force: true });
  }
}

/**
 * Returns a Node binary of NODE_VERSION that runs on this host: the SEA blob must come from the same Node version
 * as the injected node.exe, whatever Node runs this script. On Linux the binary goes into tempDir.
 */
async function blobNode(tempDir) {
  const host = `${process.platform}-${process.arch}`;
  if (host === 'win32-x64') return cachedNode;
  if (host !== 'linux-x64') fail(`unsupported host ${host}. Run this script on linux-x64 (for example WSL) or win32-x64.`);
  await download(LINUX_NODE_URL, cachedLinuxTarball, LINUX_NODE_SHA256);
  const member = `node-${NODE_VERSION}-linux-x64/bin/node`;
  execFileSync('tar', ['-xzf', cachedLinuxTarball, '-C', tempDir, member], { stdio: 'inherit' });
  return join(tempDir, member);
}

const CERTIFICATE_TABLE_INDEX = 4;

/**
 * Removes the Authenticode signature of a PE file in place, like "signtool remove /s": the injection of the SEA
 * blob breaks the signature of node.exe, and an exe with a broken signature looks worse than an unsigned one.
 */
function stripAuthenticode(path) {
  const bytes = readFileSync(path);
  if (bytes.length < 0x40 || bytes.toString('latin1', 0, 2) !== 'MZ') fail(`${path} is not a PE file (no MZ header).`);
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset + 24 > bytes.length || bytes.toString('latin1', peOffset, peOffset + 4) !== 'PE\0\0') fail(`${path} has no PE header.`);
  const optionalHeader = peOffset + 24;
  const magic = bytes.readUInt16LE(optionalHeader);
  if (magic !== 0x10b && magic !== 0x20b) fail(`${path} has an unknown optional header (magic 0x${magic.toString(16)}).`);
  const isPe32Plus = magic === 0x20b;
  const directoryCount = bytes.readUInt32LE(optionalHeader + (isPe32Plus ? 108 : 92));
  if (directoryCount <= CERTIFICATE_TABLE_INDEX) return;
  const entry = optionalHeader + (isPe32Plus ? 112 : 96) + CERTIFICATE_TABLE_INDEX * 8;
  const certOffset = bytes.readUInt32LE(entry);
  const certSize = bytes.readUInt32LE(entry + 4);
  if (certSize === 0) return;
  // The certificate table is not mapped into memory and always sits at the end of a signed file.
  if (certOffset + certSize !== bytes.length) {
    fail(`${path}: the certificate table (offset ${certOffset}, size ${certSize}) is not at the end of the file (${bytes.length} bytes).`);
  }
  const unsigned = Buffer.from(bytes.subarray(0, certOffset));
  unsigned.writeUInt32LE(0, entry);
  unsigned.writeUInt32LE(0, entry + 4);
  writeFileSync(path, unsigned);
}

async function main() {
  if (!existsSync(bundle)) fail(`${bundle} is missing. Run "npm run build:cli" first.`);
  mkdirSync(cacheDir, { recursive: true });
  pruneCache();
  await download(NODE_URL, cachedNode, NODE_SHA256);
  const tempDir = mkdtempSync(join(tmpdir(), 'pixel-unslop-node-'));
  try {
    await build(await blobNode(tempDir));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function build(node) {
  const version = execFileSync(node, ['--version'], { encoding: 'utf8' }).trim();
  if (version !== NODE_VERSION) fail(`${node} reports ${version}, but the blob must come from ${NODE_VERSION}.`);

  writeFileSync(
    seaConfig,
    JSON.stringify(
      { main: bundle, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false },
      null,
      2,
    ),
  );
  rmSync(blob, { force: true });
  execFileSync(node, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });
  if (!existsSync(blob)) fail('node did not write the SEA blob.');

  const staging = `${output}.part`;
  rmSync(staging, { force: true });
  copyFileSync(cachedNode, staging);
  stripAuthenticode(staging);
  const require = createRequire(import.meta.url);
  const { inject } = require('postject');
  await inject(staging, 'NODE_SEA_BLOB', readFileSync(blob), { sentinelFuse: SENTINEL_FUSE, overwrite: true });
  rmSync(output, { force: true });
  renameSync(staging, output);
  // The executable bit lets WSL run the exe through interop; Windows ignores it.
  chmodSync(output, 0o755);
  console.log(`Wrote ${output}`);
}

main().catch((error) => {
  console.error(`build-cli-win: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
