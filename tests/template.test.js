import { vi, describe, it, expect, afterEach } from 'vitest';

// Mock triggers.js to prevent its world-info imports from loading.
// Provide the three symbols that template.js actually uses.
vi.mock('../triggers.js', () => ({
    getLbEntryByName:     vi.fn(async () => null),
    resolveLbQueryTokens: vi.fn(async t => t),
    getTurnVarsSnapshot:  vi.fn(() => ({})),
}));

// `actions/template.js` imports `'../../../../../scripts/variables.js'`.
// Both `actions/` and `tests/` sit one level below the project root, so
// the same relative path resolves to the same absolute file from here.
// Providing a factory means Vitest never tries to load the missing file.
vi.mock('../../../../../scripts/variables.js', () => ({
    getLocalVariable:  vi.fn(() => null),
    getGlobalVariable: vi.fn(() => null),
}));

import { interpolate, getTemplateTier }          from '../actions/template.js';
import { getLocalVariable, getGlobalVariable }   from '../../../../../scripts/variables.js';

afterEach(() => { vi.clearAllMocks(); });

// ---------------------------------------------------------------------------
// interpolate — basic substitution
// ---------------------------------------------------------------------------

describe('interpolate — basic substitution', () => {
    it('replaces a known variable', () => {
        expect(interpolate('Hello {{name}}', { name: 'Alice' })).toBe('Hello Alice');
    });

    it('returns empty string for an unknown variable', () => {
        expect(interpolate('{{unknown}}', {})).toBe('');
    });

    it('passes through text with no tokens unchanged', () => {
        expect(interpolate('plain text', {})).toBe('plain text');
    });

    it('uses ruleVars as a fallback when the var is absent from vars', () => {
        expect(interpolate('{{x}}', {}, { x: 'from-rule' })).toBe('from-rule');
    });

    it('prefers vars over ruleVars for the same key', () => {
        expect(interpolate('{{x}}', { x: 'from-vars' }, { x: 'from-rule' })).toBe('from-vars');
    });

    it('replaces multiple independent tokens', () => {
        expect(interpolate('{{a}} and {{b}}', { a: '1', b: '2' })).toBe('1 and 2');
    });

    it('returns empty string for an empty template', () => {
        expect(interpolate('', {})).toBe('');
    });
});

// ---------------------------------------------------------------------------
// interpolate — chatvar / globalvar
// ---------------------------------------------------------------------------

describe('interpolate — chatvar / globalvar', () => {
    it('resolves {{chatvar::name}} via getLocalVariable', () => {
        vi.mocked(getLocalVariable).mockReturnValue('Bob');
        expect(interpolate('{{chatvar::name}}', {})).toBe('Bob');
    });

    it('resolves {{globalvar::score}} via getGlobalVariable', () => {
        vi.mocked(getGlobalVariable).mockReturnValue('42');
        expect(interpolate('{{globalvar::score}}', {})).toBe('42');
    });

    it('passes the dot-notation index for {{chatvar::stats.hp}}', () => {
        vi.mocked(getLocalVariable).mockReturnValue('100');
        interpolate('{{chatvar::stats.hp}}', {});
        expect(getLocalVariable).toHaveBeenCalledWith('stats', { index: 'hp' });
    });

    it('passes the bracket-notation index for {{chatvar::list[0]}}', () => {
        vi.mocked(getLocalVariable).mockReturnValue('first');
        interpolate('{{chatvar::list[0]}}', {});
        expect(getLocalVariable).toHaveBeenCalledWith('list', { index: '0' });
    });

    it('returns empty string when chatvar resolves to null', () => {
        vi.mocked(getLocalVariable).mockReturnValue(null);
        expect(interpolate('{{chatvar::missing}}', {})).toBe('');
    });

    it('returns empty string when chatvar resolves to undefined', () => {
        vi.mocked(getLocalVariable).mockReturnValue(undefined);
        expect(interpolate('{{chatvar::missing}}', {})).toBe('');
    });
});

// ---------------------------------------------------------------------------
// interpolate — {{if}} blocks
// ---------------------------------------------------------------------------

