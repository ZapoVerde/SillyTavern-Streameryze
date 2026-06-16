import { vi, describe, it, expect, beforeEach } from 'vitest';

// live-patch.js is in engine/ — the same depth as actions/ and tests/ from the ST root.
// Local files (that exist on disk) are mocked by their absolute path, so we use paths
// relative to tests/ here and Vitest resolves them to the same targets.

vi.mock('../../../../../script.js', () => ({
    messageFormatting: vi.fn(() => ''),
}));

vi.mock('../settings/storage.js', () => ({
    getSettings: vi.fn(() => ({ rules: [], verbose: false })),
}));

vi.mock('../engine/evaluate.js', () => ({
    evaluateTriggers: vi.fn(async () => null),
    getVarDeps:       vi.fn(() => []),
}));

vi.mock('../actions/index.js', () => ({
    resolveLbTokens:       vi.fn(async t => t),
    prefetchSideCall:      vi.fn(),
    getPrefetchedResults:  vi.fn(() => null),
}));

vi.mock('../badge.js', () => ({
    setBadge: vi.fn(),
}));

vi.mock('../inline-badge.js', () => ({
    buildResolvedPatterns: vi.fn(async () => []),
    injectPatternsIntoEl:  vi.fn(),
}));

import {
    hasLiveResult,
    setLiveResult,
    clearLivePatchState,
    stopPatchObserver,
    clearPendingHighlights,
} from '../engine/live-patch.js';

beforeEach(() => {
    clearLivePatchState();
    vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// hasLiveResult / setLiveResult
// ---------------------------------------------------------------------------

describe('hasLiveResult / setLiveResult', () => {
    it('returns false for an unknown key', () => {
        expect(hasLiveResult('r1:0')).toBe(false);
    });

    it('returns true after setLiveResult is called for that key', () => {
        setLiveResult('r1:0', { keyword: 'dragon', replacement: 'beast', mode: 'replaceKeyword' });
        expect(hasLiveResult('r1:0')).toBe(true);
    });

    it('stores independent results for different keys', () => {
        setLiveResult('r1:0', { keyword: 'x', replacement: 'a', mode: 'replaceKeyword' });
        setLiveResult('r2:0', { keyword: 'y', replacement: 'b', mode: 'replaceKeyword' });
        expect(hasLiveResult('r1:0')).toBe(true);
        expect(hasLiveResult('r2:0')).toBe(true);
    });

    it('overwriting a key keeps it as present', () => {
        setLiveResult('r1:0', { keyword: 'dragon', replacement: 'v1', mode: 'replaceKeyword' });
        setLiveResult('r1:0', { keyword: 'dragon', replacement: 'v2', mode: 'replaceKeyword' });
        expect(hasLiveResult('r1:0')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// clearLivePatchState
// ---------------------------------------------------------------------------

describe('clearLivePatchState', () => {
    it('can be called on clean state without error', () => {
        expect(() => clearLivePatchState()).not.toThrow();
    });

    it('clears all live results', () => {
        setLiveResult('r1:0', { keyword: 'x', replacement: 'y', mode: 'replaceKeyword' });
        clearLivePatchState();
        expect(hasLiveResult('r1:0')).toBe(false);
    });

    it('clears multiple results at once', () => {
        setLiveResult('r1:0', { keyword: 'a', replacement: 'b', mode: 'replaceKeyword' });
        setLiveResult('r2:0', { keyword: 'c', replacement: 'd', mode: 'replaceKeyword' });
        clearLivePatchState();
        expect(hasLiveResult('r1:0')).toBe(false);
        expect(hasLiveResult('r2:0')).toBe(false);
    });

    it('allows new results to be stored after clearing', () => {
        setLiveResult('r1:0', { keyword: 'x', replacement: 'y', mode: 'replaceKeyword' });
        clearLivePatchState();
        setLiveResult('r1:0', { keyword: 'x', replacement: 'z', mode: 'replaceKeyword' });
        expect(hasLiveResult('r1:0')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// stopPatchObserver / clearPendingHighlights
// ---------------------------------------------------------------------------

describe('stopPatchObserver', () => {
    it('can be called when no observer is active without throwing', () => {
        expect(() => stopPatchObserver()).not.toThrow();
    });

    it('can be called multiple times without error', () => {
        stopPatchObserver();
        stopPatchObserver();
    });
});

describe('clearPendingHighlights', () => {
    it('can be called without throwing', () => {
        expect(() => clearPendingHighlights()).not.toThrow();
    });
});
