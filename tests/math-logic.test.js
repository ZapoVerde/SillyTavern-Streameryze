import { vi, describe, it, expect, afterEach } from 'vitest';

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

import { interpolate } from '../actions/template.js';
import { getLocalVariable, getGlobalVariable } from '../../../../../scripts/variables.js';

afterEach(() => { vi.clearAllMocks(); });

// ---------------------------------------------------------------------------
// {{math:}} — arithmetic evaluation
// ---------------------------------------------------------------------------

describe('{{math:}} — basic arithmetic', () => {
    it('addition', () => {
        expect(interpolate('{{math: 2 + 3}}', {})).toBe('5');
    });

    it('subtraction', () => {
        expect(interpolate('{{math: 10 - 4}}', {})).toBe('6');
    });

    it('multiplication', () => {
        expect(interpolate('{{math: 3 * 4}}', {})).toBe('12');
    });

    it('division that produces an exact decimal', () => {
        expect(interpolate('{{math: 10 / 4}}', {})).toBe('2.5');
    });

    it('modulo', () => {
        expect(interpolate('{{math: 10 % 3}}', {})).toBe('1');
    });

    it('exponentiation via **', () => {
        expect(interpolate('{{math: 2 ** 3}}', {})).toBe('8');
    });

    it('negative result', () => {
        expect(interpolate('{{math: 3 - 8}}', {})).toBe('-5');
    });
});

describe('{{math:}} — order of operations and grouping', () => {
    it('multiplication before addition (standard precedence)', () => {
        expect(interpolate('{{math: 2 + 3 * 4}}', {})).toBe('14');
    });

    it('parentheses override standard precedence', () => {
        expect(interpolate('{{math: (2 + 3) * 4}}', {})).toBe('20');
    });

    it('nested parentheses', () => {
        expect(interpolate('{{math: (2 + (3 * 4)) - 1}}', {})).toBe('13');
    });

    it('division before addition', () => {
        expect(interpolate('{{math: 1 + 10 / 2}}', {})).toBe('6');
    });
});

describe('{{math:}} — float handling', () => {
    it('repeating decimal is rounded to 6 places', () => {
        // 10 / 3 ≈ 3.333333…  → toFixed(6) → parseFloat → '3.333333'
        expect(interpolate('{{math: 10 / 3}}', {})).toBe('3.333333');
    });

    it('floating-point noise is absorbed by the 6-decimal rounding', () => {
        // 0.1 + 0.2 has floating-point noise but rounds cleanly to 0.3
        expect(interpolate('{{math: 0.1 + 0.2}}', {})).toBe('0.3');
    });

    it('trailing zeros after the decimal point are stripped', () => {
        // parseFloat('5.000000') → 5, String(5) → '5'
        expect(interpolate('{{math: 2.5 + 2.5}}', {})).toBe('5');
    });
});

describe('{{math:}} — edge and error cases', () => {
    it('returns empty string for a blank expression', () => {
        expect(interpolate('{{math: }}', {})).toBe('');
    });

    it('returns empty string when the expression contains non-numeric characters', () => {
        expect(interpolate('{{math: abc + 1}}', {})).toBe('');
    });

    it('returns empty string for division by zero (produces Infinity)', () => {
        expect(interpolate('{{math: 1 / 0}}', {})).toBe('');
    });

    it('returns empty string for 0/0 (produces NaN)', () => {
        expect(interpolate('{{math: 0 / 0}}', {})).toBe('');
    });

    it('surrounding text is preserved alongside the math result', () => {
        expect(interpolate('total: {{math: 2 + 3}} items', {})).toBe('total: 5 items');
    });

    it('multiple math blocks in one template', () => {
        expect(interpolate('{{math: 1 + 1}} and {{math: 2 * 2}}', {})).toBe('2 and 4');
    });
});

// ---------------------------------------------------------------------------
// {{if}} — simple comparisons
// ---------------------------------------------------------------------------

