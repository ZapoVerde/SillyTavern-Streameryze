// Stub for shared.js — aliased by vitest.config.js resolve.alias.
// Provides no-op defaults so any registry entry that imports ConnectionManagerRequestService
// (side-call.js, dispatch.js) can be loaded without needing the real cross-repo shared.js path,
// which sits outside this extension's directory and doesn't exist in the test environment.
import { vi } from 'vitest';

export const ConnectionManagerRequestService = {
    sendRequest: vi.fn(),
    getSupportedProfiles: vi.fn(() => []),
};
