/**
 * Bundle the pinned ripgrep Windows release for x64 + arm64.
 *
 * Version and archive hashes live in packaging-versions.mjs. Per-arch copies feed the
 * installer while resources/rg mirrors the host architecture for development.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { RIPGREP, WINDOWS_ARCHES } from './packaging-versions.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stagingRoot = path.join(root, 'resources', 'packaging', 'rg');
const devOutDir = path.join(root, 'resources', 'rg');
const cacheDir = path.join(root, 'node_modules', '.cache', 'ripgrep');
const say = (message) => process.stdout.write(`${message}\n`);

async function download(url, target) {
  if (existsSync(target)) return;
  const res = await fetch(url, { headers: { 'user-agent': 'chat-on-steroids-build' } });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  await writeFile(target, Buffer.from(await res.arrayBuffer()));
}

async function stageArchitecture(arch) {
  const target = RIPGREP.targets[arch];
  const tag = RIPGREP.version;
  const assetName = `ripgrep-${tag}-${target.upstreamArch}-pc-windows-msvc.zip`;
  const outDir = path.join(stagingRoot, arch);
  const stamp = path.join(outDir, 'VERSION');

  await mkdir(cacheDir, { recursive: true });
  const zipPath = path.join(cacheDir, assetName);
  const url = `https://github.com/BurntSushi/ripgrep/releases/download/${tag}/${assetName}`;
  await download(url, zipPath);

  const actual = createHash('sha256').update(await readFile(zipPath)).digest('hex');
  if (actual !== target.sha256) {
    await rm(zipPath, { force: true });
    throw new Error(`Checksum mismatch for ${assetName}\n  expected ${target.sha256}\n  got      ${actual}`);
  }
  say(`ripgrep ${tag} checksum ok (${actual.slice(0, 16)}...)`);

  // Recreate staging from the verified archive every time. Otherwise a matching VERSION
  // file could hide a modified rg.exe and defeat the checksum pin.
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  execFileSync('tar.exe', ['-xf', zipPath, '-C', outDir], { stdio: 'inherit' });

  const entries = await readdir(outDir, { withFileTypes: true });
  if (entries.length === 1 && entries[0].isDirectory()) {
    const inner = path.join(outDir, entries[0].name);
    for (const name of await readdir(inner)) {
      await rename(path.join(inner, name), path.join(outDir, name));
    }
    await rm(inner, { recursive: true, force: true });
  }

  if (!existsSync(path.join(outDir, 'rg.exe'))) throw new Error('rg.exe was not in the release archive');
  await writeFile(stamp, `${tag}\n`, 'utf8');
  say(`ripgrep ${tag} ${arch} staged`);
}

async function main() {
  for (const arch of WINDOWS_ARCHES) await stageArchitecture(arch);

  const devArch = WINDOWS_ARCHES.includes(process.arch) ? process.arch : 'x64';
  await rm(devOutDir, { recursive: true, force: true });
  await cp(path.join(stagingRoot, devArch), devOutDir, { recursive: true });
  say(`resources/rg mirrors ${devArch} for development`);
}

main().catch((error) => {
  process.stderr.write(`\nCould not bundle ripgrep: ${error.message}\n`);
  process.exit(1);
});
