import { vi, describe, it, expect, beforeEach } from 'vitest';

// lb-query.js lives in triggers/ and uses 5-up paths to reach ST scripts.
vi.mock('../../../../../scripts/world-info.js', () => ({
    getSortedEntries:          vi.fn(async () => []),
    loadWorldInfo:             vi.fn(async () => null),
    parseRegexFromString:      vi.fn(() => null),
    world_info_case_sensitive: false,
    world_names:               [],
}));
vi.mock('../../../../scripts/variables.js', () => ({
    getLocalVariable:  vi.fn(() => null),
    getGlobalVariable: vi.fn(() => null),
}));
vi.mock('../../../../../scripts/variables.js', () => ({
    getLocalVariable:  vi.fn(() => null),
    getGlobalVariable: vi.fn(() => null),
}));

import { resolveLbQueryTokens, clearWiCache } from '../triggers/lb-query.js';
import * as WorldInfo                          from '../../../../../scripts/world-info.js';
const { getSortedEntries, loadWorldInfo }      = WorldInfo;

// ---------------------------------------------------------------------------
// Test fixtures
// Order matters — lbContent 'first' and 'last' depend on entry order.
// ---------------------------------------------------------------------------

const CHAR = [
    { comment: 'Elara',  content: 'Senior archivist.',   key: ['elara', 'archivist'], world: 'Characters', disable: false },
    { comment: 'Marcus', content: 'City guard captain.',  key: ['marcus', 'guard'],    world: 'Characters', disable: false },
];
const LORE = [
    { comment: 'Dragon', content: 'A fearsome beast.',   key: ['dragon', 'beast'],    world: 'Lore',       disable: false },
    { comment: 'Magic',  content: 'Arcane knowledge.',   key: ['magic', 'arcane'],    world: 'Lore',       disable: false },
];
const DISABLED = { comment: 'Secret', content: 'Hidden text.', key: ['secret'], world: 'Lore', disable: true };

// Active entries in order: Elara, Marcus, Dragon, Magic — Secret is disabled.
const ALL = [...CHAR, ...LORE, DISABLED];

// Two entries sharing the key 'shared' — exercises deduplication.
const SHARED_KEY = [
    { comment: 'Alpha', content: 'Content Alpha', key: ['shared', 'alpha'], world: 'LB1', disable: false },
    { comment: 'Beta',  content: 'Content Beta',  key: ['shared', 'beta'],  world: 'LB1', disable: false },
];

beforeEach(() => {
    clearWiCache();
    vi.clearAllMocks();
    vi.mocked(getSortedEntries).mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// No-op cases
// ---------------------------------------------------------------------------

describe('resolveLbQueryTokens — no-op cases', () => {
    it('returns empty string unchanged', async () => {
        expect(await resolveLbQueryTokens('', {})).toBe('');
    });

    it('returns template unchanged when there are no {{lb tokens', async () => {
        expect(await resolveLbQueryTokens('hello {{name}}', {})).toBe('hello {{name}}');
    });

    it('does not call getSortedEntries when there are no lb tokens', async () => {
        await resolveLbQueryTokens('no tokens here', {});
        expect(getSortedEntries).not.toHaveBeenCalled();
    });

    it('non-lb {{}} tokens are left in place', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        const result = await resolveLbQueryTokens('{{keyword}} — {{lbTitles:}}', {});
        expect(result).toContain('{{keyword}}');
        expect(result).toContain('Elara');
    });
});

// ---------------------------------------------------------------------------
// {{lbContent}} — content retrieval
// ---------------------------------------------------------------------------

describe('{{lbContent}} — wildcard and mode', () => {
    it('bare token (no colons) returns first active entry content', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        expect(await resolveLbQueryTokens('{{lbContent}}', {})).toBe('Senior archivist.');
    });

    it('explicit first mode matches implicit default', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        expect(await resolveLbQueryTokens('{{lbContent::::first}}', {})).toBe('Senior archivist.');
    });

    it('last mode returns the final active entry content', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        expect(await resolveLbQueryTokens('{{lbContent::::last}}', {})).toBe('Arcane knowledge.');
    });

    it('all mode joins every matching content with a blank line', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        expect(await resolveLbQueryTokens('{{lbContent::::all}}', {})).toBe(
            'Senior archivist.\n\nCity guard captain.\n\nA fearsome beast.\n\nArcane knowledge.',
        );
    });

    it('disabled entries are never returned', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        expect(await resolveLbQueryTokens('{{lbContent::[Secret]}}', {})).toBe('');
    });

    it('no active matching entry returns empty string', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        expect(await resolveLbQueryTokens('{{lbContent::[NoSuchEntry]}}', {})).toBe('');
    });
});

