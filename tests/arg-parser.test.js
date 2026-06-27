import { describe, it, expect } from 'vitest';

import {
    parseArg,
    resolveArg,
    resolveScalar,
    globTest,
    filterMatchesSingle,
    filterMatchesArray,
} from '../arg-parser.js';

// ---------------------------------------------------------------------------
// parseArg
// ---------------------------------------------------------------------------

describe('parseArg — null / wildcard', () => {
    it('empty string  → null', () => expect(parseArg('')).toBeNull());
    it('whitespace    → null', () => expect(parseArg('   ')).toBeNull());
    it('null          → null', () => expect(parseArg(null)).toBeNull());
    it('undefined     → null', () => expect(parseArg(undefined)).toBeNull());
});

describe('parseArg — bare literals (OR)', () => {
    it('single literal', () => {
        expect(parseArg('Dragon')).toEqual({ type: 'OR', items: [{ negate: false, kind: 'literal', value: 'Dragon' }] });
    });
    it('comma-separated literals become OR items', () => {
        expect(parseArg('Dragon, Magic')).toEqual({
            type: 'OR',
            items: [
                { negate: false, kind: 'literal', value: 'Dragon' },
                { negate: false, kind: 'literal', value: 'Magic' },
            ],
        });
    });
    it('trims whitespace around items', () => {
        const r = parseArg('  Dragon  ,  Magic  ');
        expect(r.items.map(i => i.value)).toEqual(['Dragon', 'Magic']);
    });
});

describe('parseArg — quoted literals', () => {
    it('double-quoted value protects inner comma', () => {
        expect(parseArg('"Dragon, the great"')).toEqual({
            type: 'OR',
            items: [{ negate: false, kind: 'literal', value: 'Dragon, the great' }],
        });
    });
    it('single-quoted value protects inner comma', () => {
        expect(parseArg("'Dragon, the great'")).toEqual({
            type: 'OR',
            items: [{ negate: false, kind: 'literal', value: 'Dragon, the great' }],
        });
    });
    it('quoted and unquoted mixed', () => {
        const r = parseArg('"Dragon, beast", Magic');
        expect(r.items.map(i => i.value)).toEqual(['Dragon, beast', 'Magic']);
    });
});

describe('parseArg — ! negation', () => {
    it('!literal sets negate=true', () => {
        expect(parseArg('!Dragon')).toEqual({
            type: 'OR',
            items: [{ negate: true, kind: 'literal', value: 'Dragon' }],
        });
    });
    it('mixed include and exclude', () => {
        const r = parseArg('Magic, !Dragon');
        expect(r.items).toEqual([
            { negate: false, kind: 'literal', value: 'Magic' },
            { negate: true,  kind: 'literal', value: 'Dragon' },
        ]);
    });
    it('only exclusions', () => {
        const r = parseArg('!Dragon, !Beast');
        expect(r.items.every(i => i.negate)).toBe(true);
    });
});

describe('parseArg — {{var}} references', () => {
    it('bare var ref', () => {
        expect(parseArg('{{myVar}}')).toEqual({
            type: 'OR',
            items: [{ negate: false, kind: 'var', value: 'myVar' }],
        });
    });
    it('negated var ref', () => {
        expect(parseArg('!{{myVar}}')).toEqual({
            type: 'OR',
            items: [{ negate: true, kind: 'var', value: 'myVar' }],
        });
    });
    it('var ref mixed with literal', () => {
        const r = parseArg('{{myVar}}, Dragon');
        expect(r.items).toEqual([
            { negate: false, kind: 'var',     value: 'myVar'  },
            { negate: false, kind: 'literal', value: 'Dragon' },
        ]);
    });
    it('trims var name whitespace', () => {
        const r = parseArg('{{ myVar }}');
        expect(r.items[0]).toEqual({ negate: false, kind: 'var', value: 'myVar' });
    });
});

describe('parseArg — explicit OR(...)', () => {
    it('OR(a, b) is identical to bare comma list', () => {
        const explicit = parseArg('OR(Dragon, Magic)');
        const implicit = parseArg('Dragon, Magic');
        expect(explicit).toEqual(implicit);
    });
    it('OR(...) with quotes inside', () => {
        const r = parseArg('OR("Dragon, beast", Magic)');
        expect(r.items.map(i => i.value)).toEqual(['Dragon, beast', 'Magic']);
    });
});

