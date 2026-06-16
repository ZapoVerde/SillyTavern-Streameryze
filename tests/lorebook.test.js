import { vi, describe, it, expect, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Shared in-memory lorebook store — write side (update.execute via lbGetLorebook /
// lbSaveLorebook) and read side (getLbEntryByName via getSortedEntries) both talk
// to the same Map so round-trips can be verified without any HTTP.
// ---------------------------------------------------------------------------

const lbStore = vi.hoisted(() => new Map());

// update.js imports lorebookApi.js as '../lorebookApi.js' (one up from actions/).
// From tests/ (same depth as actions/), the same path resolves correctly.
vi.mock('../lorebookApi.js', () => ({
    lbGetLorebook: async (name) => {
        const stored = lbStore.get(name);
        // Return a shallow copy so update.js can mutate it freely before saving.
        return stored
            ? { ...stored, entries: { ...stored.entries } }
            : { entries: {} };
    },
    lbSaveLorebook: async (name, data) => { lbStore.set(name, data); },
}));

// lb-query.js lives in triggers/ and uses 5-up paths. Mirror the factory at both
// specifier depths so either path hits the lbStore-backed mock.
vi.mock('../../../../scripts/world-info.js', () => ({
    getSortedEntries: vi.fn(async () => {
        const result = [];
        for (const [lbName, lbData] of lbStore.entries()) {
            for (const entry of Object.values(lbData.entries ?? {})) {
                result.push({ ...entry, world: lbName });
            }
        }
        return result;
    }),
    parseRegexFromString: vi.fn(() => null),
    world_info_case_sensitive: false,
}));
vi.mock('../../../../../scripts/world-info.js', () => ({
    getSortedEntries: vi.fn(async () => {
        const result = [];
        for (const [lbName, lbData] of lbStore.entries()) {
            for (const entry of Object.values(lbData.entries ?? {})) {
                result.push({ ...entry, world: lbName });
            }
        }
        return result;
    }),
    parseRegexFromString: vi.fn(() => null),
    world_info_case_sensitive: false,
}));

// variables.js — 4-up (triggers.js at project root) and 5-up (condition.js in actions/)
vi.mock('../../../../scripts/variables.js', () => ({
    getLocalVariable:  vi.fn(() => null),
    getGlobalVariable: vi.fn(() => null),
}));
vi.mock('../../../../../scripts/variables.js', () => ({
    getLocalVariable:  vi.fn(() => null),
    getGlobalVariable: vi.fn(() => null),
}));

// update.js imports event infrastructure and character names from script.js (5-up from actions/)
vi.mock('../../../../../script.js', () => ({
    eventSource:        { emit: vi.fn() },
    event_types:        { MESSAGE_UPDATED: 'MESSAGE_UPDATED', WORLDINFO_UPDATED: 'WORLDINFO_UPDATED' },
    name1:              'User',
    name2:              'Char',
    addOneMessage:      vi.fn(),
    updateMessageBlock: vi.fn(),
    getRequestHeaders:  vi.fn(() => ({})),
}));
vi.mock('../../../../../scripts/openai.js', () => ({ oai_settings: { prompts: [] } }));

import { update }                    from '../actions/update.js';
import { getLbEntryByName, clearWiCache } from '../triggers/lb-query.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides = {}) {
    return {
        matchedKeyword:      'dragon',
        messageId:           0,
        stCtx:               { chat: [{ mes: 'A dragon appeared.' }] },
        vars:                {},
        debug:               false,
        highlighted:         '',
        isCurrentGeneration: () => true,
        ...overrides,
    };
}

function lorebookConfig(overrides = {}) {
    return { target: 'lorebook', lorebook: 'testBook', title: '', keys: '', content: '', ...overrides };
}

beforeEach(() => {
    lbStore.clear();
    clearWiCache();
    vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Write → read round-trip
// ---------------------------------------------------------------------------

describe('lorebook write → read round-trip (testBook)', () => {
    it('a newly written entry can be retrieved by name', async () => {
        await update.execute(
            lorebookConfig({ title: 'Elara Voss', content: 'An archivist of ancient lore.' }),
            makeCtx(),
        );

        const entry = await getLbEntryByName('Elara Voss', 'testBook');
        expect(entry).not.toBeNull();
        expect(entry.content).toBe('An archivist of ancient lore.');
    });

    it('an entry is not found before it has been written', async () => {
        expect(await getLbEntryByName('Elara Voss', 'testBook')).toBeNull();
    });

    it('a second write updates the content of an existing entry', async () => {
        await update.execute(lorebookConfig({ title: 'Elara Voss', content: 'Original.' }), makeCtx());
        await update.execute(lorebookConfig({ title: 'Elara Voss', content: 'Revised.' }),  makeCtx());

        const entry = await getLbEntryByName('Elara Voss', 'testBook');
        expect(entry.content).toBe('Revised.');
    });

    it('update creates only one entry (not two) when the title already exists', async () => {
        await update.execute(lorebookConfig({ title: 'Elara Voss', content: 'v1' }), makeCtx());
        await update.execute(lorebookConfig({ title: 'Elara Voss', content: 'v2' }), makeCtx());

        const data = lbStore.get('testBook');
        expect(Object.keys(data.entries)).toHaveLength(1);
    });

    it('title matching on update is case-insensitive', async () => {
        await update.execute(lorebookConfig({ title: 'Elara Voss', content: 'original' }), makeCtx());
        await update.execute(lorebookConfig({ title: 'ELARA VOSS', content: 'updated'  }), makeCtx());

        const data = lbStore.get('testBook');
        expect(Object.keys(data.entries)).toHaveLength(1);
        expect(Object.values(data.entries)[0].content).toBe('updated');
    });

    it('keys are merged on update — existing keys are not duplicated', async () => {
        await update.execute(lorebookConfig({ title: 'Elara Voss', keys: 'elara',           content: 'v1' }), makeCtx());
        await update.execute(lorebookConfig({ title: 'Elara Voss', keys: 'elara, archivist', content: 'v2' }), makeCtx());

        const data  = lbStore.get('testBook');
        const uid   = Object.keys(data.entries).find(k => data.entries[k].comment === 'Elara Voss');
        const keys  = data.entries[uid].key;
        expect(keys).toContain('elara');
        expect(keys).toContain('archivist');
        expect(keys.filter(k => k === 'elara')).toHaveLength(1);
    });

    it('multiple distinct entries can coexist in the same lorebook', async () => {
        await update.execute(lorebookConfig({ title: 'Elara',  content: 'Archivist.' }), makeCtx());
        await update.execute(lorebookConfig({ title: 'Marcus', content: 'Knight.'    }), makeCtx());

        expect(await getLbEntryByName('Elara',  'testBook')).not.toBeNull();
        expect(await getLbEntryByName('Marcus', 'testBook')).not.toBeNull();

        const data = lbStore.get('testBook');
        expect(Object.keys(data.entries)).toHaveLength(2);
    });

    it('each new entry gets a unique uid', async () => {
        await update.execute(lorebookConfig({ title: 'Elara',  content: 'a' }), makeCtx());
        await update.execute(lorebookConfig({ title: 'Marcus', content: 'b' }), makeCtx());

        const data = lbStore.get('testBook');
        const uids = Object.keys(data.entries).map(Number);
        expect(new Set(uids).size).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// Cross-lorebook isolation
// ---------------------------------------------------------------------------

describe('lorebook isolation', () => {
    it('entries in different lorebooks do not cross-contaminate', async () => {
        await update.execute(lorebookConfig({ lorebook: 'testBook',  title: 'Elara', content: 'Book A.' }), makeCtx());
        await update.execute(lorebookConfig({ lorebook: 'otherBook', title: 'Elara', content: 'Book B.' }), makeCtx());

        expect((await getLbEntryByName('Elara', 'testBook' )).content).toBe('Book A.');
        expect((await getLbEntryByName('Elara', 'otherBook')).content).toBe('Book B.');
    });

    it('searching without a lorebook filter returns entries from all lorebooks', async () => {
        await update.execute(lorebookConfig({ lorebook: 'testBook',  title: 'Elara',  content: 'A' }), makeCtx());
        await update.execute(lorebookConfig({ lorebook: 'otherBook', title: 'Marcus', content: 'B' }), makeCtx());

        // No lbName filter — should find entries across all lorebooks
        expect(await getLbEntryByName('Elara' )).not.toBeNull();
        expect(await getLbEntryByName('Marcus')).not.toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Guard clauses
// ---------------------------------------------------------------------------

describe('lorebook guard clauses', () => {
    it('does nothing when lorebook name is empty', async () => {
        await update.execute(lorebookConfig({ lorebook: '', title: 'Elara', content: 'text' }), makeCtx());
        expect(lbStore.size).toBe(0);
    });

    it('does nothing when title is empty', async () => {
        await update.execute(lorebookConfig({ lorebook: 'testBook', title: '', content: 'text' }), makeCtx());
        expect(lbStore.size).toBe(0);
    });
});