describe('{{lbContent}} — filter positions', () => {
    it('position 0 (lorebook name) filters by world', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        expect(await resolveLbQueryTokens('{{lbContent:[Characters]}}', {})).toBe('Senior archivist.');
        expect(await resolveLbQueryTokens('{{lbContent:[Lore]}}',       {})).toBe('A fearsome beast.');
    });

    it('position 1 (title) filters by entry comment', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        expect(await resolveLbQueryTokens('{{lbContent::[Dragon]}}',  {})).toBe('A fearsome beast.');
        expect(await resolveLbQueryTokens('{{lbContent::[Marcus]}}',  {})).toBe('City guard captain.');
    });

    it('position 2 (key) filters by activation key', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        expect(await resolveLbQueryTokens('{{lbContent:::[archivist]}}', {})).toBe('Senior archivist.');
        expect(await resolveLbQueryTokens('{{lbContent:::[beast]}}',     {})).toBe('A fearsome beast.');
    });

    it('combining lorebook + key filter narrows results', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        // Characters lorebook, entry with key 'guard' → Marcus
        expect(await resolveLbQueryTokens('{{lbContent:[Characters]::[guard]}}', {})).toBe('City guard captain.');
    });

    it('lorebook filter returning no results yields empty string', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        expect(await resolveLbQueryTokens('{{lbContent:[NonExistentLB]}}', {})).toBe('');
    });
});

describe('{{lbContent}} — literal list filters', () => {
    it('[A,B] in title position matches entries with either title — first mode returns first match', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        expect(await resolveLbQueryTokens('{{lbContent::[Dragon,Magic]}}', {})).toBe('A fearsome beast.');
    });

    it('[A,B] in title position with all mode returns all matches', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        expect(await resolveLbQueryTokens('{{lbContent::[Dragon,Magic]::all}}', {}))
            .toBe('A fearsome beast.\n\nArcane knowledge.');
    });

    it('[A,B] in key position matches entries that have any of the listed keys', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        // 'archivist' key → Elara; 'beast' key → Dragon; first mode → Elara
        expect(await resolveLbQueryTokens('{{lbContent:::[archivist,beast]}}', {})).toBe('Senior archivist.');
    });

    it('[A,B] in lb position matches entries from any of the listed lorebooks', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        // Both lorebooks → all 4 active entries; last mode → Magic
        expect(await resolveLbQueryTokens('{{lbContent:[Characters,Lore]:::last}}', {})).toBe('Arcane knowledge.');
    });
});

// ---------------------------------------------------------------------------
// {{lbTitles}} — entry title lists
// ---------------------------------------------------------------------------

describe('{{lbTitles}} — title retrieval', () => {
    it('bare token returns all active entry titles comma-separated', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        expect(await resolveLbQueryTokens('{{lbTitles}}', {})).toBe('Elara, Marcus, Dragon, Magic');
    });

    it('first mode returns only the first title', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        expect(await resolveLbQueryTokens('{{lbTitles::::first}}', {})).toBe('Elara');
    });

    it('last mode returns only the final title', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        expect(await resolveLbQueryTokens('{{lbTitles::::last}}', {})).toBe('Magic');
    });

    it('lorebook filter limits results to that lorebook', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        expect(await resolveLbQueryTokens('{{lbTitles:[Characters]}}', {})).toBe('Elara, Marcus');
        expect(await resolveLbQueryTokens('{{lbTitles:[Lore]}}',       {})).toBe('Dragon, Magic');
    });

    it('key filter limits to entries possessing that activation key', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        expect(await resolveLbQueryTokens('{{lbTitles:::[guard]}}', {})).toBe('Marcus');
    });

    it('disabled entries are excluded from titles', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        const result = await resolveLbQueryTokens('{{lbTitles}}', {});
        expect(result).not.toContain('Secret');
    });

    it('no matching entries returns empty string', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        expect(await resolveLbQueryTokens('{{lbTitles:[GhostLB]}}', {})).toBe('');
    });
});

