/**
 * Bundle the pinned tunnel-client Windows release for both installer architectures.
 *
 * The release version and archive hashes live in packaging-versions.mjs, so rebuilding
 * the same commit cannot silently pick up a newer GitHub release. Per-arch copies feed
 * electron-builder while resources/tunnel mirrors the host architecture for dev runs.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { TUNNEL_CLIENT, WINDOWS_ARCHES } from './packaging-versions.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stagingRoot = path.join(root, 'resources', 'packaging', 'tunnel');
const devOutDir = path.join(root, 'resources', 'tunnel');
const cacheDir = path.join(root, 'node_modules', '.cache', 'tunnel-client');

const say = (message) => process.stdout.write(`${message}\n`);

async function download(url, target) {
  if (existsSync(target)) return;
  const res = await fetch(url, { headers: { 'user-agent': 'chat-on-steroids-build' } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  await writeFile(target, Buffer.from(await res.arrayBuffer()));
}

async function stageArchitecture(arch) {
  const target = TUNNEL_CLIENT.targets[arch];
  const tag = TUNNEL_CLIENT.version;
  const assetName = `tunnel-client-${tag}-windows-${target.upstreamArch}.zip`;
  const outDir = path.join(stagingRoot, arch);
  const stamp = path.join(outDir, 'VERSION');

  await mkdir(cacheDir, { recursive: true });
  const zipPath = path.join(cacheDir, assetName);
  const url = `https://github.com/openai/tunnel-client/releases/download/${tag}/${assetName}`;
  await download(url, zipPath);

  const actual = createHash('sha256').update(await readFile(zipPath)).digest('hex');
  if (actual !== target.sha256) {
    await rm(zipPath, { force: true });
    throw new Error(`Checksum mismatch for ${assetName}\n  expected ${target.sha256}\n  got      ${actual}`);
  }
  say(`checksum ok (${actual.slice(0, 16)}…)`);

  // Always materialize staging from the verified archive. A VERSION file is only metadata;
  // trusting an existing staging directory would let stale/corrupt files bypass the pin.
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  execFileSync('tar.exe', ['-xf', zipPath, '-C', outDir], { stdio: 'inherit' });

  // Some releases wrap everything in a single folder; flatten it if so.
  const entries = await readdir(outDir, { withFileTypes: true });
  if (entries.length === 1 && entries[0].isDirectory()) {
    const inner = path.join(outDir, entries[0].name);
    for (const name of await readdir(inner)) {
      await rename(path.join(inner, name), path.join(outDir, name));
    }
    await rm(inner, { recursive: true, force: true });
  }

  if (!existsSync(path.join(outDir, 'tunnel-client.exe'))) throw new Error('tunnel-client.exe was not in the archive');
  if (!existsSync(path.join(outDir, 'cloudflared.exe'))) throw new Error('cloudflared.exe was not in the archive');
  await writeFile(stamp, `${tag}\n`, 'utf8');
  say(`tunnel-client ${tag} ${arch} staged`);
}

async function main() {
  for (const arch of WINDOWS_ARCHES) await stageArchitecture(arch);

  const devArch = WINDOWS_ARCHES.includes(process.arch) ? process.arch : 'x64';
  await rm(devOutDir, { recursive: true, force: true });
  await cp(path.join(stagingRoot, devArch), devOutDir, { recursive: true });
  say(`resources/tunnel mirrors ${devArch} for development`);
}

main().catch((err) => {
  process.stderr.write(`\nCould not bundle tunnel-client: ${err.message}\n`);
  process.exit(1);
});
