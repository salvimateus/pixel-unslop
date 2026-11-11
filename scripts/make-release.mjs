import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = join(root, 'release');

const BUILD_SCRIPTS = ['build:win', 'build:cli', 'build:cli:win'];

const ARTIFACTS = [
  {
    from: 'src-tauri/target/x86_64-pc-windows-msvc/release/PixelUnslop.exe',
    to: 'windows/PixelUnslop.exe',
  },
  { from: 'dist-cli/pixel-unslop-cli.exe', to: 'windows/pixel-unslop-cli.exe' },
  { from: 'dist-cli/pixel-unslop.cjs', to: 'wsl/pixel-unslop.cjs' },
];

const WSL_WRAPPER = {
  to: 'wsl/pixel-unslop',
  content: `#!/bin/sh
if ! command -v node >/dev/null 2>&1; then
  echo "pixel-unslop: Node.js is required but 'node' is not in PATH." >&2
  exit 127
fi
script_path=$(readlink -f -- "$0" 2>/dev/null) || script_path=$0
exec node "$(dirname -- "$script_path")/pixel-unslop.cjs" "$@"
`,
};

function fail(message) {
  console.error(`\nrelease failed: ${message}`);
  process.exit(1);
}

function runScript(name) {
  console.log(`\n> npm run ${name}`);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['run', name], { cwd: root, stdio: 'inherit' });
  if (result.error) fail(`could not start "npm run ${name}": ${result.error.message}`);
  if (result.status !== 0) {
    const reason = result.signal ? `signal ${result.signal}` : `exit code ${result.status}`;
    fail(`"npm run ${name}" stopped with ${reason}`);
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

for (const name of BUILD_SCRIPTS) runScript(name);

const missing = ARTIFACTS.filter(({ from }) => !existsSync(join(root, from))).map(({ from }) => from);
if (missing.length > 0) fail(`missing build artifacts:\n  ${missing.join('\n  ')}`);

rmSync(releaseDir, { recursive: true, force: true });

const written = [];
for (const { from, to } of ARTIFACTS) {
  const target = join(releaseDir, to);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(root, from), target);
  written.push(target);
}

const wrapperPath = join(releaseDir, WSL_WRAPPER.to);
mkdirSync(dirname(wrapperPath), { recursive: true });
writeFileSync(wrapperPath, WSL_WRAPPER.content);
chmodSync(wrapperPath, 0o755);
written.push(wrapperPath);

console.log('\nRelease artifacts:');
for (const path of written) {
  const size = statSync(path).size;
  if (size === 0) fail(`empty artifact: ${relative(root, path)}`);
  console.log(`  ${relative(root, path).padEnd(36)} ${formatSize(size)}`);
}