// ---------------------------------------------------------------------------
// {{lbKeys}} — activation key lists
// ---------------------------------------------------------------------------

describe('{{lbKeys}} — activation key retrieval', () => {
    it('bare token returns all unique keys across all active entries', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        expect(await resolveLbQueryTokens('{{lbKeys}}', {}))
            .toBe('elara, archivist, marcus, guard, dragon, beast, magic, arcane');
    });

    it('deduplicates keys that appear in multiple entries', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(SHARED_KEY);
        // Alpha and Beta both have 'shared' — it should appear only once
        const result = await resolveLbQueryTokens('{{lbKeys}}', {});
        const keys = result.split(', ');
        expect(keys.filter(k => k === 'shared')).toHaveLength(1);
        expect(keys).toContain('alpha');
        expect(keys).toContain('beta');
    });

    it('first mode returns only the first key overall', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        expect(await resolveLbQueryTokens('{{lbKeys::::first}}', {})).toBe('elara');
    });

    it('last mode returns only the final key overall', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        expect(await resolveLbQueryTokens('{{lbKeys::::last}}', {})).toBe('arcane');
    });

    it('lorebook filter limits keys to that lorebook\'s entries', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        expect(await resolveLbQueryTokens('{{lbKeys:[Characters]}}', {})).toBe('elara, archivist, marcus, guard');
        expect(await resolveLbQueryTokens('{{lbKeys:[Lore]}}',       {})).toBe('dragon, beast, magic, arcane');
    });

    it('disabled entries do not contribute keys', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        const result = await resolveLbQueryTokens('{{lbKeys}}', {});
        expect(result).not.toContain('secret');
    });
});

// ---------------------------------------------------------------------------
// {{lbBooks}} — lorebook name lists
// ---------------------------------------------------------------------------

describe('{{lbBooks}} — lorebook name retrieval', () => {
    it('bare token returns all distinct lorebook names of active entries', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        expect(await resolveLbQueryTokens('{{lbBooks}}', {})).toBe('Characters, Lore');
    });

    it('deduplicates lorebook names when multiple entries share the same world', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        // Characters and Lore each have two entries — both should appear exactly once
        const result = await resolveLbQueryTokens('{{lbBooks}}', {});
        const books = result.split(', ');
        expect(books.filter(b => b === 'Characters')).toHaveLength(1);
        expect(books.filter(b => b === 'Lore')).toHaveLength(1);
    });

    it('first mode returns only the first distinct lorebook name', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        expect(await resolveLbQueryTokens('{{lbBooks::::first}}', {})).toBe('Characters');
    });

    it('last mode returns only the final distinct lorebook name', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        expect(await resolveLbQueryTokens('{{lbBooks::::last}}', {})).toBe('Lore');
    });

    it('key filter returns only lorebooks containing an entry with that key', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        expect(await resolveLbQueryTokens('{{lbBooks:::[guard]}}',  {})).toBe('Characters');
        expect(await resolveLbQueryTokens('{{lbBooks:::[dragon]}}', {})).toBe('Lore');
    });

    it('title filter returns only lorebooks containing an entry with that title', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        expect(await resolveLbQueryTokens('{{lbBooks::[Elara]}}',  {})).toBe('Characters');
        expect(await resolveLbQueryTokens('{{lbBooks::[Dragon]}}', {})).toBe('Lore');
    });

    it('disabled entries do not contribute their lorebook name', async () => {
        // Only entry in 'SecretLore' is disabled — that lorebook should not appear.
        const entries = [
            ...CHAR,
            { comment: 'Hidden', content: 'x', key: ['h'], world: 'SecretLore', disable: true },
        ];
        vi.mocked(getSortedEntries).mockResolvedValue(entries);
        const result = await resolveLbQueryTokens('{{lbBooks}}', {});
        expect(result).not.toContain('SecretLore');
    });

    it('no matching active entries returns empty string', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        expect(await resolveLbQueryTokens('{{lbBooks:::[nosuchkey]}}', {})).toBe('');
    });
});

