import { vi, describe, it, expect, beforeEach } from 'vitest';

// dispatch.js uses window.loggeryze?.time() — a no-op outside an active ST turn.
// Node.js has no window, so we stub it.
if (typeof window === 'undefined') global.window = {};

// dispatch.js imports `generateQuietPrompt, name1, name2` from script.js (5 ups from actions/).
// From tests/ (same depth), the same 5-up path resolves identically.
vi.mock('../../../../../script.js', () => ({
    generateQuietPrompt: vi.fn(async () => ({ content: '' })),
    name1: 'User',
    name2: 'Char',
}));

// ConnectionManagerRequestService is from sillytavern/shared.js (3 ups from actions/ = 3 ups from tests/).
vi.mock('../../../shared.js', () => ({
    ConnectionManagerRequestService: {
        sendRequest: vi.fn(async () => null),
    },
}));

vi.mock('../actions/template.js', () => ({
    interpolate:            vi.fn((template) => template),
    resolveHistoryTokens:   vi.fn((template) => template),
}));

vi.mock('../actions/text.js', () => ({
    buildHistoryText:          vi.fn(() => ''),
    extractParagraph:          vi.fn((_text, idx) => ({ text: 'paragraph', start: idx })),
    collectUniqueParagraphs:   vi.fn(() => []),
}));

import {
    isDispatchActive,
    clearPrefetchCache,
    getPrefetchedResults,
    prefetchSideCall,
} from '../actions/dispatch.js';
import { generateQuietPrompt }       from '../../../../../script.js';
import { collectUniqueParagraphs }   from '../actions/text.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ONCE_CONFIG = {
    callMode:   'once',
    outputMode: 'replaceKeyword',
    prompt:     'Describe {{keyword}}',
    profileId:  null,
};

beforeEach(() => {
    clearPrefetchCache();
    vi.clearAllMocks();
    vi.mocked(generateQuietPrompt).mockResolvedValue({ content: 'llm response' });
    vi.mocked(collectUniqueParagraphs).mockReturnValue([]);
});

// ---------------------------------------------------------------------------
// isDispatchActive
// ---------------------------------------------------------------------------

