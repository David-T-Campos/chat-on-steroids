import { describe, expect, it, vi } from 'vitest';
import type { Capabilities } from '../src/shared/types.js';

const computer = vi.hoisted(() => ({
  actAndCapture: vi.fn(async () => ({
    cursor: {
      screen: { x: 10, y: 20 },
      image: null,
      imageSize: null,
      frameId: null
    },
    clipboard: [],
    screenshot: null
  }))
}));

vi.mock('../src/main/computer/index.js', () => ({
  ComputerError: class ComputerError extends Error {},
  DEFAULT_SCREENSHOT_WIDTH: 1280,
  MAX_SCREENSHOT_WIDTH: 4096,
  actAndCapture: computer.actAndCapture,
  activeWindow: vi.fn(),
  findUi: vi.fn(),
  getWindowState: vi.fn(),
  listWindows: vi.fn(),
  screenshot: vi.fn(),
  waitForWindow: vi.fn()
}));

import { registerDesktopTools } from '../src/main/mcp/tools-desktop.js';

function caps(over: Partial<Capabilities>): Capabilities {
  return {
    browse: false,
    search: false,
    read: false,
    metadata: false,
    create: false,
    edit: false,
    move: false,
    deleteFile: false,
    command: false,
    screen: false,
    control: false,
    clipboardRead: false,
    clipboardWrite: false,
    ...over
  };
}

describe('Desktop computer permission normalization', () => {
  it('allows wait in a clipboard-only batch without demanding mouse/keyboard control', async () => {
    const liveCaps = caps({ clipboardRead: true });
    let computerHandler: ((input: any) => Promise<any>) | null = null;
    const registrar = {
      ctx: { privacyScreenshots: false },
      caps: liveCaps,
      exposedCaps: liveCaps,
      sessionToolsLive: false,
      sessionToolsExposed: false,
      agentToolsLive: false,
      agentToolsExposed: false,
      findExposed: false,
      register(name: string, _config: unknown, handler: (input: any) => Promise<any>) {
        if (name === 'computer') computerHandler = handler;
      },
      guarded: vi.fn()
    };
    registerDesktopTools(registrar as never);
    expect(computerHandler).not.toBeNull();

    const result = await computerHandler!({
      actions: [{ type: 'wait', ms: 0 }, { type: 'read_clipboard' }]
    });

    expect(result.isError).not.toBe(true);
    expect(computer.actAndCapture).toHaveBeenCalledWith(
      [{ type: 'wait', ms: 0 }, { type: 'read_clipboard' }],
      expect.objectContaining({ frameId: undefined, capture: undefined })
    );
  });
});
