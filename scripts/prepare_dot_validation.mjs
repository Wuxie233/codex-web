#!/usr/bin/env node
// Prepare the experimental Linux Desktop bundle without changing the legacy path.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = '26.930.41038';
const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/prepare_dot_validation.mjs EXTRACTED_ASAR_DIRECTORY');
const input = await fs.realpath(source);
const scratch = path.join(root, 'scratch');
const target = path.join(scratch, 'asar');
if (input === target || input.startsWith(`${target}${path.sep}`)) {
  throw new Error('Use an independent, unmodified extracted bundle as input');
}
const manifest = JSON.parse(await fs.readFile(path.join(input, 'package.json'), 'utf8'));
if (manifest.version !== version) throw new Error(`Expected Desktop ${version}`);
try {
  const installed = JSON.parse(await fs.readFile(path.join(target, 'package.json'), 'utf8'));
  if (installed.version !== version) throw new Error('Refusing to replace an existing different Desktop version; use an isolated worktree');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const staging = path.join(scratch, 'dot-validation-staging');
await fs.mkdir(scratch, { recursive: true });
await fs.mkdir(staging); // A previous failed run must be inspected, never silently removed.
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
};
await fs.cp(input, staging, { recursive: true });
const patches = ['linux-dot-main.patch', 'linux-dot-webview.patch'];
const files = new Set();
for (const patch of patches) {
  const text = await fs.readFile(path.join(root, 'patches', patch), 'utf8');
  for (const match of text.matchAll(/^\+\+\+ b\/(.+)$/gm)) files.add(path.join(staging, match[1]));
}
run(process.execPath, [path.join(root, 'node_modules/prettier/bin/prettier.cjs'), '--ignore-path', '/dev/null', '--write', ...files]);
for (const patch of patches) {
  const data = await fs.readFile(path.join(root, 'patches', patch));
  run('patch', ['--batch', '--forward', '--fuzz=0', '-p1', '-d', staging], { input: data, stdio: ['pipe', 'inherit', 'inherit'] });
}
await fs.cp(path.join(root, 'assets'), path.join(staging, 'webview'), { recursive: true });
// Electron's addon ABI differs from host Node; resolve the wrapper's dependency.
await fs.rm(path.join(staging, 'node_modules/better-sqlite3'), { recursive: true, force: true });
const backup = path.join(scratch, 'dot-validation-previous');
try {
  await fs.lstat(backup);
  throw new Error('Previous candidate backup exists; inspect it before preparing again');
} catch (error) { if (error.code !== 'ENOENT') throw error; }
let moved = false;
try { await fs.rename(target, backup); moved = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
try { await fs.rename(staging, target); }
catch (error) { if (moved) await fs.rename(backup, target); throw error; }
if (moved) await fs.rm(backup, { recursive: true });
console.log(`Prepared isolated Desktop ${version}; build browser and server next.`);
