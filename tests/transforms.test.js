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

// ---------------------------------------------------------------------------
// resolveTransforms — {{chars: N:}}
// ---------------------------------------------------------------------------

describe('resolveTransforms — {{chars: N:}}', () => {
    it('returns the first N characters', () => {
        expect(resolveTransforms('{{chars: 5: hello world}}')).toBe('hello');
    });

    it('returns all characters when N exceeds the string length', () => {
        expect(resolveTransforms('{{chars: 100: hello}}')).toBe('hello');
    });

    it('returns empty string when N is 0', () => {
        expect(resolveTransforms('{{chars: 0: hello}}')).toBe('');
    });

    it('returns empty string when value is empty', () => {
        expect(resolveTransforms('{{chars: 5:}}')).toBe('');
    });

    it('counts into multi-line content correctly', () => {
        expect(resolveTransforms('{{chars: 3: ab\ncd}}')).toBe('ab\n');
    });
});

// ---------------------------------------------------------------------------
// resolveTransforms — {{last: N:}}
// ---------------------------------------------------------------------------

describe('resolveTransforms — {{last: N:}}', () => {
    it('returns the last N lines', () => {
        expect(resolveTransforms('{{last: 2: a\nb\nc}}')).toBe('b\nc');
    });

    it('returns all lines when N exceeds the line count', () => {
        expect(resolveTransforms('{{last: 10: a\nb}}')).toBe('a\nb');
    });

    it('returns the single last line when N is 1', () => {
        expect(resolveTransforms('{{last: 1: a\nb\nc}}')).toBe('c');
    });

    it('clamps N=0 to 1', () => {
        expect(resolveTransforms('{{last: 0: a\nb\nc}}')).toBe('c');
    });

    it('returns empty string when value is empty', () => {
        expect(resolveTransforms('{{last: 2:}}')).toBe('');
    });
});

// ---------------------------------------------------------------------------
// resolveTransforms — {{nth: N:}}
// ---------------------------------------------------------------------------

describe('resolveTransforms — {{nth: N:}}', () => {
    it('returns line 1 (1-based)', () => {
        expect(resolveTransforms('{{nth: 1: a\nb\nc}}')).toBe('a');
    });

    it('returns line 2', () => {
        expect(resolveTransforms('{{nth: 2: a\nb\nc}}')).toBe('b');
    });

    it('returns line 3', () => {
        expect(resolveTransforms('{{nth: 3: a\nb\nc}}')).toBe('c');
    });

    it('returns empty string when N exceeds line count', () => {
        expect(resolveTransforms('{{nth: 4: a\nb\nc}}')).toBe('');
    });

    it('clamps N=0 to line 1', () => {
        expect(resolveTransforms('{{nth: 0: a\nb\nc}}')).toBe('a');
    });

    it('returns empty string when value is empty', () => {
        expect(resolveTransforms('{{nth: 1:}}')).toBe('');
    });
});

// ---------------------------------------------------------------------------
// resolveTransforms — {{cap:}}
// ---------------------------------------------------------------------------

describe('resolveTransforms — {{cap:}}', () => {
    it('capitalizes the first character', () => {
        expect(resolveTransforms('{{cap: hello world}}')).toBe('Hello world');
    });

    it('leaves an already-uppercase first character unchanged', () => {
        expect(resolveTransforms('{{cap: HELLO}}')).toBe('HELLO');
    });

    it('does not change non-alpha first characters', () => {
        expect(resolveTransforms('{{cap: 123abc}}')).toBe('123abc');
    });

    it('returns empty string on empty value', () => {
        expect(resolveTransforms('{{cap:}}')).toBe('');
    });

    it('does not uppercase beyond the first character', () => {
        expect(resolveTransforms('{{cap: hello WORLD}}')).toBe('Hello WORLD');
    });
});

// ---------------------------------------------------------------------------
// resolveTransforms — {{len:}}
// ---------------------------------------------------------------------------

describe('resolveTransforms — {{len:}}', () => {
    it('returns the character count as a string', () => {
        expect(resolveTransforms('{{len: hello}}')).toBe('5');
    });

    it('returns "0" for an empty value', () => {
        expect(resolveTransforms('{{len:}}')).toBe('0');
    });

    it('counts newlines as characters', () => {
        expect(resolveTransforms('{{len: a\nb}}')).toBe('3');
    });

    it('resolves through interpolate() with a variable value', () => {
        expect(interpolate('{{len: {{name}}}}', { name: 'alice' })).toBe('5');
    });
});

// ---------------------------------------------------------------------------
// resolveTransforms — {{join: delim:}}
// ---------------------------------------------------------------------------

describe('resolveTransforms — {{join: delim:}}', () => {
    it('joins lines with the given delimiter', () => {
        expect(resolveTransforms('{{join: , : a\nb\nc}}')).toBe('a, b, c');
    });

    it('joins with a space delimiter', () => {
        expect(resolveTransforms('{{join:  : a\nb}}')).toBe('a b');
    });

    it('filters blank lines', () => {
        expect(resolveTransforms('{{join: , : a\n\nb}}')).toBe('a, b');
    });

    it('filters whitespace-only lines', () => {
        expect(resolveTransforms('{{join: , : a\n   \nb}}')).toBe('a, b');
    });

    it('returns empty string when value is empty', () => {
        expect(resolveTransforms('{{join: , :}}')).toBe('');
    });

    it('returns a single value unchanged when only one non-empty line', () => {
        expect(resolveTransforms('{{join: , : only}}')).toBe('only');
    });
});

