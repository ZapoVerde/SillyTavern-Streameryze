import { vi, describe, it, expect, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// In-memory variable stores — both write side (set-stvar) and read side
// (template interpolation) share the same Map so round-trips work correctly.
// vi.hoisted() ensures the stores exist when the mock factories below run.
// ---------------------------------------------------------------------------

const { localStore, globalStore } = vi.hoisted(() => ({
    localStore:  new Map(),
    globalStore: new Map(),
}));

// set-stvar.js and condition.js are both in actions/ (5-up path to variables.js).
// template.js is also in actions/ — same 5-up path applies.
vi.mock('../../../../../scripts/variables.js', () => ({
    getLocalVariable:  (name, opts = {}) => {
        const key = opts.index !== undefined ? `${name}[${opts.index}]` : name;
        return localStore.get(key) ?? null;
    },
    getGlobalVariable: (name, opts = {}) => {
        const key = opts.index !== undefined ? `${name}[${opts.index}]` : name;
        return globalStore.get(key) ?? null;
    },
    setLocalVariable:  (name, value, opts = {}) => {
        const key = opts.index !== undefined ? `${name}[${opts.index}]` : name;
        localStore.set(key, value);
    },
    setGlobalVariable: (name, value, opts = {}) => {
        const key = opts.index !== undefined ? `${name}[${opts.index}]` : name;
        globalStore.set(key, value);
    },
}));

vi.mock('../../../../../script.js',         () => ({ name1: 'User', name2: 'Char' }));
vi.mock('../../../../../scripts/openai.js', () => ({ oai_settings: { prompts: [] } }));

// triggers.js is at the project root — mock it so its world-info import is never attempted.
vi.mock('../triggers.js', () => ({
    getLbEntryByName:     vi.fn(async () => null),
    resolveLbQueryTokens: vi.fn(async t => t),
    getTurnVarsSnapshot:  vi.fn(() => ({})),
}));

import { setStVar }   from '../actions/set-stvar.js';
import { interpolate } from '../actions/template.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides = {}) {
    return {
        matchedKeyword: 'dragon',
        messageId:      0,
        stCtx:          { chat: [{ mes: 'A dragon appeared.' }] },
        vars:           {},
        debug:          false,
        highlighted:    '',
        ...overrides,
    };
}

