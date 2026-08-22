/**
 * OS-backed secret store semantics that matter for release safety.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8')
  }
}));

const {
  getSecret,
  initSecretsPath,
  resetSecretsCacheForTests,
  setSecret
} = await import('../src/main/secrets.js');
const { formatLogAsJson, getLog, logInfo } = await import('../src/main/logger.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

let dir: string;

beforeEach(async () => {
  dir = await makeTempDir('clf-secrets-');
  initSecretsPath(dir);
  resetSecretsCacheForTests();
});

afterEach(async () => {
  await removeTempDir(dir);
});

describe('secret store', () => {
  it('serializes concurrent writes so one credential cannot erase another', async () => {
    await Promise.all([
      setSecret('bridgeToken', 'bridge-token-456'),
      setSecret('openaiApiKey', 'sk-openai-789')
    ]);

    expect(await getSecret('bridgeToken')).toBe('bridge-token-456');
    expect(await getSecret('openaiApiKey')).toBe('sk-openai-789');

    // Force a disk read, not the in-process cache.
    resetSecretsCacheForTests();
    expect(await getSecret('bridgeToken')).toBe('bridge-token-456');
    expect(await getSecret('openaiApiKey')).toBe('sk-openai-789');
    expect(await fs.stat(path.join(dir, 'secrets.bin'))).toBeTruthy();
  });

  it('does not leak a credential through the diagnostics renderer/export path', () => {
    // There is no registry of live secrets to consult any more — an agent is the chat it
    // runs in, and nothing is minted for it — so the backstop is shape alone: a long opaque
    // run of token characters is masked wherever it appears.
    const secret = 'bridge-token-abcdefghijklmnopqrstuvwxyz012345';
    logInfo(`tunnel opened with ${secret} while bootstrapping`);

    const latest = getLog().at(-1)!;
    expect(latest.message).not.toContain(secret);
    expect(latest.message).toContain('***');
    expect(formatLogAsJson()).not.toContain(secret);
  });
});
