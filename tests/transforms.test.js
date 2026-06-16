import { vi, describe, it, expect } from 'vitest';

// Minimal mocks so template.js can import without pulling in ST globals.
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

import { resolveTransforms, TRANSFORM_PREFIXES } from '../actions/transforms.js';
import { interpolate }                            from '../actions/template.js';

// ---------------------------------------------------------------------------
// resolveTransforms — {{trim:}}
// ---------------------------------------------------------------------------

describe('resolveTransforms — {{trim:}}', () => {
    it('trims leading and trailing spaces', () => {
        expect(resolveTransforms('{{trim:   hello   }}')).toBe('hello');
    });

    it('trims leading and trailing newlines', () => {
        expect(resolveTransforms('{{trim:\nline\n}}')).toBe('line');
    });

    it('trims mixed whitespace around multi-line content', () => {
        expect(resolveTransforms('{{trim:  \nline1\nline2\n  }}')).toBe('line1\nline2');
    });

    it('returns empty string when value is only whitespace', () => {
        expect(resolveTransforms('{{trim:   }}')).toBe('');
    });

    it('preserves surrounding template text', () => {
        expect(resolveTransforms('prefix {{trim: hello }} suffix')).toBe('prefix hello suffix');
    });

    it('handles an already-clean value', () => {
        expect(resolveTransforms('{{trim: hello}}')).toBe('hello');
    });
});

// ---------------------------------------------------------------------------
// resolveTransforms — {{upper:}} / {{lower:}}
// ---------------------------------------------------------------------------

describe('resolveTransforms — {{upper:}} / {{lower:}}', () => {
    it('uppercases a simple string', () => {
        expect(resolveTransforms('{{upper: hello}}')).toBe('HELLO');
    });

    it('lowercases a simple string', () => {
        expect(resolveTransforms('{{lower: HELLO}}')).toBe('hello');
    });

    it('upper handles mixed case', () => {
        expect(resolveTransforms('{{upper: Hello World}}')).toBe('HELLO WORLD');
    });

    it('lower handles mixed case', () => {
        expect(resolveTransforms('{{lower: Hello World}}')).toBe('hello world');
    });

    it('upper on an empty value returns empty string', () => {
        expect(resolveTransforms('{{upper:}}')).toBe('');
    });

    it('lower on an empty value returns empty string', () => {
        expect(resolveTransforms('{{lower:}}')).toBe('');
    });
});

// ---------------------------------------------------------------------------
// resolveTransforms — {{lines: N:}}
// ---------------------------------------------------------------------------