describe('interpolate — {{if}} blocks', () => {
    it('includes body when condition is true', () => {
        expect(interpolate('{{if mood is "happy"}}yes{{/if}}', { mood: 'happy' })).toBe('yes');
    });

    it('excludes body when condition is false', () => {
        expect(interpolate('{{if mood is "happy"}}yes{{/if}}', { mood: 'sad' })).toBe('');
    });

    it('handles the contains operator — match', () => {
        expect(interpolate('{{if text contains "world"}}yes{{/if}}', { text: 'hello world' })).toBe('yes');
    });

    it('handles the contains operator — no match', () => {
        expect(interpolate('{{if text contains "world"}}yes{{/if}}', { text: 'hello' })).toBe('');
    });

    it('handles empty operator — empty string is empty', () => {
        expect(interpolate('{{if mood empty}}yes{{/if}}', { mood: '' })).toBe('yes');
    });

    it('handles empty operator — non-empty string is not empty', () => {
        expect(interpolate('{{if mood empty}}yes{{/if}}', { mood: 'happy' })).toBe('');
    });

    it('treats "none" and "unspecified" as empty', () => {
        expect(interpolate('{{if x empty}}yes{{/if}}', { x: 'none' })).toBe('yes');
        expect(interpolate('{{if x empty}}yes{{/if}}', { x: 'unspecified' })).toBe('yes');
    });

    it('handles numeric > comparison — true', () => {
        expect(interpolate('{{if score > 5}}high{{/if}}', { score: '10' })).toBe('high');
    });

    it('handles numeric > comparison — false', () => {
        expect(interpolate('{{if score > 5}}high{{/if}}', { score: '3' })).toBe('');
    });

    it('handles numeric < comparison', () => {
        expect(interpolate('{{if score < 5}}low{{/if}}', { score: '3' })).toBe('low');
        expect(interpolate('{{if score < 5}}low{{/if}}', { score: '10' })).toBe('');
    });

    it('handles >= and <= comparisons', () => {
        expect(interpolate('{{if score >= 5}}yes{{/if}}', { score: '5' })).toBe('yes');
        expect(interpolate('{{if score <= 5}}yes{{/if}}', { score: '5' })).toBe('yes');
        expect(interpolate('{{if score >= 5}}yes{{/if}}', { score: '4' })).toBe('');
    });

    it('handles AND combinator — both true', () => {
        expect(interpolate('{{if a is "x" AND b is "y"}}yes{{/if}}', { a: 'x', b: 'y' })).toBe('yes');
    });

    it('handles AND combinator — one false', () => {
        expect(interpolate('{{if a is "x" AND b is "y"}}yes{{/if}}', { a: 'x', b: 'z' })).toBe('');
    });

    it('handles OR combinator — one true is sufficient', () => {
        expect(interpolate('{{if a is "x" OR b is "y"}}yes{{/if}}', { a: 'x', b: 'z' })).toBe('yes');
    });

    it('handles OR combinator — both false', () => {
        expect(interpolate('{{if a is "x" OR b is "y"}}yes{{/if}}', { a: 'q', b: 'z' })).toBe('');
    });

    it('handles negation — !empty on a non-empty var', () => {
        expect(interpolate('{{if !mood empty}}yes{{/if}}', { mood: 'happy' })).toBe('yes');
    });

    it('handles negation — !empty on an empty var', () => {
        expect(interpolate('{{if !mood empty}}yes{{/if}}', { mood: '' })).toBe('');
    });

    it('handles the in operator — value in list', () => {
        expect(interpolate('{{if mood in (happy, excited)}}yes{{/if}}', { mood: 'happy' })).toBe('yes');
    });

    it('handles the in operator — value not in list', () => {
        expect(interpolate('{{if mood in (happy, excited)}}yes{{/if}}', { mood: 'sad' })).toBe('');
    });

    it('leaves surrounding text intact', () => {
        const result = interpolate('before {{if x is "1"}}[inner]{{/if}} after', { x: '1' });
        expect(result).toBe('before [inner] after');
    });
});

// ---------------------------------------------------------------------------
// interpolate — {{math:}} blocks
// ---------------------------------------------------------------------------

describe('interpolate — {{math:}} blocks', () => {
    it('evaluates addition', () => {
        expect(interpolate('{{math: 2 + 3}}', {})).toBe('5');
    });

    it('evaluates subtraction', () => {
        expect(interpolate('{{math: 10 - 4}}', {})).toBe('6');
    });

    it('evaluates multiplication', () => {
        expect(interpolate('{{math: 3 * 4}}', {})).toBe('12');
    });

    it('evaluates division with a decimal result', () => {
        expect(interpolate('{{math: 10 / 4}}', {})).toBe('2.5');
    });

    it('returns empty string for an invalid expression', () => {
        expect(interpolate('{{math: abc + 1}}', {})).toBe('');
    });

    it('returns empty string for a blank expression', () => {
        expect(interpolate('{{math: }}', {})).toBe('');
    });

    it('runs after variable substitution in surrounding text', () => {
        // Math token itself contains only literals; the surrounding template can mix both.
        expect(interpolate('total: {{math: 2 + 3}} items', {})).toBe('total: 5 items');
    });
});

// ---------------------------------------------------------------------------
// getTemplateTier
// ---------------------------------------------------------------------------

describe('getTemplateTier', () => {
    it('returns "immediate" for an empty array', () => {
        expect(getTemplateTier([])).toBe('immediate');
    });

    it('returns "immediate" for null input', () => {
        expect(getTemplateTier(null)).toBe('immediate');
    });

    it('returns "immediate" when no special tokens are present', () => {
        expect(getTemplateTier(['hello {{name}}'])).toBe('immediate');
    });

    it('returns "message" when {{message}} is present', () => {
        expect(getTemplateTier(['Summarize: {{message}}'])).toBe('message');
    });

    it('returns "paragraph" when {{paragraph}} is present', () => {
        expect(getTemplateTier(['Context: {{paragraph}}'])).toBe('paragraph');
    });

    it('prefers "message" over "paragraph" when both appear', () => {
        expect(getTemplateTier(['{{paragraph}} and {{message}}'])).toBe('message');
    });

    it('checks across multiple strings in the array', () => {
        expect(getTemplateTier(['plain', '{{message}}'])).toBe('message');
    });

    it('is case-insensitive', () => {
        expect(getTemplateTier(['{{MESSAGE}}'])).toBe('message');
        expect(getTemplateTier(['{{PARAGRAPH}}'])).toBe('paragraph');
    });

    it('ignores null/undefined entries in the array', () => {
        expect(getTemplateTier([null, undefined, '{{message}}'])).toBe('message');
    });
});