describe('{{if}} — is / contains / matches / empty operators', () => {
    it('is — exact match', () => {
        expect(interpolate('{{if mood is "happy"}}yes{{/if}}', { mood: 'happy' })).toBe('yes');
        expect(interpolate('{{if mood is "happy"}}yes{{/if}}', { mood: 'sad'   })).toBe('');
    });

    it('contains — substring match (case-insensitive)', () => {
        expect(interpolate('{{if text contains "WORLD"}}yes{{/if}}', { text: 'hello world' })).toBe('yes');
        expect(interpolate('{{if text contains "dragon"}}yes{{/if}}', { text: 'peaceful'   })).toBe('');
    });

    it('matches — regex match', () => {
        expect(interpolate('{{if hp matches "^\\d+$"}}yes{{/if}}', { hp: '42'  })).toBe('yes');
        expect(interpolate('{{if hp matches "^\\d+$"}}yes{{/if}}', { hp: 'max' })).toBe('');
    });

    it('empty — empty string counts as empty', () => {
        expect(interpolate('{{if x empty}}yes{{/if}}', { x: ''        })).toBe('yes');
        expect(interpolate('{{if x empty}}yes{{/if}}', { x: 'present' })).toBe('');
    });

    it('empty — "none" and "unspecified" are treated as empty', () => {
        expect(interpolate('{{if x empty}}yes{{/if}}', { x: 'none'        })).toBe('yes');
        expect(interpolate('{{if x empty}}yes{{/if}}', { x: 'unspecified' })).toBe('yes');
    });

    it('in — value in list', () => {
        expect(interpolate('{{if mood in (happy, excited)}}yes{{/if}}', { mood: 'happy'  })).toBe('yes');
        expect(interpolate('{{if mood in (happy, excited)}}yes{{/if}}', { mood: 'sad'    })).toBe('');
    });
});

describe('{{if}} — numeric comparisons', () => {
    it('greater than', () => {
        expect(interpolate('{{if score > 5}}yes{{/if}}', { score: '10' })).toBe('yes');
        expect(interpolate('{{if score > 5}}yes{{/if}}', { score: '5'  })).toBe('');
        expect(interpolate('{{if score > 5}}yes{{/if}}', { score: '3'  })).toBe('');
    });

    it('less than', () => {
        expect(interpolate('{{if score < 5}}yes{{/if}}', { score: '3'  })).toBe('yes');
        expect(interpolate('{{if score < 5}}yes{{/if}}', { score: '5'  })).toBe('');
        expect(interpolate('{{if score < 5}}yes{{/if}}', { score: '10' })).toBe('');
    });

    it('greater than or equal', () => {
        expect(interpolate('{{if score >= 5}}yes{{/if}}', { score: '5' })).toBe('yes');
        expect(interpolate('{{if score >= 5}}yes{{/if}}', { score: '6' })).toBe('yes');
        expect(interpolate('{{if score >= 5}}yes{{/if}}', { score: '4' })).toBe('');
    });

    it('less than or equal', () => {
        expect(interpolate('{{if score <= 5}}yes{{/if}}', { score: '5' })).toBe('yes');
        expect(interpolate('{{if score <= 5}}yes{{/if}}', { score: '4' })).toBe('yes');
        expect(interpolate('{{if score <= 5}}yes{{/if}}', { score: '6' })).toBe('');
    });
});

// ---------------------------------------------------------------------------
// {{if}} — NOT (negation)
// ---------------------------------------------------------------------------

describe('{{if}} — NOT (negation)', () => {
    it('!empty on a non-empty value → true', () => {
        expect(interpolate('{{if !x empty}}yes{{/if}}', { x: 'something' })).toBe('yes');
    });

    it('!empty on an empty value → false', () => {
        expect(interpolate('{{if !x empty}}yes{{/if}}', { x: '' })).toBe('');
    });

    it('!is negates an exact match', () => {
        expect(interpolate('{{if !mood is "happy"}}yes{{/if}}', { mood: 'sad'   })).toBe('yes');
        expect(interpolate('{{if !mood is "happy"}}yes{{/if}}', { mood: 'happy' })).toBe('');
    });

    it('double negation (!! empty) cancels out', () => {
        // !!empty on '' → !!true → !false → true
        expect(interpolate('{{if !!x empty}}yes{{/if}}', { x: ''      })).toBe('yes');
        // !!empty on 'value' → !!false → !true → false
        expect(interpolate('{{if !!x empty}}yes{{/if}}', { x: 'value' })).toBe('');
    });
});

// ---------------------------------------------------------------------------
// {{if}} — AND / OR / precedence
// ---------------------------------------------------------------------------

