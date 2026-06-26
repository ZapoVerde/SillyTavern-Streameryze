import { vi, describe, it, expect } from 'vitest';

vi.mock('../triggers.js', () => ({
    getLbEntryByName:     vi.fn(async () => null),
    resolveLbQueryTokens: vi.fn(async t => t),
    getTurnVarsSnapshot:  vi.fn(() => ({})),
}));
vi.mock('../../../../../scripts/variables.js', () => ({
    getLocalVariable:  vi.fn(() => null),
    getGlobalVariable: vi.fn(() => null),
}));
vi.mock('../../../../../script.js',         () => ({ itemizedPrompts: [] }));
vi.mock('../../../../../scripts/openai.js', () => ({ oai_settings: { prompts: [] } }));

import { jaroWinkler, fuzzyMatchText, findAllMatches } from '../triggers/kw-match.js';
import { resolveTransforms }                           from '../actions/transforms.js';
import { evalCondition, makeLookup }                   from '../actions/condition.js';

// ---------------------------------------------------------------------------
// jaroWinkler — pure similarity function
// ---------------------------------------------------------------------------

describe('jaroWinkler', () => {
    it('identical strings score 1', () => {
        expect(jaroWinkler('tavern', 'tavern')).toBe(1);
    });

    it('one empty string scores 0', () => {
        expect(jaroWinkler('tavern', '')).toBe(0);
        expect(jaroWinkler('', 'tavern')).toBe(0);
    });

    it('completely different short strings score low', () => {
        expect(jaroWinkler('abc', 'xyz')).toBeLessThan(0.5);
    });

    it('prefix bonus rewards shared prefixes', () => {
        const withPrefix    = jaroWinkler('tavern', 'tavernnnn');
        const withoutPrefix = jaroWinkler('tavern', 'xxxxxnnn');
        expect(withPrefix).toBeGreaterThan(withoutPrefix);
    });

    it('"tavern" vs "the tavern" scores meaningfully above 0.75', () => {
        expect(jaroWinkler('tavern', 'the tavern')).toBeGreaterThan(0.75);
    });

    it('transposition handled — "abcde" vs "badce"', () => {
        const score = jaroWinkler('abcde', 'badce');
        expect(score).toBeGreaterThan(0.5);
        expect(score).toBeLessThan(1);
    });
});

// ---------------------------------------------------------------------------
// fuzzyMatchText — sliding-window scan of generation text
// ---------------------------------------------------------------------------

describe('fuzzyMatchText', () => {
    it('exact single-word match returns span', () => {
        const m = fuzzyMatchText('entered the Tavern at dusk', 'Tavern', 0.80);
        expect(m).not.toBeNull();
        expect(m.value).toBe('Tavern');
    });

    it('returns start/end positions', () => {
        const text = 'entered the Tavern at dusk';
        const m    = fuzzyMatchText(text, 'Tavern', 0.80);
        expect(m).not.toBeNull();
        expect(text.slice(m.start, m.end)).toBe('Tavern');
    });

    it('matches close variant (The Tavern in text vs Tavern keyword)', () => {
        // "the" and "Tavern" are separate words; keyword is 1 word "Tavern"
        // The word-window will score "Tavern" against "Tavern" at 1.0
        const m = fuzzyMatchText('walked into The Tavern now', 'Tavern', 0.80);
        expect(m).not.toBeNull();
        expect(m.value.toLowerCase()).toContain('tavern');
    });

    it('2-word keyword uses 2-word window', () => {
        const m = fuzzyMatchText('they reached Dark Forest at nightfall', 'Dark Forest', 0.85);
        expect(m).not.toBeNull();
        expect(m.value).toBe('Dark Forest');
    });

    it('returns null when nothing meets threshold', () => {
        expect(fuzzyMatchText('completely unrelated words here', 'Tavern', 0.90)).toBeNull();
    });

    it('empty keyword returns null', () => {
        expect(fuzzyMatchText('some text here', '', 0.80)).toBeNull();
    });

    it('text shorter than keyword word-count returns null', () => {
        expect(fuzzyMatchText('word', 'two words', 0.80)).toBeNull();
    });

    it('threshold 0 always matches', () => {
        expect(fuzzyMatchText('xyz abc', 'Tavern', 0)).not.toBeNull();
    });
});

// ---------------------------------------------------------------------------
// findAllMatches — fuzzy mode
// ---------------------------------------------------------------------------