beforeEach(() => {
    localStore.clear();
    globalStore.clear();
    vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Local (chat) variable — write then read
// ---------------------------------------------------------------------------

describe('local (chat) variable', () => {
    it('execute writes the value to the local store', async () => {
        await setStVar.execute(
            { scope: 'chat', varName: 'hp', key: '', value: '100' },
            makeCtx(),
        );
        expect(localStore.get('hp')).toBe('100');
    });

    it('reading back via {{chatvar::name}} returns the written value', async () => {
        await setStVar.execute(
            { scope: 'chat', varName: 'hp', key: '', value: '100' },
            makeCtx(),
        );
        expect(interpolate('{{chatvar::hp}}', {})).toBe('100');
    });

    it('round-trip: write with {{keyword}} template, read back the resolved value', async () => {
        await setStVar.execute(
            { scope: 'chat', varName: 'lastMatch', key: '', value: '{{keyword}} appeared' },
            makeCtx({ matchedKeyword: 'dragon' }),
        );
        expect(interpolate('seen: {{chatvar::lastMatch}}', {})).toBe('seen: dragon appeared');
    });

    it('does nothing when varName is empty', async () => {
        await setStVar.execute(
            { scope: 'chat', varName: '', key: '', value: 'oops' },
            makeCtx(),
        );
        expect(localStore.size).toBe(0);
    });

    it('reading an unwritten variable returns empty string', () => {
        expect(interpolate('{{chatvar::missing}}', {})).toBe('');
    });

    it('overwrites an existing value on a second write', async () => {
        await setStVar.execute(
            { scope: 'chat', varName: 'hp', key: '', value: '100' },
            makeCtx(),
        );
        await setStVar.execute(
            { scope: 'chat', varName: 'hp', key: '', value: '50' },
            makeCtx(),
        );
        expect(interpolate('{{chatvar::hp}}', {})).toBe('50');
    });

    it('writes to a sub-key when key is set', async () => {
        await setStVar.execute(
            { scope: 'chat', varName: 'stats', key: 'hp', value: '80' },
            makeCtx(),
        );
        expect(localStore.get('stats[hp]')).toBe('80');
    });

    it('reading back a sub-key via dot notation works', async () => {
        await setStVar.execute(
            { scope: 'chat', varName: 'stats', key: 'hp', value: '80' },
            makeCtx(),
        );
        expect(interpolate('{{chatvar::stats.hp}}', {})).toBe('80');
    });

    it('reading back a sub-key via bracket notation returns the same value as dot notation', async () => {
        await setStVar.execute(
            { scope: 'chat', varName: 'stats', key: 'hp', value: '80' },
            makeCtx(),
        );
        expect(interpolate('{{chatvar::stats[hp]}}', {})).toBe('80');
    });

    it('numeric index round-trip — write index 0, read back with [0]', async () => {
        await setStVar.execute(
            { scope: 'chat', varName: 'inventory', key: '0', value: 'sword' },
            makeCtx(),
        );
        expect(interpolate('{{chatvar::inventory[0]}}', {})).toBe('sword');
    });

    it('multiple keys under the same variable name are independent', async () => {
        await setStVar.execute({ scope: 'chat', varName: 'stats', key: 'hp',       value: '80'  }, makeCtx());
        await setStVar.execute({ scope: 'chat', varName: 'stats', key: 'strength', value: '15'  }, makeCtx());
        await setStVar.execute({ scope: 'chat', varName: 'stats', key: 'gold',     value: '250' }, makeCtx());
        expect(interpolate('{{chatvar::stats.hp}}',       {})).toBe('80');
        expect(interpolate('{{chatvar::stats.strength}}', {})).toBe('15');
        expect(interpolate('{{chatvar::stats.gold}}',     {})).toBe('250');
    });

    it('reading a missing sub-key from a variable that has other keys returns empty string', async () => {
        await setStVar.execute(
            { scope: 'chat', varName: 'stats', key: 'hp', value: '80' },
            makeCtx(),
        );
        expect(interpolate('{{chatvar::stats.missing}}', {})).toBe('');
    });

    it('does not touch the global store', async () => {
        await setStVar.execute(
            { scope: 'chat', varName: 'hp', key: '', value: '100' },
            makeCtx(),
        );
        expect(globalStore.size).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Global variable — write then read
// ---------------------------------------------------------------------------

describe('global variable', () => {
    it('execute writes the value to the global store', async () => {
        await setStVar.execute(
            { scope: 'global', varName: 'score', key: '', value: '9999' },
            makeCtx(),
        );
        expect(globalStore.get('score')).toBe('9999');
    });

    it('reading back via {{globalvar::name}} returns the written value', async () => {
        await setStVar.execute(
            { scope: 'global', varName: 'score', key: '', value: '9999' },
            makeCtx(),
        );
        expect(interpolate('{{globalvar::score}}', {})).toBe('9999');
    });

    it('round-trip: write with {{keyword}} template, read back', async () => {
        await setStVar.execute(
            { scope: 'global', varName: 'theme', key: '', value: '{{keyword}} mode' },
            makeCtx({ matchedKeyword: 'dark' }),
        );
        expect(interpolate('theme: {{globalvar::theme}}', {})).toBe('theme: dark mode');
    });

    it('reading an unwritten global variable returns empty string', () => {
        expect(interpolate('{{globalvar::missing}}', {})).toBe('');
    });

    it('does not touch the local store', async () => {
        await setStVar.execute(
            { scope: 'global', varName: 'score', key: '', value: '9999' },
            makeCtx(),
        );
        expect(localStore.size).toBe(0);
    });

    it('writes to a sub-key when key is set', async () => {
        await setStVar.execute(
            { scope: 'global', varName: 'config', key: 'volume', value: '75' },
            makeCtx(),
        );
        expect(globalStore.get('config[volume]')).toBe('75');
    });

    it('reading back a sub-key via dot notation works', async () => {
        await setStVar.execute(
            { scope: 'global', varName: 'config', key: 'volume', value: '75' },
            makeCtx(),
        );
        expect(interpolate('{{globalvar::config.volume}}', {})).toBe('75');
    });

    it('reading back a sub-key via bracket notation returns the same value as dot notation', async () => {
        await setStVar.execute(
            { scope: 'global', varName: 'config', key: 'volume', value: '75' },
            makeCtx(),
        );
        expect(interpolate('{{globalvar::config[volume]}}', {})).toBe('75');
    });

    it('numeric index round-trip — write index 0, read back with [0]', async () => {
        await setStVar.execute(
            { scope: 'global', varName: 'queue', key: '0', value: 'first' },
            makeCtx(),
        );
        expect(interpolate('{{globalvar::queue[0]}}', {})).toBe('first');
    });

    it('local and global stores are independent — writing to one does not affect the other', async () => {
        await setStVar.execute(
            { scope: 'chat',   varName: 'x', key: '', value: 'local' },
            makeCtx(),
        );
        await setStVar.execute(
            { scope: 'global', varName: 'x', key: '', value: 'global' },
            makeCtx(),
        );
        expect(interpolate('{{chatvar::x}}',   {})).toBe('local');
        expect(interpolate('{{globalvar::x}}', {})).toBe('global');
    });
});

// ---------------------------------------------------------------------------
// preview()
// ---------------------------------------------------------------------------

describe('setStVar — preview', () => {
    it('returns a hint when varName is empty', async () => {
        const result = await setStVar.preview({ scope: 'chat', varName: '', key: '', value: 'x' }, 'some text');
        expect(result.hint).toBeTruthy();
    });

    it('resolves the value against the given text without writing to either store', async () => {
        const result = await setStVar.preview({ scope: 'chat', varName: 'hp', key: '', value: '{{message}}' }, 'A dragon appeared.');
        expect(result.output).toBe('Would set chat var hp =\nA dragon appeared.');
        expect(localStore.size).toBe(0);
        expect(globalStore.size).toBe(0);
    });

    it('includes the key in the preview label when set', async () => {
        const result = await setStVar.preview({ scope: 'global', varName: 'config', key: 'volume', value: '75' }, 'text');
        expect(result.output).toBe('Would set global var config[volume] =\n75');
        expect(globalStore.size).toBe(0);
    });
});