describe('{{if}} — AND combinator', () => {
    it('both conditions true → true', () => {
        expect(interpolate('{{if a is "x" AND b is "y"}}yes{{/if}}', { a: 'x', b: 'y' })).toBe('yes');
    });

    it('first condition false → false', () => {
        expect(interpolate('{{if a is "x" AND b is "y"}}yes{{/if}}', { a: 'z', b: 'y' })).toBe('');
    });

    it('second condition false → false', () => {
        expect(interpolate('{{if a is "x" AND b is "y"}}yes{{/if}}', { a: 'x', b: 'z' })).toBe('');
    });

    it('both false → false', () => {
        expect(interpolate('{{if a is "x" AND b is "y"}}yes{{/if}}', { a: 'z', b: 'z' })).toBe('');
    });

    it('triple AND — all must be true', () => {
        expect(interpolate('{{if a is "1" AND b is "2" AND c is "3"}}yes{{/if}}', { a: '1', b: '2', c: '3' })).toBe('yes');
        expect(interpolate('{{if a is "1" AND b is "2" AND c is "3"}}yes{{/if}}', { a: '1', b: '2', c: 'X' })).toBe('');
    });
});

describe('{{if}} — OR combinator', () => {
    it('either true is sufficient', () => {
        expect(interpolate('{{if a is "x" OR b is "y"}}yes{{/if}}', { a: 'x', b: 'z' })).toBe('yes');
        expect(interpolate('{{if a is "x" OR b is "y"}}yes{{/if}}', { a: 'z', b: 'y' })).toBe('yes');
    });

    it('both false → false', () => {
        expect(interpolate('{{if a is "x" OR b is "y"}}yes{{/if}}', { a: 'z', b: 'z' })).toBe('');
    });

    it('triple OR — any single true is sufficient', () => {
        expect(interpolate('{{if a is "1" OR b is "2" OR c is "3"}}yes{{/if}}', { a: 'X', b: 'X', c: '3' })).toBe('yes');
        expect(interpolate('{{if a is "1" OR b is "2" OR c is "3"}}yes{{/if}}', { a: 'X', b: 'X', c: 'X' })).toBe('');
    });
});

describe('{{if}} — AND/OR operator precedence', () => {
    // Standard boolean algebra: AND binds tighter than OR.
    // `A OR B AND C` evaluates as `A OR (B AND C)`.

    it('AND binds tighter than OR — first operand of OR is true', () => {
        // mood is "x" → true; score > 5 AND flag is "y" → false AND false → false
        // Result: true OR false → true
        expect(interpolate(
            '{{if mood is "x" OR score > 5 AND flag is "y"}}yes{{/if}}',
            { mood: 'x', score: '3', flag: 'n' },
        )).toBe('yes');
    });

    it('AND binds tighter than OR — first operand of OR is false', () => {
        // mood is "x" → false; score > 5 AND flag is "y" → true AND true → true
        // Result: false OR true → true
        expect(interpolate(
            '{{if mood is "x" OR score > 5 AND flag is "y"}}yes{{/if}}',
            { mood: 'z', score: '10', flag: 'y' },
        )).toBe('yes');
    });

    it('AND binds tighter than OR — the precedence matters when only the AND side is false', () => {
        // mood is "x" → true; score > 5 AND flag is "y" → true AND false → false
        // Result: true OR false → true  (still true because mood matched)
        expect(interpolate(
            '{{if mood is "x" OR score > 5 AND flag is "y"}}yes{{/if}}',
            { mood: 'x', score: '10', flag: 'n' },
        )).toBe('yes');
    });

    it('demonstrates where precedence matters: only AND-chain is true, OR lead is false', () => {
        // mood is "x" → false; score > 5 AND flag is "y" → true AND true → true
        // Result: false OR true → true
        // If OR had higher precedence: (false OR true) AND true → true AND true → true — same!
        // Use a case where precedence actually flips the result:
        // A OR B AND C where A=true, B=false, C=false
        //   AND-first: A OR (false) → true
        //   OR-first:  (true) AND false → false
        expect(interpolate(
            '{{if a is "1" OR b is "1" AND c is "1"}}yes{{/if}}',
            { a: '1', b: '0', c: '0' },  // A=true, B=false, C=false
        )).toBe('yes'); // AND-first: true OR false → true
    });
});