describe('parseArg — AND(...)', () => {
    it('AND(a, b) sets type AND', () => {
        expect(parseArg('AND(sword, magic)')).toEqual({
            type: 'AND',
            items: [
                { negate: false, kind: 'literal', value: 'sword' },
                { negate: false, kind: 'literal', value: 'magic' },
            ],
        });
    });
    it('AND with negation', () => {
        const r = parseArg('AND(sword, !fire)');
        expect(r).toEqual({
            type: 'AND',
            items: [
                { negate: false, kind: 'literal', value: 'sword' },
                { negate: true,  kind: 'literal', value: 'fire'  },
            ],
        });
    });
    it('AND with quoted item', () => {
        const r = parseArg('AND("sword, blade", magic)');
        expect(r.items[0].value).toBe('sword, blade');
        expect(r.items[1].value).toBe('magic');
    });
    it('AND with var ref', () => {
        const r = parseArg('AND({{myVar}}, magic)');
        expect(r.items[0]).toEqual({ negate: false, kind: 'var', value: 'myVar' });
    });
    it('case-insensitive combinator keyword', () => {
        expect(parseArg('and(a, b)').type).toBe('AND');
        expect(parseArg('And(a, b)').type).toBe('AND');
    });
    it('AND(a, b) !c — text after closing paren is not valid AND syntax; degrades to OR', () => {
        // !parent sits outside the parens so the combinator regex fails to match.
        // The whole string is parsed as OR, not AND.
        const r = parseArg('AND(chat123, location) !parent');
        expect(r.type).toBe('OR');
    });
    it('AND(a, b, c) !d — with three args the middle item "location" splits cleanly as a plain OR inclusion', () => {
        // Three comma args: 'AND(chat123' / 'location' / 'Tavern) !parent'.
        // The middle token 'location' is a verbatim positive OR item — any entry
        // with that key passes the filter, causing all location entries to match.
        const r = parseArg('AND(chat123, location, Tavern) !parent');
        expect(r.items.some(i => !i.negate && i.value === 'location')).toBe(true);
    });
    it('negation must be inside AND() — AND(a, b, !c) is the correct form', () => {
        const r = parseArg('AND(chat123, location, !parent)');
        expect(r.type).toBe('AND');
        const neg = r.items.find(i => i.value === 'parent');
        expect(neg?.negate).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// resolveArg
// ---------------------------------------------------------------------------

describe('resolveArg — pass-through cases', () => {
    it('null → null', () => expect(resolveArg(null, {})).toBeNull());

    it('literal items are preserved', () => {
        const parsed = parseArg('Dragon');
        const r = resolveArg(parsed, {});
        expect(r).toEqual({ type: 'OR', items: [{ negate: false, value: 'Dragon' }] });
    });

    it('negation is preserved on literals', () => {
        const parsed = parseArg('!Dragon');
        const r = resolveArg(parsed, {});
        expect(r.items[0]).toEqual({ negate: true, value: 'Dragon' });
    });
});

describe('resolveArg — variable expansion', () => {
    it('var in OR context is comma-split', () => {
        const parsed = parseArg('{{tags}}');
        const r = resolveArg(parsed, { tags: 'dragon, beast' });
        expect(r.items.map(i => i.value)).toEqual(['dragon', 'beast']);
        expect(r.items.every(i => !i.negate)).toBe(true);
    });

    it('var in AND context is treated as atomic', () => {
        const parsed = parseArg('AND({{tag}}, magic)');
        const r = resolveArg(parsed, { tag: 'dragon, beast' });
        expect(r.items[0].value).toBe('dragon, beast');
    });

    it('unresolved var contributes no items', () => {
        const parsed = parseArg('{{missing}}, Dragon');
        const r = resolveArg(parsed, {});
        expect(r.items).toEqual([{ negate: false, value: 'Dragon' }]);
    });

    it('empty var value contributes no items', () => {
        const parsed = parseArg('{{empty}}');
        const r = resolveArg(parsed, { empty: '' });
        expect(r.items).toEqual([]);
    });

    it('negated var in OR context: negate flag propagates to each split value', () => {
        const parsed = parseArg('!{{tags}}');
        const r = resolveArg(parsed, { tags: 'dragon, beast' });
        expect(r.items).toEqual([
            { negate: true, value: 'dragon' },
            { negate: true, value: 'beast'  },
        ]);
    });
});

// ---------------------------------------------------------------------------
// resolveScalar
// ---------------------------------------------------------------------------

describe('resolveScalar', () => {
    it('empty → null',            () => expect(resolveScalar('', {})).toBeNull());
    it('null  → null',            () => expect(resolveScalar(null, {})).toBeNull());
    it('bare literal',            () => expect(resolveScalar('first', {})).toBe('first'));
    it('var ref → resolved value',() => expect(resolveScalar('{{mode}}', { mode: 'last' })).toBe('last'));
    it('missing var → null',      () => expect(resolveScalar('{{mode}}', {})).toBeNull());
    it('empty var  → null',       () => expect(resolveScalar('{{mode}}', { mode: '' })).toBeNull());
});

// ---------------------------------------------------------------------------
// globTest
// ---------------------------------------------------------------------------

describe('globTest', () => {
    it('exact match',               () => expect(globTest('Dragon', 'Dragon')).toBe(true));
    it('case-insensitive',          () => expect(globTest('dragon', 'Dragon')).toBe(true));
    it('exact mismatch',            () => expect(globTest('Dragon', 'Elf')).toBe(false));
    it('* matches any chars',       () => expect(globTest('Drag*', 'Dragon')).toBe(true));
    it('* matches zero chars',      () => expect(globTest('Dragon*', 'Dragon')).toBe(true));
    it('? matches one char',        () => expect(globTest('Drag?n', 'Dragon')).toBe(true));
    it('? does not match zero',     () => expect(globTest('Drag?n', 'Dragn')).toBe(false));
    it('* in middle',               () => expect(globTest('D*n', 'Dragon')).toBe(true));
    it('no partial match without *',() => expect(globTest('Drag', 'Dragon')).toBe(false));
    it('special regex chars escaped',() => expect(globTest('a.b', 'axb')).toBe(false));
});

// ---------------------------------------------------------------------------
// filterMatchesSingle
// ---------------------------------------------------------------------------

describe('filterMatchesSingle — null / empty', () => {
    it('null filter always passes',    () => expect(filterMatchesSingle(null, 'anything')).toBe(true));
    it('empty items always fails',     () => {
        const f = resolveArg({ type: 'OR', items: [] }, {});
        expect(filterMatchesSingle(f, 'Dragon')).toBe(false);
    });
});

describe('filterMatchesSingle — OR, inclusions only', () => {
    const f = v => resolveArg(parseArg(v), {});

    it('matching literal passes',       () => expect(filterMatchesSingle(f('Dragon'), 'Dragon')).toBe(true));
    it('non-matching literal fails',    () => expect(filterMatchesSingle(f('Dragon'), 'Elf')).toBe(false));
    it('any item match passes',         () => expect(filterMatchesSingle(f('Dragon, Elf'), 'Elf')).toBe(true));
    it('glob wildcard passes',          () => expect(filterMatchesSingle(f('Drag*'), 'Dragon')).toBe(true));
});

describe('filterMatchesSingle — OR, exclusions', () => {
    const f = v => resolveArg(parseArg(v), {});

    it('only exclusion: excluded value fails',      () => expect(filterMatchesSingle(f('!Dragon'), 'Dragon')).toBe(false));
    it('only exclusion: non-excluded value passes', () => expect(filterMatchesSingle(f('!Dragon'), 'Elf')).toBe(true));
    it('exclusion vetoes inclusion',                () => expect(filterMatchesSingle(f('Dragon, !Dragon'), 'Dragon')).toBe(false));
    it('exclusion does not affect other values',    () => expect(filterMatchesSingle(f('!Dragon, Elf'), 'Elf')).toBe(true));
    it('non-excluded and no inclusion fails',       () => expect(filterMatchesSingle(f('!Dragon'), 'Wizard')).toBe(true));
    it('exclusion glob',                            () => expect(filterMatchesSingle(f('!Drag*'), 'Dragon')).toBe(false));
});

describe('filterMatchesSingle — AND', () => {
    const f = v => resolveArg(parseArg(v), {});

    it('single AND item: matches',   () => expect(filterMatchesSingle(f('AND(Dragon)'), 'Dragon')).toBe(true));
    it('single AND item: no match',  () => expect(filterMatchesSingle(f('AND(Dragon)'), 'Elf')).toBe(false));
    it('two AND items on one value always fails', () => {
        expect(filterMatchesSingle(f('AND(Dragon, Elf)'), 'Dragon')).toBe(false);
        expect(filterMatchesSingle(f('AND(Dragon, Elf)'), 'Elf')).toBe(false);
    });
    it('AND with negation: value not matching excluded item passes', () => {
        expect(filterMatchesSingle(f('AND(!Dragon)'), 'Elf')).toBe(true);
    });
    it('AND with negation: excluded value fails', () => {
        expect(filterMatchesSingle(f('AND(!Dragon)'), 'Dragon')).toBe(false);
    });
    it('AND positive+negative: passes when positive matches and excluded pattern does not', () => {
        const r = resolveArg(parseArg('AND(Dragon, !Fire)'), {});
        expect(filterMatchesSingle(r, 'Dragon')).toBe(true);
    });
    it('AND positive+negative: fails when string triggers the excluded pattern', () => {
        const r = resolveArg(parseArg('AND(!Fire)'), {});
        expect(filterMatchesSingle(r, 'Fire')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// filterMatchesArray
// ---------------------------------------------------------------------------

describe('filterMatchesArray — null / empty', () => {
    it('null filter always passes',  () => expect(filterMatchesArray(null, ['dragon'])).toBe(true));
    it('empty items always fails',   () => {
        const f = resolveArg({ type: 'OR', items: [] }, {});
        expect(filterMatchesArray(f, ['dragon'])).toBe(false);
    });
    it('empty string array + null filter passes', () => expect(filterMatchesArray(null, [])).toBe(true));
});

describe('filterMatchesArray — OR, inclusions', () => {
    const f = v => resolveArg(parseArg(v), {});

    it('key in array matches', () => expect(filterMatchesArray(f('dragon'), ['dragon', 'beast'])).toBe(true));
    it('key not in array fails', () => expect(filterMatchesArray(f('fire'), ['dragon', 'beast'])).toBe(false));
    it('any key match suffices', () => expect(filterMatchesArray(f('dragon, fire'), ['fire', 'water'])).toBe(true));
    it('glob across keys', () => expect(filterMatchesArray(f('drag*'), ['dragon', 'beast'])).toBe(true));
});

describe('filterMatchesArray — OR, exclusions', () => {
    const f = v => resolveArg(parseArg(v), {});

    it('only exclusion: excluded key present → fails', () =>
        expect(filterMatchesArray(f('!dragon'), ['dragon', 'beast'])).toBe(false));
    it('only exclusion: excluded key absent → passes', () =>
        expect(filterMatchesArray(f('!dragon'), ['beast', 'wizard'])).toBe(true));
    it('exclusion vetoes even if inclusion also matches', () =>
        expect(filterMatchesArray(f('dragon, !dragon'), ['dragon'])).toBe(false));
    it('exclusion on one key, inclusion on another', () =>
        expect(filterMatchesArray(f('beast, !dragon'), ['beast', 'wizard'])).toBe(true));
    it('exclusion blocks when excluded key present despite other inclusion', () =>
        expect(filterMatchesArray(f('beast, !dragon'), ['beast', 'dragon'])).toBe(false));
});

describe('filterMatchesArray — AND', () => {
    const f = v => resolveArg(parseArg(v), {});

    it('AND: both keys present → passes', () =>
        expect(filterMatchesArray(f('AND(sword, magic)'), ['sword', 'magic', 'beast'])).toBe(true));
    it('AND: one key missing → fails', () =>
        expect(filterMatchesArray(f('AND(sword, magic)'), ['sword', 'beast'])).toBe(false));
    it('AND: empty array → fails', () =>
        expect(filterMatchesArray(f('AND(sword, magic)'), [])).toBe(false));
    it('AND negative: excluded key absent → passes', () =>
        expect(filterMatchesArray(f('AND(!fire)'), ['sword', 'magic'])).toBe(true));
    it('AND negative: excluded key present → fails', () =>
        expect(filterMatchesArray(f('AND(!fire)'), ['sword', 'fire'])).toBe(false));
    it('AND positive+negative: passes when all positive present and no negative present', () =>
        expect(filterMatchesArray(f('AND(sword, !fire)'), ['sword', 'magic'])).toBe(true));
    it('AND positive+negative: fails when positive present but negative also present', () =>
        expect(filterMatchesArray(f('AND(sword, !fire)'), ['sword', 'fire'])).toBe(false));
    it('AND positive+negative: fails when positive absent even if negative also absent', () =>
        expect(filterMatchesArray(f('AND(sword, !fire)'), ['magic'])).toBe(false));
});

describe('filterMatchesArray — AND, cross-entry semantics', () => {
    it('AND across same entry keys: all items can be satisfied by one entry', () => {
        const f = resolveArg(parseArg('AND(dragon, beast)'), {});
        const entryWithBoth = ['dragon', 'beast', 'npc'];
        expect(filterMatchesArray(f, entryWithBoth)).toBe(true);
    });
    it('AND not satisfied by splitting across different entries', () => {
        const f = resolveArg(parseArg('AND(dragon, beast)'), {});
        const entry1 = ['dragon', 'npc'];
        const entry2 = ['beast', 'npc'];
        // Each individual entry must satisfy AND independently
        expect(filterMatchesArray(f, entry1)).toBe(false);
        expect(filterMatchesArray(f, entry2)).toBe(false);
    });
});
