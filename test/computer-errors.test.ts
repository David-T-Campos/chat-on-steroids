import { describe, expect, it } from 'vitest';
import { isUnavailableUiProviderError } from '../src/main/computer/index.js';

describe('desktop UI Automation error handling', () => {
  it('degrades only a broken UIA provider server fault', () => {
    expect(
      isUnavailableUiProviderError(
        new Error(
          'UIA_FAILED: The server threw an exception. (Exception from HRESULT: 0x80010105 (RPC_E_SERVERFAULT))'
        )
      )
    ).toBe(true);

    expect(isUnavailableUiProviderError(new Error('UIA_FAILED: no accessible window with id 42'))).toBe(false);
    expect(isUnavailableUiProviderError(new Error('HELPER_TIMEOUT: desktop helper stopped responding'))).toBe(false);
  });
});