describe('{{if}} — parentheses override precedence', () => {
    it('(OR) AND — parentheses make OR evaluate before AND', () => {
        // Without parens: a is "x" OR (b is "y" AND c is "z")
        // With parens:   (a is "x" OR b is "y") AND c is "z"
        expect(interpolate(
            '{{if (a is "x" OR b is "y") AND c is "z"}}yes{{/if}}',
            { a: 'x', b: 'n', c: 'z' },
        )).toBe('yes');

        // If parentheses were ignored (AND-first):
        // a is "x" OR (b is "y" AND c is "z") → true OR false → true   (same result here)
        // Choose values where the two interpretations diverge:
        // a='n', b='y', c='n':
        //   parens: (false OR true) AND false → true AND false → false
        //   no-parens: false OR (true AND false) → false OR false → false  (same!)
        // a='x', b='y', c='n':
        //   parens: (true OR true) AND false → true AND false → false
        //   no-parens: true OR (true AND false) → true OR false → true  (diverges!)
        expect(interpolate(
            '{{if (a is "x" OR b is "y") AND c is "z"}}yes{{/if}}',
            { a: 'x', b: 'y', c: 'n' },
        )).toBe('');  // parens: (true) AND false → false
    });

    it('AND inside parens takes precedence over outer OR', () => {
        expect(interpolate(
            '{{if a is "x" OR (b is "y" AND c is "z")}}yes{{/if}}',
            { a: 'n', b: 'y', c: 'z' },
        )).toBe('yes');

        expect(interpolate(
            '{{if a is "x" OR (b is "y" AND c is "z")}}yes{{/if}}',
            { a: 'n', b: 'y', c: 'n' },
        )).toBe('');
    });
});

// ---------------------------------------------------------------------------
// {{if}} — mixed real-world patterns
// ---------------------------------------------------------------------------

describe('{{if}} — combined operators', () => {
    it('NOT combined with AND', () => {
        expect(interpolate('{{if !x empty AND y is "ok"}}yes{{/if}}', { x: 'set', y: 'ok'  })).toBe('yes');
        expect(interpolate('{{if !x empty AND y is "ok"}}yes{{/if}}', { x: 'set', y: 'bad' })).toBe('');
        expect(interpolate('{{if !x empty AND y is "ok"}}yes{{/if}}', { x: '',    y: 'ok'  })).toBe('');
    });

    it('in operator combined with AND', () => {
        expect(interpolate(
            '{{if mood in (happy, calm) AND hp > 0}}yes{{/if}}',
            { mood: 'happy', hp: '10' },
        )).toBe('yes');

        expect(interpolate(
            '{{if mood in (happy, calm) AND hp > 0}}yes{{/if}}',
            { mood: 'angry', hp: '10' },
        )).toBe('');
    });

    it('numeric comparison combined with OR', () => {
        expect(interpolate(
            '{{if hp < 20 OR status is "dying"}}danger{{/if}}',
            { hp: '15', status: 'alive' },
        )).toBe('danger');

        expect(interpolate(
            '{{if hp < 20 OR status is "dying"}}danger{{/if}}',
            { hp: '50', status: 'dying' },
        )).toBe('danger');

        expect(interpolate(
            '{{if hp < 20 OR status is "dying"}}danger{{/if}}',
            { hp: '50', status: 'alive' },
        )).toBe('');
    });
});

// ---------------------------------------------------------------------------
// Pipeline — variable substitution inside {{math:}} and {{if}}
// These exercise the full interpolate() pass sequence, not the evaluators alone.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// {{math:}} — rand() and randint(N, M)
// ---------------------------------------------------------------------------