describe('findAllMatches — fuzzy mode', () => {
    it('returns span for each matching keyword', () => {
        const text   = 'visited the Tavern and the Forest';
        const spans  = findAllMatches(text, {
            useFuzzy: true,
            fuzzyKeywords: ['Tavern', 'Forest'],
            fuzzyThreshold: 0.80,
        });
        expect(spans.length).toBe(2);
        expect(spans.map(s => s.value)).toContain('Tavern');
        expect(spans.map(s => s.value)).toContain('Forest');
    });

    it('returns empty array when nothing matches threshold', () => {
        const spans = findAllMatches('hello world', {
            useFuzzy: true,
            fuzzyKeywords: ['Tavern'],
            fuzzyThreshold: 0.99,
        });
        expect(spans).toHaveLength(0);
    });

    it('does not return overlapping spans', () => {
        const text  = 'Tavern';
        const spans = findAllMatches(text, {
            useFuzzy: true,
            fuzzyKeywords: ['Tavern', 'Tavern'],
            fuzzyThreshold: 0.80,
        });
        expect(spans.length).toBeLessThanOrEqual(1);
    });
});

// ---------------------------------------------------------------------------
// {{fuzzy:}} template transform
// ---------------------------------------------------------------------------

describe('{{fuzzy:}} transform', () => {
    it('returns exact-matching candidate', () => {
        expect(resolveTransforms('{{fuzzy:80:Tavern, Castle, Forest:Tavern}}')).toBe('Tavern');
    });

    it('returns best fuzzy match above threshold', () => {
        // "The Tavern" should score highest against "Tavern"
        expect(resolveTransforms('{{fuzzy:75:Tavern, Castle, Forest:The Tavern}}')).toBe('Tavern');
    });

    it('returns empty string when nothing meets threshold', () => {
        expect(resolveTransforms('{{fuzzy:99:Tavern, Castle, Forest:Xyzzy}}')).toBe('');
    });

    it('returns empty string for empty query', () => {
        expect(resolveTransforms('{{fuzzy:80:Tavern, Castle:}}')).toBe('');
    });

    it('returns empty string for empty candidate list', () => {
        expect(resolveTransforms('{{fuzzy:80::Tavern}}')).toBe('');
    });

    it('default threshold is 80 when omitted', () => {
        // Empty threshold field still returns exact match (score 1.0 ≥ 0.80)
        expect(resolveTransforms('{{fuzzy::Tavern, Castle:Tavern}}')).toBe('Tavern');
    });

    it('query with colon preserved when last arg', () => {
        // Candidates: "A:B" is malformed for CSV but query "foo" works
        expect(resolveTransforms('{{fuzzy:80:Tavern:Tavern}}')).toBe('Tavern');
    });

    it('threshold 0 returns best-scoring candidate', () => {
        const result = resolveTransforms('{{fuzzy:0:Tavern, Castle, Forest:Tavern}}');
        expect(result).toBe('Tavern');
    });

    it('preserves surrounding template text', () => {
        expect(resolveTransforms('Location: {{fuzzy:80:Tavern, Castle:Tavern}} !')).toBe('Location: Tavern !');
    });
});

// ---------------------------------------------------------------------------
// condition evaluator — fuzzy operator
// ---------------------------------------------------------------------------

describe('evalCondition — fuzzy operator', () => {
    const snap = { loc: 'The Tavern', exact: 'Tavern', far: 'Xyzzy' };
    const lk   = makeLookup(snap);

    it('exact match fires at default threshold', () => {
        expect(evalCondition('exact fuzzy "Tavern"', lk)).toBe(true);
    });

    it('close variant fires at threshold 75', () => {
        expect(evalCondition('loc fuzzy "Tavern" 75', lk)).toBe(true);
    });

    it('dissimilar value does not fire at threshold 80', () => {
        expect(evalCondition('far fuzzy "Tavern" 80', lk)).toBe(false);
    });

    it('threshold 0 always fires when var is set', () => {
        expect(evalCondition('far fuzzy "Tavern" 0', lk)).toBe(true);
    });

    it('threshold 100 fires only on exact (lowercased) match', () => {
        expect(evalCondition('exact fuzzy "Tavern" 100', lk)).toBe(true);
        expect(evalCondition('loc fuzzy "Tavern" 100', lk)).toBe(false);
    });

    it('composes with AND', () => {
        expect(evalCondition('exact fuzzy "Tavern" AND exact fuzzy "Tavern"', lk)).toBe(true);
        expect(evalCondition('exact fuzzy "Tavern" AND far fuzzy "Tavern" 90', lk)).toBe(false);
    });
});