// ---------------------------------------------------------------------------
// resolveTransforms — {{replace: find: with:}}
// ---------------------------------------------------------------------------

describe('resolveTransforms — {{replace: find: with:}}', () => {
    it('replaces all occurrences of find with replacement', () => {
        expect(resolveTransforms('{{replace: foo: bar: foo and foo}}')).toBe('bar and bar');
    });

    it('returns value unchanged when find is not present', () => {
        expect(resolveTransforms('{{replace: foo: bar: no match}}')).toBe('no match');
    });

    it('replaces with empty string when replacement is empty', () => {
        expect(resolveTransforms('{{replace: foo:: hello foo world}}')).toBe('hello  world');
    });

    it('returns value unchanged when find is empty', () => {
        expect(resolveTransforms('{{replace: : bar: hello}}')).toBe('hello');
    });

    it('returns empty string when value is empty', () => {
        expect(resolveTransforms('{{replace: foo: bar:}}')).toBe('');
    });

    it('handles find appearing at the start and end', () => {
        expect(resolveTransforms('{{replace: x: y: xax}}')).toBe('yay');
    });
});

// ---------------------------------------------------------------------------
// resolveTransforms — {{match: /pattern/flags:}}
// ---------------------------------------------------------------------------

describe('resolveTransforms — {{match: /pattern/flags: val}}', () => {
    it('returns the full match when there are no capture groups', () => {
        expect(resolveTransforms('{{match: /\\d+/: abc 42 xyz}}')).toBe('42');
    });

    it('returns capture group 1 when the pattern has a group', () => {
        expect(resolveTransforms('{{match: /(\\w+)@/: user@example.com}}')).toBe('user');
    });

    it('returns empty string when there is no match', () => {
        expect(resolveTransforms('{{match: /\\d+/: no digits here}}')).toBe('');
    });

    it('honours flags — case-insensitive match', () => {
        expect(resolveTransforms('{{match: /hello/i: Say Hello world}}')).toBe('Hello');
    });

    it('handles colons inside the regex pattern without confusion', () => {
        expect(resolveTransforms('{{match: /\\d+:\\d+/: time 12:30 end}}')).toBe('12:30');
    });

    it('returns empty string for a bad pattern without throwing', () => {
        expect(resolveTransforms('{{match: /[invalid/: some text}}')).toBe('');
    });

    it('resolves against an interpolated variable value', () => {
        expect(interpolate('{{match: /^\\w+/: {{response}}}}', { response: 'YES because reasons' })).toBe('YES');
    });
});

// ---------------------------------------------------------------------------
// resolveTransforms — {{bar: value : bucketSize : max}}
// ---------------------------------------------------------------------------

describe('resolveTransforms — {{bar:}}', () => {
    // Tests use bucketSize=10, max=5 (overflow at n >= 50) for readability.

    it('zero value produces empty string', () => {
        expect(resolveTransforms('{{bar: 0 : 10 : 5}}')).toBe('');
    });

    it('value under 20% of one bucket produces empty string', () => {
        // 1 < 10 * 0.2 = 2
        expect(resolveTransforms('{{bar: 1 : 10 : 5}}')).toBe('');
    });

    it('value exactly at 20% of one bucket produces no dot (threshold is exclusive)', () => {
        // remainder=2, 2 > 2 is false
        expect(resolveTransforms('{{bar: 2 : 10 : 5}}')).toBe('');
    });

    it('value just above 20% of one bucket appends a dot', () => {
        // remainder=3, 3 > 2
        expect(resolveTransforms('{{bar: 3 : 10 : 5}}')).toBe('.');
    });

    it('value equal to one full bucket produces one colon', () => {
        expect(resolveTransforms('{{bar: 10 : 10 : 5}}')).toBe(':');
    });

    it('value one bucket plus a small remainder produces one colon and no dot', () => {
        // 11: rem=1, 1 > 2 is false
        expect(resolveTransforms('{{bar: 11 : 10 : 5}}')).toBe(':');
    });

    it('value one bucket plus remainder above 20% produces colon and dot', () => {
        // 13: rem=3, 3 > 2
        expect(resolveTransforms('{{bar: 13 : 10 : 5}}')).toBe(':.');
    });

    it('value spanning multiple full buckets produces that many colons', () => {
        expect(resolveTransforms('{{bar: 30 : 10 : 5}}')).toBe(':::');
    });

    it('value just below overflow produces max-minus-one colons with dot', () => {
        // 49: full=4, rem=9, 9>2
        expect(resolveTransforms('{{bar: 49 : 10 : 5}}')).toBe('::::.');
    });

    it('value at exact overflow boundary appends plus sign', () => {
        // 50 >= 10*5=50 → overflow
        expect(resolveTransforms('{{bar: 50 : 10 : 5}}')).toBe(':::::+');
    });

    it('value well above max also appends plus sign', () => {
        expect(resolveTransforms('{{bar: 999 : 10 : 5}}')).toBe(':::::+');
    });

    it('bucketSize of zero returns empty string', () => {
        expect(resolveTransforms('{{bar: 10 : 0 : 5}}')).toBe('');
    });

    it('max of zero returns empty string', () => {
        expect(resolveTransforms('{{bar: 10 : 10 : 0}}')).toBe('');
    });

    it('non-numeric value does not match the regex and passes through unchanged', () => {
        // The bar regex only matches [\d.]+ for the value field; unrecognised tokens are left as-is.
        expect(resolveTransforms('{{bar: abc : 10 : 5}}')).toBe('{{bar: abc : 10 : 5}}');
    });

    it('resolves through interpolate() after variable substitution', () => {
        expect(interpolate('{{bar: {{val}} : 10 : 5}}', { val: '30' })).toBe(':::');
    });

    it('preserves surrounding template text', () => {
        expect(resolveTransforms('Usage: {{bar: 20 : 10 : 5}} done')).toBe('Usage: :: done');
    });
});