describe('resolveTransforms — {{lines: N:}}', () => {
    it('keeps the first N lines', () => {
        expect(resolveTransforms('{{lines: 2: a\nb\nc}}')).toBe('a\nb');
    });

    it('returns all lines when N exceeds the line count', () => {
        expect(resolveTransforms('{{lines: 10: a\nb}}')).toBe('a\nb');
    });

    it('returns the single first line when N is 1', () => {
        expect(resolveTransforms('{{lines: 1: a\nb\nc}}')).toBe('a');
    });

    it('clamps N=0 to 1 so at least one line is returned', () => {
        expect(resolveTransforms('{{lines: 0: a\nb\nc}}')).toBe('a');
    });

    it('returns an empty string when the value is empty', () => {
        expect(resolveTransforms('{{lines: 2:}}')).toBe('');
    });

    it('does not add trailing newline when N exactly matches the line count', () => {
        const result = resolveTransforms('{{lines: 2: a\nb}}');
        expect(result).toBe('a\nb');
        expect(result.endsWith('\n')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// resolveTransforms — {{words: N:}}
// ---------------------------------------------------------------------------

describe('resolveTransforms — {{words: N:}}', () => {
    it('keeps the first N words', () => {
        expect(resolveTransforms('{{words: 3: one two three four five}}')).toBe('one two three');
    });

    it('returns all words when N exceeds the word count', () => {
        expect(resolveTransforms('{{words: 10: one two}}')).toBe('one two');
    });

    it('returns a single word when N is 1', () => {
        expect(resolveTransforms('{{words: 1: one two three}}')).toBe('one');
    });

    it('clamps N=0 to 1', () => {
        expect(resolveTransforms('{{words: 0: one two three}}')).toBe('one');
    });

    it('handles extra whitespace between words', () => {
        expect(resolveTransforms('{{words: 2:  one   two   three  }}')).toBe('one two');
    });

    it('returns an empty string when the value is empty', () => {
        expect(resolveTransforms('{{words: 3:}}')).toBe('');
    });
});

// ---------------------------------------------------------------------------
// resolveTransforms — {{default: fallback:}}
// ---------------------------------------------------------------------------

describe('resolveTransforms — {{default: fallback:}}', () => {
    it('returns the value when it is non-empty', () => {
        expect(resolveTransforms('{{default: N/A: hello}}')).toBe('hello');
    });

    it('returns the fallback when the value is empty', () => {
        expect(resolveTransforms('{{default: N/A:}}')).toBe('N/A');
    });

    it('returns the fallback when the value is only whitespace', () => {
        expect(resolveTransforms('{{default: N/A:    }}')).toBe('N/A');
    });

    it('returns the fallback when the value is only newlines', () => {
        expect(resolveTransforms('{{default: N/A:\n\n}}')).toBe('N/A');
    });

    it('returns the value unchanged when non-empty, preserving internal whitespace', () => {
        expect(resolveTransforms('{{default: N/A: line1\nline2}}')).toBe('line1\nline2');
    });

    it('fallback may be an empty string', () => {
        expect(resolveTransforms('{{default: :}}')).toBe('');
    });
});

// ---------------------------------------------------------------------------
// resolveTransforms — multiple transforms in one template
// ---------------------------------------------------------------------------

describe('resolveTransforms — multiple transforms', () => {
    it('resolves two independent transforms in the same string', () => {
        expect(resolveTransforms('{{trim:  a  }} and {{upper: b}}')).toBe('a and B');
    });

    it('resolves different transform types in sequence', () => {
        const result = resolveTransforms('{{lines: 1: x\ny}} | {{lower: HI}}');
        expect(result).toBe('x | hi');
    });
});

// ---------------------------------------------------------------------------
// TRANSFORM_PREFIXES — deferred-token registry
// ---------------------------------------------------------------------------

describe('TRANSFORM_PREFIXES', () => {
    it('includes all six transform names', () => {
        const required = ['trim:', 'upper:', 'lower:', 'lines:', 'words:', 'default:'];
        for (const p of required) {
            expect(TRANSFORM_PREFIXES).toContain(p);
        }
    });
});

// ---------------------------------------------------------------------------
// Integration: transforms through interpolate()
// ---------------------------------------------------------------------------

describe('interpolate — transforms via two-pass resolution', () => {
    it('trims a variable value via {{trim: {{varName}}}}', () => {
        expect(interpolate('{{trim: {{opts}}}}', { opts: '  hello  ' })).toBe('hello');
    });

    it('trims trailing newlines from LLM-generated options', () => {
        expect(interpolate('{{trim: {{opts}}}}', { opts: 'a\nb\nc\n\n' })).toBe('a\nb\nc');
    });

    it('uppercases a variable value', () => {
        expect(interpolate('{{upper: {{name}}}}', { name: 'alice' })).toBe('ALICE');
    });

    it('lowercases a variable value', () => {
        expect(interpolate('{{lower: {{mood}}}}', { mood: 'HAPPY' })).toBe('happy');
    });

    it('takes the first N lines of a variable value', () => {
        expect(interpolate('{{lines: 2: {{opts}}}}', { opts: 'a\nb\nc\nd' })).toBe('a\nb');
    });

    it('takes the first N words of a variable value', () => {
        expect(interpolate('{{words: 2: {{summary}}}}', { summary: 'one two three four' })).toBe('one two');
    });

    it('uses fallback when a variable resolves to empty', () => {
        expect(interpolate('{{default: nothing: {{summary}}}}', { summary: '' })).toBe('nothing');
    });

    it('uses fallback when a variable is unset (resolves to empty string)', () => {
        expect(interpolate('{{default: nothing: {{summary}}}}', {})).toBe('nothing');
    });

    it('uses the variable value when non-empty with default', () => {
        expect(interpolate('{{default: nothing: {{summary}}}}', { summary: 'hello' })).toBe('hello');
    });

    it('trim with literal value (no inner var) is deferred and resolved correctly', () => {
        expect(interpolate('{{trim: hello world }}', {})).toBe('hello world');
    });

    it('default with literal value is deferred and resolved correctly', () => {
        expect(interpolate('{{default: fallback: actual}}', {})).toBe('actual');
    });

    it('transforms do not interfere with surrounding {{varName}} tokens', () => {
        const result = interpolate('{{name}}: {{trim: {{opts}}}}', {
            name: 'Alice',
            opts: '  option  ',
        });
        expect(result).toBe('Alice: option');
    });

    it('trim then lines: transforms compose because trim regex runs before lines regex', () => {
        // {{opts}} resolves in the first pass → {{trim: a\nb\nc\n\n}} inside {{lines:...}}
        // resolveTransforms runs trim first, collapsing to {{lines: 2: a\nb\nc}}, then lines.
        const result = interpolate('{{lines: 2: {{trim: {{opts}}}}}}', { opts: 'a\nb\nc\n\n' });
        expect(result).toBe('a\nb');
    });
});