// ---------------------------------------------------------------------------
// Variable substitution in filter args
// A bare word in a filter position resolves from the vars snapshot at runtime.
// ---------------------------------------------------------------------------

describe('variable substitution in filter args', () => {
    it('bare word in lb position resolves to a lorebook name from vars', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        // {{lbContent:myLb}} — 'myLb' is a var name, resolved to 'Characters'
        expect(await resolveLbQueryTokens('{{lbContent:myLb}}', { myLb: 'Characters' }))
            .toBe('Senior archivist.');
    });

    it('bare word in title position resolves to an entry title from vars', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        expect(await resolveLbQueryTokens('{{lbContent::titleVar}}', { titleVar: 'Dragon' }))
            .toBe('A fearsome beast.');
    });

    it('bare word in key position resolves to an activation key from vars', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        expect(await resolveLbQueryTokens('{{lbContent:::keyVar}}', { keyVar: 'guard' }))
            .toBe('City guard captain.');
    });

    it('a var resolving to a comma-separated list filters against multiple values', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        // myLb resolves to 'Characters,Lore' → both lorebooks match
        const result = await resolveLbQueryTokens('{{lbTitles:myLb}}', { myLb: 'Characters,Lore' });
        expect(result).toBe('Elara, Marcus, Dragon, Magic');
    });

    it('unresolved var (not in snapshot) produces no results — match nothing, not wildcard', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        // 'myLb' not in vars → _resolveArg returns [] → _filterMatches([], x) → false
        expect(await resolveLbQueryTokens('{{lbContent:myLb}}', {})).toBe('');
    });

    it('var with empty string value behaves the same as unresolved — match nothing', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        expect(await resolveLbQueryTokens('{{lbContent:myLb}}', { myLb: '' })).toBe('');
    });

    it('literal [bracket] in filter is treated as a literal value, not a var name', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        // [Dragon] is parsed as literal list ['Dragon'], not looked up in vars
        expect(await resolveLbQueryTokens('{{lbContent::[Dragon]}}', {})).toBe('A fearsome beast.');
    });
});

// ---------------------------------------------------------------------------
// Multiple tokens and positioning in templates
// ---------------------------------------------------------------------------

describe('multiple tokens in one template', () => {
    it('two different token types resolve independently', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        const result = await resolveLbQueryTokens(
            'Books: {{lbBooks}} | First: {{lbContent::::first}}',
            {},
        );
        expect(result).toBe('Books: Characters, Lore | First: Senior archivist.');
    });

    it('two lbContent tokens with different filters both resolve', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        const result = await resolveLbQueryTokens(
            '{{lbContent::[Elara]}} — {{lbContent::[Dragon]}}',
            {},
        );
        expect(result).toBe('Senior archivist. — A fearsome beast.');
    });

    it('token surrounded by text — surrounding text is preserved exactly', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        const result = await resolveLbQueryTokens(
            'Lorebooks available: {{lbBooks}}. Use them wisely.',
            {},
        );
        expect(result).toBe('Lorebooks available: Characters, Lore. Use them wisely.');
    });

    it('unresolved token (no entries) leaves empty string in place', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        const result = await resolveLbQueryTokens(
            'prefix {{lbContent::[Ghost]}} suffix',
            {},
        );
        expect(result).toBe('prefix  suffix');
    });
});

// ---------------------------------------------------------------------------
// Cache behaviour
// ---------------------------------------------------------------------------

describe('entry cache', () => {
    it('calls getSortedEntries once even when the template contains multiple lb tokens', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        await resolveLbQueryTokens('{{lbBooks}} {{lbTitles}} {{lbKeys}}', {});
        expect(getSortedEntries).toHaveBeenCalledTimes(1);
    });

    it('clears the cache between calls when clearWiCache is invoked', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(ALL);
        await resolveLbQueryTokens('{{lbBooks}}', {});
        clearWiCache();
        await resolveLbQueryTokens('{{lbBooks}}', {});
        expect(getSortedEntries).toHaveBeenCalledTimes(2);
    });
});

// ---------------------------------------------------------------------------
// Scope argument — active / all / inactive
// ---------------------------------------------------------------------------