describe('isDispatchActive', () => {
    it('returns false when no dispatch is in flight', () => {
        expect(isDispatchActive()).toBe(false);
    });

    it('returns true while a dispatch promise is pending', () => {
        // Hold the dispatch open with a never-resolving promise
        let release;
        const held = new Promise(r => { release = r; });
        vi.mocked(generateQuietPrompt).mockReturnValue(held);

        prefetchSideCall('r1:0', ONCE_CONFIG, 'dragon', 'A dragon appeared.', null, 0);
        // dispatch() has incremented the counter synchronously before awaiting the promise
        expect(isDispatchActive()).toBe(true);

        // Let it settle so we don't leak the promise across tests
        release({ content: '' });
    });

    it('returns false after the dispatch promise settles', async () => {
        prefetchSideCall('r1:0', ONCE_CONFIG, 'dragon', 'A dragon appeared.', null, 0);
        const [promise] = getPrefetchedResults('r1:0');
        await promise;
        expect(isDispatchActive()).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// clearPrefetchCache / getPrefetchedResults
// ---------------------------------------------------------------------------

describe('clearPrefetchCache', () => {
    it('empties all cached entries', async () => {
        prefetchSideCall('r1:0', ONCE_CONFIG, 'dragon', 'A dragon appeared.', null, 0);
        expect(getPrefetchedResults('r1:0')).not.toBeNull();
        clearPrefetchCache();
        expect(getPrefetchedResults('r1:0')).toBeNull();
    });

    it('can be called on an already-empty cache without error', () => {
        expect(() => clearPrefetchCache()).not.toThrow();
    });
});

describe('getPrefetchedResults', () => {
    it('returns null for a key with no cached entry', () => {
        expect(getPrefetchedResults('nonexistent:0')).toBeNull();
    });

    it('returns the promise array after a prefetch has been registered', () => {
        prefetchSideCall('r1:0', ONCE_CONFIG, 'dragon', 'A dragon appeared.', null, 0);
        const result = getPrefetchedResults('r1:0');
        expect(Array.isArray(result)).toBe(true);
        expect(result).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// prefetchSideCall — once mode
// ---------------------------------------------------------------------------

describe('prefetchSideCall — once mode', () => {
    it('adds a single promise to the cache on the first call', () => {
        prefetchSideCall('r1:0', ONCE_CONFIG, 'dragon', 'A dragon appeared.', null, 0);
        expect(getPrefetchedResults('r1:0')).toHaveLength(1);
    });

    it('does not add a second promise when called again for the same key (dedup)', () => {
        const text = 'A dragon appeared.';
        prefetchSideCall('r1:0', ONCE_CONFIG, 'dragon', text, null, 0);
        prefetchSideCall('r1:0', ONCE_CONFIG, 'dragon', text + ' More text.', null, 0);
        expect(getPrefetchedResults('r1:0')).toHaveLength(1);
    });

    it('fires generateQuietPrompt exactly once', async () => {
        prefetchSideCall('r1:0', ONCE_CONFIG, 'dragon', 'A dragon appeared.', null, 0);
        const [p] = getPrefetchedResults('r1:0');
        await p;
        expect(generateQuietPrompt).toHaveBeenCalledOnce();
    });

    it('the settled promise resolves to the LLM response text', async () => {
        vi.mocked(generateQuietPrompt).mockResolvedValue({ content: 'A fearsome beast.' });
        prefetchSideCall('r1:0', ONCE_CONFIG, 'dragon', 'A dragon appeared.', null, 0);
        const [p] = getPrefetchedResults('r1:0');
        expect(await p).toBe('A fearsome beast.');
    });
});

// ---------------------------------------------------------------------------
// prefetchSideCall — perMatch / replaceParagraph mode
// ---------------------------------------------------------------------------

describe('prefetchSideCall — perMatch replaceKeyword mode', () => {
    const perMatchConfig = { ...ONCE_CONFIG, callMode: 'perMatch', outputMode: 'replaceKeyword' };

    it('adds one promise per keyword instance in the stream text', () => {
        // Two occurrences of "dragon"
        const text = 'A dragon here. Another dragon there.';
        prefetchSideCall('r1:0', perMatchConfig, 'dragon', text, null, 0);
        expect(getPrefetchedResults('r1:0')).toHaveLength(2);
    });

    it('adds more promises as new instances appear on subsequent calls', () => {
        prefetchSideCall('r1:0', perMatchConfig, 'dragon', 'First dragon.', null, 0);
        expect(getPrefetchedResults('r1:0')).toHaveLength(1);

        prefetchSideCall('r1:0', perMatchConfig, 'dragon', 'First dragon. Second dragon.', null, 0);
        expect(getPrefetchedResults('r1:0')).toHaveLength(2);
    });
});

// ---------------------------------------------------------------------------
// prefetchSideCall — silent output mode (no-op)
// ---------------------------------------------------------------------------

describe('prefetchSideCall — silent mode', () => {
    it('does not populate the cache when outputMode is "silent"', () => {
        prefetchSideCall('r1:0', { ...ONCE_CONFIG, outputMode: 'silent' }, 'dragon', 'text', null, 0);
        expect(getPrefetchedResults('r1:0')).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// prefetchSideCall — empty prompt is a no-op
// ---------------------------------------------------------------------------

describe('prefetchSideCall — empty prompt', () => {
    it('does not populate the cache when the interpolated prompt is empty', () => {
        // interpolate returns the template unchanged; empty template → no-op
        prefetchSideCall('r1:0', { ...ONCE_CONFIG, prompt: '' }, 'dragon', 'text', null, 0);
        expect(getPrefetchedResults('r1:0')).toBeNull();
    });
});
