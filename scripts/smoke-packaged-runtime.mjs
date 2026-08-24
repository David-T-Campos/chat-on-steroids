import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { RIPGREP, TUNNEL_CLIENT } from './packaging-versions.mjs';

const repository = path.resolve(import.meta.dirname, '..');
const packageRoot = path.resolve(process.argv[2] ?? path.join(repository, 'release', 'win-unpacked'));
const sourcePackage = JSON.parse(readFileSync(path.join(repository, 'package.json'), 'utf8'));
const expectedVersion = sourcePackage.version;
const sharpVersion = sourcePackage.dependencies.sharp;
const appExecutable = path.join(packageRoot, 'Chat On Steroids.exe');

function peArch(file) {
  const fd = openSync(file, 'r');
  try {
    const dos = Buffer.alloc(64);
    if (readSync(fd, dos, 0, dos.length, 0) !== dos.length || dos.readUInt16LE(0) !== 0x5a4d) {
      throw new Error(`${file} is not a PE executable`);
    }
    const peOffset = dos.readUInt32LE(0x3c);
    const header = Buffer.alloc(6);
    if (readSync(fd, header, 0, header.length, peOffset) !== header.length || header.readUInt32LE(0) !== 0x00004550) {
      throw new Error(`${file} has no PE header`);
    }
    const machine = header.readUInt16LE(4);
    if (machine === 0x8664) return 'x64';
    if (machine === 0xaa64) return 'arm64';
    throw new Error(`${file} has unsupported PE machine 0x${machine.toString(16)}`);
  } finally {
    closeSync(fd);
  }
}

const targetArch = peArch(appExecutable);
const sharpPackage = `sharp-win32-${targetArch}`;
const tunnelUpstreamArch = TUNNEL_CLIENT.targets[targetArch].upstreamArch;
const tunnelLicenseStem = `tunnel-client-${TUNNEL_CLIENT.version}-windows-${tunnelUpstreamArch}`;