describe('{{math:}} — randint(N, M)', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    it('randint(1, 1) always returns the only possible value', () => {
        expect(interpolate('{{math: randint(1, 1)}}', {})).toBe('1');
    });

    it('randint(6, 6) always returns 6', () => {
        expect(interpolate('{{math: randint(6, 6)}}', {})).toBe('6');
    });

    it('returns the lowest value when Math.random is 0', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0); // floor(0 * 6) + 1 = 1
        expect(interpolate('{{math: randint(1, 6)}}', {})).toBe('1');
    });

    it('returns the highest value when Math.random approaches 1', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.99); // floor(0.99 * 6) + 1 = 6
        expect(interpolate('{{math: randint(1, 6)}}', {})).toBe('6');
    });

    it('returns a mid-range value for Math.random = 0.5', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.5); // floor(0.5 * 6) + 1 = 4
        expect(interpolate('{{math: randint(1, 6)}}', {})).toBe('4');
    });

    it('works with negative bounds', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0); // floor(0 * 7) + (-3) = -3
        expect(interpolate('{{math: randint(-3, 3)}}', {})).toBe('-3');
    });

    it('two randint calls in one expression are both substituted', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0); // both calls → 1; 1 + 1 = 2
        expect(interpolate('{{math: randint(1, 6) + randint(1, 6)}}', {})).toBe('2');
    });

    it('composes with regular arithmetic', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0); // randint(1,8) → 1; 100 - 1 = 99
        expect(interpolate('{{math: 100 - randint(1, 8)}}', {})).toBe('99');
    });

    it('returns empty string when lo > hi (invalid bounds)', () => {
        expect(interpolate('{{math: randint(6, 1)}}', {})).toBe('');
    });
});

describe('{{math:}} — rand()', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    it('returns a float when Math.random returns a non-integer', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        expect(interpolate('{{math: rand()}}', {})).toBe('0.5');
    });

    it('returns 0 when Math.random returns 0', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        expect(interpolate('{{math: rand()}}', {})).toBe('0');
    });

    it('composes in arithmetic — rand() * 100 with mock 0.5 = 50', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        expect(interpolate('{{math: rand() * 100}}', {})).toBe('50');
    });

    it('result is within [0, 1) without mocking', () => {
        const result = parseFloat(interpolate('{{math: rand()}}', {}));
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThan(1);
    });
});

describe('{{math:}} — chatvar / globalvar substitution in expression', () => {
    it('chatvar value resolves before math evaluates', () => {
        vi.mocked(getLocalVariable).mockReturnValue(85);
        expect(interpolate('{{math: {{chatvar::hp}} - 15 }}', {})).toBe('70');
    });

    it('globalvar value resolves before math evaluates', () => {
        vi.mocked(getGlobalVariable).mockReturnValue(200);
        expect(interpolate('{{math: {{globalvar::score}} * 2 }}', {})).toBe('400');
    });

    it('chatvar dot-notation index resolves before math evaluates', () => {
        vi.mocked(getLocalVariable).mockReturnValue(50);
        expect(interpolate('{{math: {{chatvar::stats.hp}} + 10 }}', {})).toBe('60');
    });

    it('turn var (ruleVars) resolves before math evaluates', () => {
        // ruleVars are the third argument; inner {{damage}} resolves in the varName pass,
        // leaving {{math: 20 + 5}} which then evaluates.
        expect(interpolate('{{math: {{damage}} + 5 }}', {}, { damage: '20' })).toBe('25');
    });

    it('math result appears mid-string alongside surrounding text', () => {
        vi.mocked(getLocalVariable).mockReturnValue(100);
        expect(interpolate('HP: {{math: {{chatvar::hp}} - 40 }}/100', {})).toBe('HP: 60/100');
    });

    it('multiple chatvar reads in one math expression', () => {
        vi.mocked(getLocalVariable)
            .mockReturnValueOnce(30)   // first call → base
            .mockReturnValueOnce(10);  // second call → bonus
        expect(interpolate('{{math: {{chatvar::base}} + {{chatvar::bonus}} }}', {})).toBe('40');
    });
});