// ---------------------------------------------------------------------------
// resolveTransforms — {{pick: N:}}
// ---------------------------------------------------------------------------

describe('resolveTransforms — {{pick: N:}}', () => {
    it('returns exactly N non-empty lines', () => {
        const result = resolveTransforms('{{pick: 2: a\nb\nc\nd}}');
        expect(result.split('\n')).toHaveLength(2);
    });

    it('all returned lines come from the original set', () => {
        const result = resolveTransforms('{{pick: 2: a\nb\nc}}');
        for (const line of result.split('\n')) expect(['a', 'b', 'c']).toContain(line);
    });

    it('returns all lines when N exceeds line count, sorted for determinism', () => {
        const result = resolveTransforms('{{pick: 10: a\nb\nc}}');
        expect(result.split('\n').sort()).toEqual(['a', 'b', 'c']);
    });

    it('returns the single line when only one line exists', () => {
        expect(resolveTransforms('{{pick: 1: only}}')).toBe('only');
    });

    it('returns empty string when value is empty', () => {
        expect(resolveTransforms('{{pick: 3:}}')).toBe('');
    });

    it('filters blank lines before picking', () => {
        const result = resolveTransforms('{{pick: 2: a\n\nb\n\nc}}');
        const lines = result.split('\n');
        expect(lines).toHaveLength(2);
        for (const line of lines) expect(['a', 'b', 'c']).toContain(line);
    });

    it('filters whitespace-only lines', () => {
        const result = resolveTransforms('{{pick: 1: a\n   \nb}}');
        expect(['a', 'b']).toContain(result);
    });

    it('clamps N=0 to 1', () => {
        const result = resolveTransforms('{{pick: 0: a\nb\nc}}');
        expect(result.split('\n')).toHaveLength(1);
        expect(['a', 'b', 'c']).toContain(result);
    });

    it('resolves through interpolate() after variable substitution', () => {
        const result = interpolate('{{pick: 1: {{opts}}}}', { opts: 'x\ny\nz' });
        expect(['x', 'y', 'z']).toContain(result);
    });
});

// ---------------------------------------------------------------------------
// resolveTransforms — {{hideFromUser:}}
// ---------------------------------------------------------------------------

describe('resolveTransforms — {{hideFromUser:}}', () => {
    it('wraps content in a classless details spoiler', () => {
        expect(resolveTransforms('{{hideFromUser: secret}}')).toBe('<details><summary>▸</summary>secret</details>');
    });

    it('trims leading whitespace from the value', () => {
        expect(resolveTransforms('{{hideFromUser:no-space}}')).toBe('<details><summary>▸</summary>no-space</details>');
    });

    it('wraps multiline content', () => {
        expect(resolveTransforms('{{hideFromUser: line1\nline2}}')).toBe('<details><summary>▸</summary>line1\nline2</details>');
    });

    it('wraps an empty value', () => {
        expect(resolveTransforms('{{hideFromUser:}}')).toBe('<details><summary>▸</summary></details>');
    });

    it('preserves surrounding text', () => {
        expect(resolveTransforms('before {{hideFromUser: x}} after')).toBe('before <details><summary>▸</summary>x</details> after');
    });

    it('resolves through interpolate() after variable substitution', () => {
        expect(interpolate('{{hideFromUser: {{note}}}}', { note: 'hint' })).toBe('<details><summary>▸</summary>hint</details>');
    });
});

// ---------------------------------------------------------------------------
// TRANSFORM_PREFIXES — deferred-token registry
// ---------------------------------------------------------------------------

describe('TRANSFORM_PREFIXES', () => {
    it('includes all eighteen transform names', () => {
        const required = [
            'trim:', 'upper:', 'lower:', 'lines:', 'words:', 'default:',
            'chars:', 'last:', 'nth:', 'cap:', 'len:', 'join:', 'replace:', 'match:', 'bar:', 'pad:', 'pick:',
            'hideFromUser:',
        ];
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