function runPackagedExecutable(relative, args, expectedText) {
  const executable = path.join(packageRoot, ...relative.split('/'));
  const result = spawnSync(executable, args, {
    cwd: packageRoot,
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${relative} ${args.join(' ')} exited ${result.status}: ${result.stderr || result.stdout}`);
  }
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (expectedText && !output.includes(expectedText)) {
    throw new Error(`${relative} output did not contain expected ${expectedText}: ${output}`);
  }
}

const requiredFiles = [
  'resources/app.asar',
  'LICENSE.electron.txt',
  'LICENSES.chromium.html',
  'resources/LICENSE',
  `resources/THIRD-PARTY-NOTICES-sharp-win32-${targetArch}.md`,
  'resources/extension/manifest.json',
  'resources/extension/background.js',
  'resources/extension/chatgpt-dom.js',
  'resources/extension/content.js',
  'resources/extension/fiber.js',
  'resources/extension/overlay.css',
  'resources/extension/popup.html',
  'resources/extension/popup.css',
  'resources/extension/popup.js',
  'resources/extension/sidepanel.html',
  'resources/extension/sidepanel.css',
  'resources/extension/sidepanel.js',
  'resources/extension/icons/icon16.png',
  'resources/extension/icons/icon32.png',
  'resources/extension/icons/icon48.png',
  'resources/extension/icons/icon128.png',
  'resources/tunnel/tunnel-client.exe',
  'resources/tunnel/cloudflared.exe',
  'resources/tunnel/VERSION',
  'resources/tunnel/LICENSE',
  'resources/tunnel/NOTICE',
  `resources/tunnel/${tunnelLicenseStem}-licenses.txt`,
  `resources/tunnel/${tunnelLicenseStem}.spdx.json`,
  'resources/rg/rg.exe',
  'resources/rg/VERSION',
  'resources/rg/COPYING',
  'resources/rg/LICENSE-MIT',
  'resources/rg/UNLICENSE',
  `resources/app.asar.unpacked/node_modules/@img/${sharpPackage}/LICENSE`,
  'resources/app.asar.unpacked/node_modules/sharp/LICENSE',
  'resources/app.asar.unpacked/node_modules/node-pty/LICENSE',
  'resources/app.asar.unpacked/node_modules/tree-sitter/LICENSE',
  'resources/app.asar.unpacked/node_modules/tree-sitter-bash/LICENSE',
  `resources/app.asar.unpacked/node_modules/@img/${sharpPackage}/lib/${sharpPackage}-${sharpVersion}.node`,
  `resources/app.asar.unpacked/node_modules/@img/${sharpPackage}/lib/libvips-42.dll`,
  `resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-${targetArch}/conpty.node`,
  `resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-${targetArch}/conpty_console_list.node`,
  `resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-${targetArch}/conpty/conpty.dll`,
  `resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-${targetArch}/conpty/OpenConsole.exe`,
  `resources/app.asar.unpacked/node_modules/tree-sitter/prebuilds/win32-${targetArch}/tree-sitter.node`,
  `resources/app.asar.unpacked/node_modules/tree-sitter-bash/prebuilds/win32-${targetArch}/tree-sitter-bash.node`
];
for (const relative of requiredFiles) {
  const target = path.join(packageRoot, ...relative.split('/'));
  if (!statSync(target).isFile()) throw new Error(`Packaged runtime is missing ${relative}`);
}
const sharpNoticePath = path.join(packageRoot, 'resources', `THIRD-PARTY-NOTICES-sharp-win32-${targetArch}.md`);
const sharpNotice = readFileSync(sharpNoticePath, 'utf8');
if (!sharpNotice.includes('libvips') || !sharpNotice.includes('LGPL')) {
  throw new Error('Packaged Sharp third-party notice is missing libvips/LGPL licensing information');
}

for (const relative of [
  'resources/tunnel/tunnel-client.exe',
  'resources/tunnel/cloudflared.exe',
  'resources/rg/rg.exe',
  `resources/app.asar.unpacked/node_modules/@img/${sharpPackage}/lib/${sharpPackage}-${sharpVersion}.node`,
  `resources/app.asar.unpacked/node_modules/@img/${sharpPackage}/lib/libvips-42.dll`,
  `resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-${targetArch}/conpty.node`,
  `resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-${targetArch}/conpty_console_list.node`,
  `resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-${targetArch}/conpty/conpty.dll`,
  `resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-${targetArch}/conpty/OpenConsole.exe`,
  `resources/app.asar.unpacked/node_modules/tree-sitter/prebuilds/win32-${targetArch}/tree-sitter.node`,
  `resources/app.asar.unpacked/node_modules/tree-sitter-bash/prebuilds/win32-${targetArch}/tree-sitter-bash.node`
]) {
  const target = path.join(packageRoot, ...relative.split('/'));
  const actualArch = peArch(target);
  if (actualArch !== targetArch) throw new Error(`${relative} is ${actualArch}, expected ${targetArch}`);
}

const sharpLibDir = path.join(packageRoot, 'resources', 'app.asar.unpacked', 'node_modules', '@img', sharpPackage, 'lib');
const sharpNativeFiles = readdirSync(sharpLibDir).filter((name) => /\.(?:dll|node)$/i.test(name));
if (sharpNativeFiles.length === 0) throw new Error(`Packaged ${sharpPackage} contains no native library files`);
for (const name of sharpNativeFiles) {
  const actualArch = peArch(path.join(sharpLibDir, name));
  if (actualArch !== targetArch) throw new Error(`${sharpPackage}/lib/${name} is ${actualArch}, expected ${targetArch}`);
}

const tunnelVersion = readFileSync(path.join(packageRoot, 'resources', 'tunnel', 'VERSION'), 'utf8').trim();
const rgVersion = readFileSync(path.join(packageRoot, 'resources', 'rg', 'VERSION'), 'utf8').trim();
if (tunnelVersion !== TUNNEL_CLIENT.version) {
  throw new Error(`Packaged tunnel-client ${tunnelVersion} does not match pinned ${TUNNEL_CLIENT.version}`);
}
if (rgVersion !== RIPGREP.version) {
  throw new Error(`Packaged ripgrep ${rgVersion} does not match pinned ${RIPGREP.version}`);
}

const extensionManifest = JSON.parse(
  readFileSync(path.join(packageRoot, 'resources', 'extension', 'manifest.json'), 'utf8')
);
if (extensionManifest.version !== expectedVersion) {
  throw new Error(`Packaged extension ${extensionManifest.version} does not match app ${expectedVersion}`);
}
const probe = String.raw`
(async () => {
  const sharp = require('./resources/app.asar/node_modules/sharp');
  const pty = require('./resources/app.asar/node_modules/node-pty');
  const Parser = require('./resources/app.asar/node_modules/tree-sitter');
  const Bash = require('./resources/app.asar/node_modules/tree-sitter-bash');
  const manifest = require('./resources/app.asar/package.json');
  const png = await sharp({
    create: { width: 2, height: 2, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } }
  }).png().toBuffer();
  const parser = new Parser();
  parser.setLanguage(Bash);
  const tree = parser.parse('echo packaged-tree-sitter');
  const shell = process.env.ComSpec || 'cmd.exe';
  const terminal = pty.spawn(shell, ['/d', '/s', '/c', 'echo packaged-pty'], {
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: process.env
  });
  let ptyOutput = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('node-pty packaged spawn timed out')), 10000);
    terminal.onData((data) => { ptyOutput += data; });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timer);
      if (exitCode !== 0) reject(new Error('node-pty child exited ' + exitCode));
      else resolve();
    });
  });
  const result = JSON.stringify({
    version: manifest.version,
    sharp: sharp.versions.sharp,
    libvips: sharp.versions.vips,
    pngBytes: png.length,
    pty: ptyOutput.includes('packaged-pty'),
    treeSitter: tree.rootNode.type
  }) + '\n';
  await new Promise((resolve, reject) => {
    process.stdout.write(result, (error) => error ? reject(error) : resolve());
  });
  process.exit(0);
})().catch((error) => {
  process.stderr.write(String(error?.stack || error) + '\n', () => process.exit(1));
});`;

if (process.platform !== 'win32' || process.arch !== targetArch) {
  process.stdout.write(
    `Packaged ${targetArch} resources and PE architectures verified for ${expectedVersion}; ` +
      `runtime execution skipped on ${process.platform}-${process.arch}.\n`
  );
} else {
  runPackagedExecutable('resources/rg/rg.exe', ['--version'], RIPGREP.version);
  runPackagedExecutable('resources/tunnel/tunnel-client.exe', ['--version'], TUNNEL_CLIENT.version.replace(/^v/, ''));
  runPackagedExecutable('resources/tunnel/cloudflared.exe', ['--version']);

  const result = spawnSync(appExecutable, ['-e', probe], {
    cwd: packageRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true
  });

  if (result.error) throw result.error;
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  else {
    const runtime = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    if (runtime.version !== expectedVersion) {
      throw new Error(`Packaged app ${runtime.version} does not match expected ${expectedVersion}`);
    }
    if (!runtime.pty || runtime.treeSitter !== 'program' || !runtime.sharp || !runtime.libvips || runtime.pngBytes <= 0) {
      throw new Error('Packaged native runtime probe returned incomplete results');
    }
    process.stdout.write(`Packaged ${targetArch} resources and native runtimes verified for ${expectedVersion}.\n`);
  }
}
