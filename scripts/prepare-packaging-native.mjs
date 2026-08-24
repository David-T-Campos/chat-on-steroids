/**
 * Stage Windows native dependencies that npm intentionally omits when the host CPU differs
 * from the target CPU. The ordinary npm install already contains both Windows prebuilds for
 * node-pty and the two tree-sitter packages, but Sharp publishes one @img package per CPU.
 *
 * electron-builder can therefore package x64 + arm64 from one checkout only after both Sharp
 * platform packages exist on disk. Their exact URL and integrity come from package-lock.json,
 * so this does not introduce a second dependency version source.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WINDOWS_ARCHES } from './packaging-versions.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = path.join(root, 'node_modules', '.cache', 'packaging-native');

const say = (message) => process.stdout.write(`${message}\n`);

function sha512FromIntegrity(integrity) {
  const match = /^sha512-([A-Za-z0-9+/=]+)$/.exec(integrity ?? '');
  if (!match) throw new Error(`Unsupported package-lock integrity: ${integrity}`);
  return Buffer.from(match[1], 'base64').toString('hex');
}

async function download(url, target) {
  if (existsSync(target)) return;
  const response = await fetch(url, { headers: { 'user-agent': 'chat-on-steroids-build' } });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  await writeFile(target, Buffer.from(await response.arrayBuffer()));
}

async function fileTree(dir, relative = '', files = new Map()) {
  if (!existsSync(dir)) return files;
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await fileTree(absolute, childRelative, files);
      continue;
    }
    if (!entry.isFile()) throw new Error(`Unexpected non-file in native package: ${childRelative}`);
    const bytes = await readFile(absolute);
    files.set(childRelative, {
      absolute,
      sha256: createHash('sha256').update(bytes).digest('hex')
    });
  }
  return files;
}

async function syncVerifiedTree(source, destination) {
  const sourceFiles = await fileTree(source);
  const destinationFiles = await fileTree(destination);
  await mkdir(destination, { recursive: true });

  for (const [relative, sourceFile] of sourceFiles) {
    const existing = destinationFiles.get(relative);
    if (existing?.sha256 === sourceFile.sha256) continue;
    const target = path.join(destination, ...relative.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(sourceFile.absolute, target);
  }

  for (const [relative, destinationFile] of destinationFiles) {
    if (!sourceFiles.has(relative)) await rm(destinationFile.absolute, { force: true });
  }

  const finalFiles = await fileTree(destination);
  if (finalFiles.size !== sourceFiles.size) return false;
  for (const [relative, sourceFile] of sourceFiles) {
    if (finalFiles.get(relative)?.sha256 !== sourceFile.sha256) return false;
  }
  return true;
}

async function stageSharpPackage(lock, arch) {
  const packageName = `@img/sharp-win32-${arch}`;
  const lockEntry = lock.packages?.[`node_modules/${packageName}`];
  if (!lockEntry?.version || !lockEntry.resolved || !lockEntry.integrity) {
    throw new Error(`package-lock.json has no complete ${packageName} entry`);
  }

  const destination = path.join(root, 'node_modules', '@img', `sharp-win32-${arch}`);
  const nativeFile = path.join(destination, 'lib', `sharp-win32-${arch}-${lockEntry.version}.node`);

  await mkdir(cacheDir, { recursive: true });
  const tarball = path.join(cacheDir, `sharp-win32-${arch}-${lockEntry.version}.tgz`);
  await download(lockEntry.resolved, tarball);

  const expected = sha512FromIntegrity(lockEntry.integrity);
  const actual = createHash('sha512').update(await readFile(tarball)).digest('hex');
  if (actual !== expected) {
    await rm(tarball, { force: true });
    throw new Error(`Integrity mismatch for ${packageName}@${lockEntry.version}`);
  }

  const extractDir = path.join(cacheDir, `extract-sharp-win32-${arch}-${lockEntry.version}`);
  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });
  execFileSync('tar.exe', ['-xzf', tarball, '-C', extractDir], { stdio: 'inherit' });

  const extracted = path.join(extractDir, 'package');
  const metadata = JSON.parse(await readFile(path.join(extracted, 'package.json'), 'utf8'));
  if (metadata.version !== lockEntry.version || !metadata.cpu?.includes(arch) || !metadata.os?.includes('win32')) {
    throw new Error(`Unexpected metadata in ${packageName}@${lockEntry.version}`);
  }

  // Materialize exactly the lockfile tarball, but leave byte-identical files untouched.
  // Windows can legitimately have libvips loaded while a developer packages the running app;
  // rewriting an already-verified DLL would fail with EPERM for no reproducibility benefit.
  if (!(await syncVerifiedTree(extracted, destination))) {
    throw new Error(`${packageName}@${lockEntry.version} could not be synchronized exactly`);
  }
  if (!existsSync(nativeFile)) throw new Error(`${packageName} did not contain ${path.basename(nativeFile)}`);
  say(`${packageName} ${lockEntry.version} verified from package-lock.json`);
}

function requirePrebuild(relative) {
  const target = path.join(root, 'node_modules', ...relative.split('/'));
  if (!existsSync(target)) throw new Error(`Required Windows prebuild is missing: ${relative}`);
}

async function main() {
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  for (const arch of WINDOWS_ARCHES) await stageSharpPackage(lock, arch);

  for (const arch of WINDOWS_ARCHES) {
    requirePrebuild(`node-pty/prebuilds/win32-${arch}/conpty.node`);
    requirePrebuild(`node-pty/prebuilds/win32-${arch}/conpty_console_list.node`);
    requirePrebuild(`node-pty/prebuilds/win32-${arch}/conpty/OpenConsole.exe`);
    requirePrebuild(`tree-sitter/prebuilds/win32-${arch}/tree-sitter.node`);
    requirePrebuild(`tree-sitter-bash/prebuilds/win32-${arch}/tree-sitter-bash.node`);
  }
  say('Windows x64 + arm64 native dependency prebuilds are ready.');
}

main().catch((error) => {
  process.stderr.write(`\nCould not prepare native packaging dependencies: ${error.message}\n`);
  process.exit(1);
});