describe('{{if}} — chatvar / globalvar in condition', () => {
    it('chatvar numeric comparison — fires when condition is met', () => {
        vi.mocked(getLocalVariable).mockReturnValue(15);
        expect(interpolate('{{if chatvar::hp < 20}}critical{{/if}}', {})).toBe('critical');
    });

    it('chatvar numeric comparison — suppressed when condition is not met', () => {
        vi.mocked(getLocalVariable).mockReturnValue(50);
        expect(interpolate('{{if chatvar::hp < 20}}critical{{/if}}', {})).toBe('');
    });

    it('chatvar dot-notation index in condition', () => {
        vi.mocked(getLocalVariable).mockReturnValue(8);
        expect(interpolate('{{if chatvar::stats.hp <= 10}}low{{/if}}', {})).toBe('low');
    });

    it('globalvar comparison', () => {
        vi.mocked(getGlobalVariable).mockReturnValue(500);
        expect(interpolate('{{if globalvar::score >= 100}}rich{{/if}}', {})).toBe('rich');
    });

    it('chatvar AND turn var in same condition', () => {
        vi.mocked(getLocalVariable).mockReturnValue(5);
        // vars (second arg) are sysVars — lookup falls back to them for plain names
        expect(interpolate(
            '{{if chatvar::hp < 20 AND danger is "high"}}alert{{/if}}',
            { danger: 'high' },
        )).toBe('alert');
    });

    it('chatvar value in condition body is also substituted', () => {
        vi.mocked(getLocalVariable).mockReturnValue(7);
        expect(interpolate(
            '{{if chatvar::hp < 10}}HP: {{chatvar::hp}}{{/if}}',
            {},
        )).toBe('HP: 7');
    });
});

// ---------------------------------------------------------------------------
// {{if}} — wrapped variable syntax ({{varName}} form)
// Variables in conditions may be written as {{varName}} instead of bare varName.
// Both forms must produce identical results.
// ---------------------------------------------------------------------------

describe('{{if}} — wrapped {{varName}} form is equivalent to bare form', () => {
    it('is — {{mood}} wrapped form matches', () => {
        expect(interpolate('{{if {{mood}} is "angry"}}yes{{/if}}', { mood: 'angry' })).toBe('yes');
        expect(interpolate('{{if {{mood}} is "angry"}}yes{{/if}}', { mood: 'happy' })).toBe('');
    });

    it('is — bare and wrapped produce the same result', () => {
        const vars = { mood: 'angry' };
        expect(interpolate('{{if mood is "angry"}}yes{{/if}}',       vars)).toBe('yes');
        expect(interpolate('{{if {{mood}} is "angry"}}yes{{/if}}',   vars)).toBe('yes');
    });

    it('contains — wrapped form', () => {
        expect(interpolate('{{if {{text}} contains "world"}}yes{{/if}}', { text: 'hello world' })).toBe('yes');
        expect(interpolate('{{if {{text}} contains "world"}}yes{{/if}}', { text: 'hello'       })).toBe('');
    });

    it('numeric comparison — wrapped form', () => {
        expect(interpolate('{{if {{hp}} < 20}}low{{/if}}', { hp: '15' })).toBe('low');
        expect(interpolate('{{if {{hp}} < 20}}low{{/if}}', { hp: '50' })).toBe('');
    });

    it('empty — wrapped form', () => {
        expect(interpolate('{{if {{x}} empty}}yes{{/if}}', { x: ''        })).toBe('yes');
        expect(interpolate('{{if {{x}} empty}}yes{{/if}}', { x: 'present' })).toBe('');
    });

    it('NOT — !{{mood}} wrapped form', () => {
        expect(interpolate('{{if !{{mood}} is "angry"}}yes{{/if}}', { mood: 'happy' })).toBe('yes');
        expect(interpolate('{{if !{{mood}} is "angry"}}yes{{/if}}', { mood: 'angry' })).toBe('');
    });

    it('AND — mixed bare and wrapped in same condition', () => {
        expect(interpolate(
            '{{if {{mood}} is "angry" AND hp < 20}}alert{{/if}}',
            { mood: 'angry', hp: '10' },
        )).toBe('alert');
        expect(interpolate(
            '{{if {{mood}} is "angry" AND hp < 20}}alert{{/if}}',
            { mood: 'calm', hp: '10' },
        )).toBe('');
    });

    it('chatvar:: inside wrapped braces — {{chatvar::some-var}} with :: and - in name', () => {
        vi.mocked(getLocalVariable).mockReturnValue(15);
        expect(interpolate('{{if {{chatvar::some-var}} < 20}}yes{{/if}}', {})).toBe('yes');
    });

    it('body variables still resolve after wrapped-form condition', () => {
        expect(interpolate(
            '{{if {{mood}} is "angry"}}Mood: {{mood}}{{/if}}',
            { mood: 'angry' },
        )).toBe('Mood: angry');
    });
});
