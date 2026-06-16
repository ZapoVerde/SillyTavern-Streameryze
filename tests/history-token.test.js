import { vi, describe, it, expect } from 'vitest';

// Minimal mocks so template.js can import without pulling in ST globals.
vi.mock('../triggers/lb-query.js', () => ({
    getLbEntryByName:     vi.fn(async () => null),
    resolveLbQueryTokens: vi.fn(async t => t),
}));
vi.mock('../triggers/turn-vars.js', () => ({
    getTurnVarsSnapshot: vi.fn(() => ({})),
}));
vi.mock('../../../../../scripts/variables.js', () => ({
    getLocalVariable:  vi.fn(() => null),
    getGlobalVariable: vi.fn(() => null),
}));
vi.mock('../../../../../script.js',         () => ({ itemizedPrompts: [], name1: 'User', name2: 'Char' }));
vi.mock('../../../../../scripts/openai.js', () => ({ oai_settings: { prompts: [] } }));

import { resolveHistoryTokens } from '../actions/template.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChat(...messages) {
    return messages.map(([name, mes]) => ({ name, mes }));
}

// ---------------------------------------------------------------------------
// {{history:[N]}} — literal form
// ---------------------------------------------------------------------------

describe('resolveHistoryTokens — literal {{history:[N]}}', () => {
    const chat = makeChat(
        ['User', 'hello'],
        ['Char', 'hi there'],
        ['User', 'how are you'],
        ['Char', 'great thanks'],
    );

    it('returns the last N turn-pairs before beforeIndex', () => {
        // N is pair-count: N=1 → 2 messages (one user+char pair), N=2 → 4 messages
        const result = resolveHistoryTokens('{{history:[1]}}', chat, 4, {});
        expect(result).toBe('User: how are you\n\nChar: great thanks');
    });

    it('returns fewer turns when N exceeds available history', () => {
        const result = resolveHistoryTokens('{{history:[10]}}', chat, 4, {});
        expect(result).toContain('User: hello');
        expect(result).toContain('Char: great thanks');
    });

    it('returns empty string when N is 0', () => {
        expect(resolveHistoryTokens('{{history:[0]}}', chat, 4, {})).toBe('');
    });

    it('returns empty string when N is negative', () => {
        expect(resolveHistoryTokens('{{history:[-1]}}', chat, 4, {})).toBe('');
    });

    it('returns empty string when beforeIndex is 0 (no prior turns)', () => {
        expect(resolveHistoryTokens('{{history:[2]}}', chat, 0, {})).toBe('');
    });

    it('preserves surrounding text', () => {
        const result = resolveHistoryTokens('Context:\n{{history:[1]}}\nEnd', chat, 4, {});
        expect(result.startsWith('Context:\n')).toBe(true);
        expect(result.endsWith('\nEnd')).toBe(true);
        expect(result).toContain('Char: great thanks');
    });

    it('leaves template unchanged when no {{history:}} present', () => {
        const t = 'no history token here';
        expect(resolveHistoryTokens(t, chat, 4, {})).toBe(t);
    });

    it('resolves multiple history tokens in one template', () => {
        // N=1 pair → "User: how are you\n\nChar: great thanks" (the last pair before index 4)
        const onePair = 'User: how are you\n\nChar: great thanks';
        const result  = resolveHistoryTokens('A:{{history:[1]}} B:{{history:[1]}}', chat, 4, {});
        expect(result).toBe(`A:${onePair} B:${onePair}`);
    });
});

// ---------------------------------------------------------------------------
// {{history:varName}} — turn variable form
// ---------------------------------------------------------------------------

describe('resolveHistoryTokens — variable {{history:varName}}', () => {
    const chat = makeChat(
        ['User', 'msg1'],
        ['Char', 'msg2'],
        ['User', 'msg3'],
        ['Char', 'msg4'],
    );

    it('reads N from a turn variable', () => {
        // N=1 pair → last user+char pair before index 4
        const result = resolveHistoryTokens('{{history:depth}}', chat, 4, { depth: '1' });
        expect(result).toBe('User: msg3\n\nChar: msg4');
    });

    it('returns empty string when variable is unset', () => {
        expect(resolveHistoryTokens('{{history:depth}}', chat, 4, {})).toBe('');
    });

    it('returns empty string when variable resolves to 0', () => {
        expect(resolveHistoryTokens('{{history:depth}}', chat, 4, { depth: '0' })).toBe('');
    });

    it('returns empty string when variable resolves to non-numeric', () => {
        expect(resolveHistoryTokens('{{history:depth}}', chat, 4, { depth: 'many' })).toBe('');
    });

    it('resolves a numeric string like "3" from a variable', () => {
        const result = resolveHistoryTokens('{{history:n}}', chat, 4, { n: '3' });
        expect(result).toContain('Char: msg2');
        expect(result).toContain('User: msg3');
        expect(result).toContain('Char: msg4');
    });
});

// ---------------------------------------------------------------------------
// Edge cases / warnings
// ---------------------------------------------------------------------------

describe('resolveHistoryTokens — edge cases', () => {
    it('logs a warning and returns empty string for bare {{history:}} with no argument', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const result = resolveHistoryTokens('{{history:}}', [], 0, {});
        expect(result).toBe('');
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('{{history:}}'));
        warn.mockRestore();
    });

    it('returns the template unchanged when chat is null', () => {
        expect(resolveHistoryTokens('{{history:[2]}}', null, 4, {})).toBe('');
    });

    it('returns the template unchanged when template is empty', () => {
        expect(resolveHistoryTokens('', [], 0, {})).toBe('');
    });

    it('returns the template unchanged when template is null', () => {
        expect(resolveHistoryTokens(null, [], 0, {})).toBe(null);
    });

    it('bracket syntax takes priority: [2] is literal 2, not variable lookup', () => {
        // Even if a variable named "2" exists, [2] means literal
        const chat = makeChat(['User', 'a'], ['Char', 'b']);
        const result = resolveHistoryTokens('{{history:[2]}}', chat, 2, { '2': '99' });
        expect(result).toBe('User: a\n\nChar: b');
    });
});