// Fixtures: Characters is active, Hidden is inactive (on disk but not in WI slots)
const INACTIVE = [
    { comment: 'Villain', content: 'The antagonist.', key: ['villain'], world: 'Hidden', disable: false },
    { comment: 'Minion',  content: 'Lackey.',          key: ['minion'],  world: 'Hidden', disable: false },
];

function _toEntries(arr) {
    return Object.fromEntries(arr.map((e, i) => [String(i), e]));
}

describe('scope: all — loads from all world_names', () => {
    beforeEach(() => {
        // Active: Characters lorebook
        vi.mocked(getSortedEntries).mockResolvedValue(CHAR);
        // On disk: Characters + Hidden
        WorldInfo.world_names = ['Characters', 'Hidden'];
        vi.mocked(loadWorldInfo).mockImplementation(async name => {
            if (name === 'Characters') return { entries: _toEntries(CHAR) };
            if (name === 'Hidden')     return { entries: _toEntries(INACTIVE) };
            return null;
        });
    });

    it('returns titles from both active and inactive lorebooks', async () => {
        const r = await resolveLbQueryTokens('{{lbTitles:::::all}}', {});
        expect(r).toContain('Elara');
        expect(r).toContain('Villain');
    });

    it('can filter to a specific inactive lorebook by name (bracket literal)', async () => {
        const r = await resolveLbQueryTokens('{{lbTitles:[Hidden]::::all}}', {});
        expect(r).toContain('Villain');
        expect(r).not.toContain('Elara');
    });

    it('returns keys from all lorebooks', async () => {
        const r = await resolveLbQueryTokens('{{lbKeys:::::all}}', {});
        expect(r).toContain('elara');
        expect(r).toContain('villain');
    });

    it('calls loadWorldInfo for each entry in world_names', async () => {
        await resolveLbQueryTokens('{{lbBooks:::::all}}', {});
        expect(loadWorldInfo).toHaveBeenCalledWith('Characters');
        expect(loadWorldInfo).toHaveBeenCalledWith('Hidden');
    });

    it('handles a loadWorldInfo returning null without throwing', async () => {
        WorldInfo.world_names = ['Characters', 'Broken'];
        vi.mocked(loadWorldInfo).mockImplementation(async name =>
            name === 'Characters' ? { entries: _toEntries(CHAR) } : null,
        );
        const r = await resolveLbQueryTokens('{{lbTitles:::::all}}', {});
        expect(r).toContain('Elara');
    });
});

describe('scope: inactive — only lorebooks not in active set', () => {
    beforeEach(() => {
        vi.mocked(getSortedEntries).mockResolvedValue(CHAR);
        WorldInfo.world_names = ['Characters', 'Hidden'];
        vi.mocked(loadWorldInfo).mockImplementation(async name => {
            if (name === 'Characters') return { entries: _toEntries(CHAR) };
            if (name === 'Hidden')     return { entries: _toEntries(INACTIVE) };
            return null;
        });
    });

    it('excludes active lorebook entries', async () => {
        const r = await resolveLbQueryTokens('{{lbTitles:::::inactive}}', {});
        expect(r).not.toContain('Elara');
        expect(r).not.toContain('Marcus');
    });

    it('includes entries from lorebooks not in the active set', async () => {
        const r = await resolveLbQueryTokens('{{lbTitles:::::inactive}}', {});
        expect(r).toContain('Villain');
        expect(r).toContain('Minion');
    });

    it('returns keys from inactive lorebooks only', async () => {
        const r = await resolveLbQueryTokens('{{lbKeys:::::inactive}}', {});
        expect(r).toContain('villain');
        expect(r).not.toContain('elara');
    });
});

describe('scope: active (default) — unchanged behaviour', () => {
    it('explicit active scope behaves the same as no scope', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(CHAR);
        const withScope    = await resolveLbQueryTokens('{{lbTitles:::::active}}', {});
        clearWiCache();
        const withoutScope = await resolveLbQueryTokens('{{lbTitles}}', {});
        expect(withScope).toBe(withoutScope);
    });

    it('does not call loadWorldInfo for active scope', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue(CHAR);
        await resolveLbQueryTokens('{{lbTitles}}', {});
        expect(loadWorldInfo).not.toHaveBeenCalled();
    });
});
