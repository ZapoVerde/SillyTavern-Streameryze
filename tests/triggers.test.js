import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Vitest matches vi.mock paths against the raw import specifier when the file doesn't exist.
// triggers/ submodules (lb-query.js, keyword.js, kw-preview.js) use 5-up paths.
// Keep the 4-up mock as a no-op fallback; the 5-up mock is what actually intercepts.
vi.mock('../../../../scripts/world-info.js', () => ({
    getSortedEntries:          vi.fn(async () => []),
    loadWorldInfo:             vi.fn(async () => null),
    parseRegexFromString:      vi.fn(() => null),
    world_info_case_sensitive: false,
}));
vi.mock('../../../../../scripts/world-info.js', () => ({
    getSortedEntries:          vi.fn(async () => []),
    loadWorldInfo:             vi.fn(async () => null),
    parseRegexFromString:      vi.fn(() => null),
    world_info_case_sensitive: false,
}));

vi.mock('../../../../scripts/variables.js', () => ({
    getLocalVariable:  vi.fn(() => null),
    getGlobalVariable: vi.fn(() => null),
}));

// condition.js (in actions/) and triggers/ submodules use 5-up for variables.js.
vi.mock('../../../../../scripts/variables.js', () => ({
    getLocalVariable:  vi.fn(() => null),
    getGlobalVariable: vi.fn(() => null),
}));

import { TRIGGER_REGISTRY }                                from '../triggers.js';
import { setTurnVar, getTurnVar, clearTurnVars, getTurnVarsSnapshot } from '../triggers/turn-vars.js';
import { clearWiCache, getLbEntryByName, resolveLbQueryTokens }       from '../triggers/lb-query.js';
import { setCurrentEvent, clearCurrentEvent }               from '../triggers/event.js';
// Import from 5-up so vi.mocked() controls the same instance lb-query.js and keyword.js use.
import { getSortedEntries, loadWorldInfo, parseRegexFromString } from '../../../../../scripts/world-info.js';
import { getLocalVariable as getLocalVar5up, getGlobalVariable as getGlobalVar5up } from '../../../../../scripts/variables.js';

beforeEach(() => {
    clearTurnVars();
    clearWiCache();
    clearCurrentEvent();
    vi.clearAllMocks();
    // Default: getSortedEntries returns no entries, loadWorldInfo returns null, parseRegexFromString returns null
    vi.mocked(getSortedEntries).mockResolvedValue([]);
    vi.mocked(loadWorldInfo).mockResolvedValue(null);
    vi.mocked(parseRegexFromString).mockReturnValue(null);
});

afterEach(() => {
    vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Turn variable store
// ---------------------------------------------------------------------------

describe('turn variable store', () => {
    it('getTurnVar returns undefined for an unset variable', () => {
        expect(getTurnVar('missing')).toBeUndefined();
    });

    it('setTurnVar / getTurnVar round-trip', () => {
        setTurnVar('mood', 'happy');
        expect(getTurnVar('mood')).toBe('happy');
    });

    it('clearTurnVars removes all variables', () => {
        setTurnVar('a', '1');
        setTurnVar('b', '2');
        clearTurnVars();
        expect(getTurnVar('a')).toBeUndefined();
        expect(getTurnVar('b')).toBeUndefined();
    });

    it('getTurnVarsSnapshot returns a plain object copy', () => {
        setTurnVar('x', '10');
        setTurnVar('y', '20');
        const snap = getTurnVarsSnapshot();
        expect(snap).toEqual({ x: '10', y: '20' });
    });

    it('modifying the snapshot does not affect the live store', () => {
        setTurnVar('z', 'original');
        const snap = getTurnVarsSnapshot();
        snap.z = 'mutated';
        expect(getTurnVar('z')).toBe('original');
    });
});

// ---------------------------------------------------------------------------
// keyword trigger — text mode
// ---------------------------------------------------------------------------

describe('TRIGGER_REGISTRY.keyword (text mode)', () => {
    const kw = TRIGGER_REGISTRY.keyword;

    it('matches a plain keyword anywhere in the text (case insensitive by default)', async () => {
        expect(await kw.test('Hello World', { mode: 'text', keywords: 'world' })).toBe('world');
    });

    it('returns null when the keyword is not found', async () => {
        expect(await kw.test('Hello World', { mode: 'text', keywords: 'dragon' })).toBeNull();
    });

    it('returns the keyword as matched when caseSensitive is false', async () => {
        expect(await kw.test('HELLO', { mode: 'text', keywords: 'hello', caseSensitive: false })).toBe('hello');
    });

    it('returns null when case-sensitive and case differs', async () => {
        expect(await kw.test('HELLO', { mode: 'text', keywords: 'hello', caseSensitive: true })).toBeNull();
    });

    it('returns the first matching keyword from a comma-separated list', async () => {
        expect(await kw.test('the dragon roars', { mode: 'text', keywords: 'knight, dragon, wizard' })).toBe('dragon');
    });

    it('returns null when no keyword in the list matches', async () => {
        expect(await kw.test('A peaceful meadow', { mode: 'text', keywords: 'dragon, wizard' })).toBeNull();
    });

    it('returns null for empty keywords string', async () => {
        expect(await kw.test('hello world', { mode: 'text', keywords: '' })).toBeNull();
    });

    it('defaults to text mode when mode is absent', async () => {
        expect(await kw.test('hello world', { keywords: 'hello' })).toBe('hello');
    });

    it('glob * matches zero or more word characters after the stem', async () => {
        expect(await kw.test('samuel was there', { mode: 'text', keywords: 'sam*' })).toBe('samuel');
    });

    it('glob * matches the bare stem with zero trailing characters', async () => {
        expect(await kw.test('Hello Sam, how are you?', { mode: 'text', keywords: 'sam*' })).toBe('Sam');
    });

    it('glob * does not match across word boundaries incorrectly', async () => {
        expect(await kw.test('I saw samuel today', { mode: 'text', keywords: 'sam*' })).not.toBeNull();
    });

    it('glob ? matches exactly one character', async () => {
        const result = await kw.test('elara speaks', { mode: 'text', keywords: 'el?ra' });
        expect(result).toBe('elara');
    });

    it('glob ? does not match zero or two characters', async () => {
        expect(await kw.test('elra speaks', { mode: 'text', keywords: 'el?ra' })).toBeNull();
    });

    it('plain keyword matches at word boundary — catches "Sam," but not "Same"', async () => {
        expect(await kw.test('Hello Sam, how are you?', { mode: 'text', keywords: 'Sam' })).toBe('Sam');
        expect(await kw.test('Same went home', { mode: 'text', keywords: 'Sam' })).toBeNull();
    });

    it('glob sam* catches both bare "Sam" and "Same" — differs from plain keyword', async () => {
        expect(await kw.test('Same went home', { mode: 'text', keywords: 'sam*' })).toBe('Same');
        expect(await kw.test('Hello Sam, how are you?', { mode: 'text', keywords: 'sam*' })).toBe('Sam');
    });

    it('{{upper: keyword}} transform is applied before matching', async () => {
        expect(await kw.test('HELLO world', { mode: 'text', keywords: '{{upper: hello}}' })).toBe('HELLO');
    });

    it('{{lower: KEYWORD}} transform produces lowercase keyword for matching', async () => {
        expect(await kw.test('hello world', { mode: 'text', keywords: '{{lower: HELLO}}' })).toBe('hello');
    });

    it('{{trim: keyword}} transform strips whitespace from the resolved keyword', async () => {
        expect(await kw.test('hello world', { mode: 'text', keywords: '{{trim:  hello  }}' })).toBe('hello');
    });

    it('transform applied to a turn variable value produces the correct keyword', async () => {
        setTurnVar('tag', 'hello');
        // Inner {{tag}} is resolved first by _expandKwVars, then {{upper: hello}} by resolveTransforms
        expect(await kw.test('HELLO world', { mode: 'text', keywords: '{{upper: {{tag}}}}' })).toBe('HELLO');
    });

    it('transform token is not silently wiped when variable is absent', async () => {
        // {{upper: literal}} should uppercase the literal "literal", not collapse to ''
        expect(await kw.test('LITERAL found', { mode: 'text', keywords: '{{upper: literal}}' })).toBe('LITERAL');
    });
});

// ---------------------------------------------------------------------------
// keyword trigger — regex tickbox
// ---------------------------------------------------------------------------

describe('TRIGGER_REGISTRY.keyword (regex tickbox)', () => {
    const kw = TRIGGER_REGISTRY.keyword;

    it('returns null for an empty pattern', async () => {
        expect(await kw.test('hello world', { mode: 'text', useRegex: true, pattern: '' })).toBeNull();
    });

    it('matches text with a plain pattern (case-insensitive by default)', async () => {
        expect(await kw.test('Hello World', { mode: 'text', useRegex: true, pattern: 'world' })).toBe('World');
    });

    it('returns null when the pattern does not match', async () => {
        expect(await kw.test('hello world', { mode: 'text', useRegex: true, pattern: 'dragon' })).toBeNull();
    });

    it('parses /pattern/flags syntax directly', async () => {
        expect(await kw.test('A Dragon appeared', { mode: 'text', useRegex: true, pattern: '/dragon/i' })).toBe('Dragon');
    });

    it('respects flags — /pattern/ (no i) is case-sensitive', async () => {
        expect(await kw.test('A Dragon appeared', { mode: 'text', useRegex: true, pattern: '/dragon/' })).toBeNull();
        expect(await kw.test('A dragon appeared', { mode: 'text', useRegex: true, pattern: '/dragon/' })).toBe('dragon');
    });

    it('returns capture group 1 when present', async () => {
        expect(await kw.test('hp: 15', { mode: 'text', useRegex: true, pattern: '/hp: (\\d+)/' })).toBe('15');
    });

    it('returns null for an invalid pattern', async () => {
        expect(await kw.test('text', { mode: 'text', useRegex: true, pattern: '[invalid' })).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// keyword trigger — lorebook mode
// ---------------------------------------------------------------------------

describe('TRIGGER_REGISTRY.keyword (lorebook mode)', () => {
    const kw = TRIGGER_REGISTRY.keyword;

    it('returns null when no lorebook entries have matching keys', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue([
            { comment: 'Elara', disable: false, key: ['elara'], keysecondary: [] },
        ]);
        expect(await kw.test('a peaceful day', { mode: 'lorebook' })).toBeNull();
    });

    it('returns the matched key when text contains a lorebook keyword', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue([
            { comment: 'Elara', disable: false, key: ['elara'], keysecondary: [] },
        ]);
        expect(await kw.test('Elara arrived at the archive.', { mode: 'lorebook' })).toBe('elara');
    });

    it('skips disabled entries', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue([
            { comment: 'Elara', disable: true, key: ['elara'], keysecondary: [] },
        ]);
        expect(await kw.test('Elara arrived.', { mode: 'lorebook' })).toBeNull();
    });

    it('returns null when getSortedEntries returns no entries', async () => {
        vi.mocked(getSortedEntries).mockResolvedValue([]);
        expect(await kw.test('elara dragon wizard', { mode: 'lorebook' })).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// varMatch trigger
// ---------------------------------------------------------------------------

describe('TRIGGER_REGISTRY.varMatch', () => {
    const vm = TRIGGER_REGISTRY.varMatch;

    it('returns null when the variable is not set this turn', async () => {
        expect(await vm.test('', { varName: 'mood', operator: 'equals', value: 'happy' })).toBeNull();
    });

    it('matches with equals operator when values are identical', async () => {
        setTurnVar('mood', 'happy');
        expect(await vm.test('', { varName: 'mood', operator: 'equals', value: 'happy' })).toBe('happy');
    });

    it('returns null with equals when values differ', async () => {
        setTurnVar('mood', 'sad');
        expect(await vm.test('', { varName: 'mood', operator: 'equals', value: 'happy' })).toBeNull();
    });

    it('matches with contains operator (case insensitive)', async () => {
        setTurnVar('desc', 'A large dragon');
        expect(await vm.test('', { varName: 'desc', operator: 'contains', value: 'DRAGON' })).toBe('A large dragon');
    });

    it('matches with useRegex — plain pattern is case-insensitive', async () => {
        setTurnVar('mood', 'Happy');
        expect(await vm.test('', { varName: 'mood', operator: 'equals', value: 'happy', useRegex: true })).toBe('Happy');
    });

    it('matches with useRegex and /pattern/flags syntax', async () => {
        setTurnVar('hp', '15');
        expect(await vm.test('', { varName: 'hp', operator: 'equals', value: '^\\d+$', useRegex: true })).toBe('15');
    });

    it('notEquals + useRegex fires when regex does not match', async () => {
        setTurnVar('status', 'idle');
        expect(await vm.test('', { varName: 'status', operator: 'notEquals', value: '/active|busy/', useRegex: true })).toBe('idle');
    });

    it('notEquals + useRegex returns null when regex matches', async () => {
        setTurnVar('status', 'active');
        expect(await vm.test('', { varName: 'status', operator: 'notEquals', value: '/active|busy/', useRegex: true })).toBeNull();
    });

    it('useRegex returns null for an invalid pattern', async () => {
        setTurnVar('val', 'test');
        expect(await vm.test('', { varName: 'val', operator: 'equals', value: '[invalid', useRegex: true })).toBeNull();
    });

    it('matches with notEmpty operator when variable has a value', async () => {
        setTurnVar('result', 'something');
        expect(await vm.test('', { varName: 'result', operator: 'notEmpty' })).toBe('something');
    });

    it('returns null with notEmpty when variable is empty string', async () => {
        setTurnVar('result', '');
        expect(await vm.test('', { varName: 'result', operator: 'notEmpty' })).toBeNull();
    });

    it('empty fires with "empty" sentinel when variable is set to empty string', async () => {
        setTurnVar('result', '');
        expect(await vm.test('', { varName: 'result', operator: 'empty' })).toBe('empty');
    });

    it('empty fires when variable is set to whitespace-only', async () => {
        setTurnVar('result', '   ');
        expect(await vm.test('', { varName: 'result', operator: 'empty' })).toBe('empty');
    });

    it('empty returns null when variable has a non-blank value', async () => {
        setTurnVar('result', 'something');
        expect(await vm.test('', { varName: 'result', operator: 'empty' })).toBeNull();
    });

    it('empty returns null when variable is not set this turn', async () => {
        expect(await vm.test('', { varName: 'result', operator: 'empty' })).toBeNull();
    });

    it('notEquals fires when values differ', async () => {
        setTurnVar('mood', 'sad');
        expect(await vm.test('', { varName: 'mood', operator: 'notEquals', value: 'happy' })).toBe('sad');
    });

    it('notEquals does not fire when values are equal', async () => {
        setTurnVar('mood', 'happy');
        expect(await vm.test('', { varName: 'mood', operator: 'notEquals', value: 'happy' })).toBeNull();
    });

    it('notEquals returns null when variable is not set', async () => {
        expect(await vm.test('', { varName: 'unset_var', operator: 'notEquals', value: 'x' })).toBeNull();
    });

    it('set fires when variable exists', async () => {
        setTurnVar('flag', 'yes');
        expect(await vm.test('', { varName: 'flag', operator: 'set' })).toBe('yes');
    });

    it('set returns "set" sentinel when variable exists but is empty string', async () => {
        setTurnVar('flag', '');
        expect(await vm.test('', { varName: 'flag', operator: 'set' })).toBe('set');
    });

    it('set returns null when variable is not in turnVars', async () => {
        expect(await vm.test('', { varName: 'missing', operator: 'set' })).toBeNull();
    });

    it('notSet fires with "unset" when variable is absent', async () => {
        expect(await vm.test('', { varName: 'absent', operator: 'notSet' })).toBe('unset');
    });

    it('notSet returns null when variable exists', async () => {
        setTurnVar('present', 'value');
        expect(await vm.test('', { varName: 'present', operator: 'notSet' })).toBeNull();
    });

    it('set sees a ruleset-scoped variable when rulesetId is passed', async () => {
        setTurnVar('flag', 'yes', 'rs-1');
        expect(await vm.test('', { varName: 'flag', operator: 'set' }, 'rs-1')).toBe('yes');
    });

    it('set returns null for a scoped variable when wrong rulesetId is passed', async () => {
        setTurnVar('flag', 'yes', 'rs-1');
        expect(await vm.test('', { varName: 'flag', operator: 'set' }, 'rs-2')).toBeNull();
    });

    it('notSet incorrectly fires without rulesetId for a scoped variable', async () => {
        // Regression guard: scoped vars are invisible without rulesetId → notSet fires even though the var is set
        setTurnVar('flag', 'yes', 'rs-1');
        expect(await vm.test('', { varName: 'flag', operator: 'notSet' })).toBe('unset');
    });

    it('notSet returns null when rulesetId reveals the scoped variable exists', async () => {
        setTurnVar('flag', 'yes', 'rs-1');
        expect(await vm.test('', { varName: 'flag', operator: 'notSet' }, 'rs-1')).toBeNull();
    });

    it('equals matches a ruleset-scoped variable when rulesetId is passed', async () => {
        setTurnVar('mood', 'angry', 'rs-1');
        expect(await vm.test('', { varName: 'mood', operator: 'equals', value: 'angry' }, 'rs-1')).toBe('angry');
    });

    it('equals returns null for a scoped variable without rulesetId', async () => {
        setTurnVar('mood', 'angry', 'rs-1');
        expect(await vm.test('', { varName: 'mood', operator: 'equals', value: 'angry' })).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// chance trigger
// ---------------------------------------------------------------------------

describe('TRIGGER_REGISTRY.chance', () => {
    it('always fires at 100%', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        expect(await TRIGGER_REGISTRY.chance.test('', { chance: 100 })).toBe('chance');
    });

    it('never fires at 0%', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        expect(await TRIGGER_REGISTRY.chance.test('', { chance: 0 })).toBeNull();
    });

    it('fires when random falls below the threshold', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.3);  // 30 < 75
        expect(await TRIGGER_REGISTRY.chance.test('', { chance: 75 })).toBe('chance');
    });

    it('does not fire when random meets or exceeds the threshold', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.8);  // 80 >= 75
        expect(await TRIGGER_REGISTRY.chance.test('', { chance: 75 })).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// condition trigger
// ---------------------------------------------------------------------------

describe('TRIGGER_REGISTRY.condition', () => {
    const cond = TRIGGER_REGISTRY.condition;

    it('returns null for an empty expression', async () => {
        expect(await cond.test('', { expression: '' })).toBeNull();
        expect(await cond.test('', { expression: '   ' })).toBeNull();
    });

    it('returns "true" when the condition is met using a turn variable', async () => {
        setTurnVar('hp', '15');
        expect(await cond.test('', { expression: 'hp < 20' })).toBe('true');
    });

    it('returns null when the condition is not met using a turn variable', async () => {
        setTurnVar('hp', '50');
        expect(await cond.test('', { expression: 'hp < 20' })).toBeNull();
    });

    it('supports all numeric comparison operators via turn vars', async () => {
        setTurnVar('n', '10');
        expect(await cond.test('', { expression: 'n > 5'   })).toBe('true');
        expect(await cond.test('', { expression: 'n < 5'   })).toBeNull();
        expect(await cond.test('', { expression: 'n >= 10' })).toBe('true');
        expect(await cond.test('', { expression: 'n <= 10' })).toBe('true');
        expect(await cond.test('', { expression: 'n >= 11' })).toBeNull();
    });

    it('supports text operators via turn vars', async () => {
        setTurnVar('mood', 'happy');
        expect(await cond.test('', { expression: 'mood is "happy"'       })).toBe('true');
        expect(await cond.test('', { expression: 'mood contains "app"'   })).toBe('true');
        expect(await cond.test('', { expression: 'mood matches "h.*y"'   })).toBe('true');
        expect(await cond.test('', { expression: 'mood is "sad"'         })).toBeNull();
    });

    it('supports empty operator', async () => {
        setTurnVar('flag', '');
        expect(await cond.test('', { expression: 'flag empty'   })).toBe('true');
        setTurnVar('flag', 'set');
        expect(await cond.test('', { expression: 'flag empty'   })).toBeNull();
        expect(await cond.test('', { expression: '!flag empty'  })).toBe('true');
    });

    it('supports AND / OR boolean logic', async () => {
        setTurnVar('a', '5');
        setTurnVar('b', '10');
        expect(await cond.test('', { expression: 'a < 10 AND b > 5'  })).toBe('true');
        expect(await cond.test('', { expression: 'a > 10 AND b > 5'  })).toBeNull();
        expect(await cond.test('', { expression: 'a > 10 OR b > 5'   })).toBe('true');
        expect(await cond.test('', { expression: 'a > 10 OR b > 20'  })).toBeNull();
    });

    it('reads chatvar:: via the 5-up variables mock', async () => {
        vi.mocked(getLocalVar5up).mockReturnValue(15);
        expect(await cond.test('', { expression: 'chatvar::hp < 20' })).toBe('true');
    });

    it('returns null when chatvar:: condition is not met', async () => {
        vi.mocked(getLocalVar5up).mockReturnValue(50);
        expect(await cond.test('', { expression: 'chatvar::hp < 20' })).toBeNull();
    });

    it('resolves chatvar:: dot-notation index in condition', async () => {
        vi.mocked(getLocalVar5up).mockReturnValue(8);
        expect(await cond.test('', { expression: 'chatvar::stats.hp <= 10' })).toBe('true');
    });

    it('combines chatvar:: and turn var in AND condition', async () => {
        setTurnVar('danger', 'high');
        vi.mocked(getLocalVar5up).mockReturnValue(5);
        expect(await cond.test('', { expression: 'chatvar::hp < 20 AND danger is "high"' })).toBe('true');
        expect(await cond.test('', { expression: 'chatvar::hp < 20 AND danger is "low"'  })).toBeNull();
    });

    it('text is ignored — condition trigger does not test message text', async () => {
        setTurnVar('hp', '50');
        // Even if the message text contains "critical", the condition checks vars only
        expect(await cond.test('critical situation', { expression: 'hp < 20' })).toBeNull();
    });

    it('evaluates a ruleset-scoped variable when rulesetId is passed', async () => {
        setTurnVar('mood', 'angry', 'rs-1');
        expect(await cond.test('', { expression: 'mood is "angry"' }, 'rs-1')).toBe('true');
    });

    it('returns null for a scoped variable without rulesetId', async () => {
        // Without rulesetId, scoped vars are invisible; mood defaults to '' which is not 'angry'
        setTurnVar('mood', 'angry', 'rs-1');
        expect(await cond.test('', { expression: 'mood is "angry"' })).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// condition trigger — = and != string equality operators
// ---------------------------------------------------------------------------

describe('condition trigger — = operator', () => {
    const cond = TRIGGER_REGISTRY.condition;

    it('fires when turn var matches the literal', async () => {
        setTurnVar('mood', 'happy');
        expect(await cond.test('', { expression: 'mood = "happy"' })).toBe('true');
    });

    it('is case-insensitive', async () => {
        setTurnVar('mood', 'Happy');
        expect(await cond.test('', { expression: 'mood = "happy"' })).toBe('true');
    });

    it('returns null when the value differs', async () => {
        setTurnVar('mood', 'sad');
        expect(await cond.test('', { expression: 'mood = "happy"' })).toBeNull();
    });

    it('matches an empty string literal', async () => {
        setTurnVar('flag', '');
        expect(await cond.test('', { expression: 'flag = ""' })).toBe('true');
    });

    it('returns null for an unset var compared to a non-empty literal', async () => {
        expect(await cond.test('', { expression: 'missing = "hello"' })).toBeNull();
    });

    it('does not match a substring — full equality only', async () => {
        setTurnVar('mood', 'happily');
        expect(await cond.test('', { expression: 'mood = "happy"' })).toBeNull();
    });

    it('fires for chatvar:: when value matches', async () => {
        vi.mocked(getLocalVar5up).mockReturnValue('hello');
        expect(await cond.test('', { expression: 'chatvar::state = "hello"' })).toBe('true');
    });

    it('is case-insensitive for chatvar::', async () => {
        vi.mocked(getLocalVar5up).mockReturnValue('HELLO');
        expect(await cond.test('', { expression: 'chatvar::state = "hello"' })).toBe('true');
    });

    it('returns null when chatvar:: value differs', async () => {
        vi.mocked(getLocalVar5up).mockReturnValue('world');
        expect(await cond.test('', { expression: 'chatvar::state = "hello"' })).toBeNull();
    });

    it('trims leading/trailing whitespace from the chatvar:: value before comparing', async () => {
        vi.mocked(getLocalVar5up).mockReturnValue('  hello  ');
        expect(await cond.test('', { expression: 'chatvar::msg = "hello"' })).toBe('true');
    });

    it('fires for globalvar:: when value matches', async () => {
        vi.mocked(getGlobalVar5up).mockReturnValue('hello');
        expect(await cond.test('', { expression: 'globalvar::greeting = "hello"' })).toBe('true');
    });

    it('fires in an AND expression when both sides are true', async () => {
        setTurnVar('phase', 'combat');
        setTurnVar('mode', 'hard');
        expect(await cond.test('', { expression: 'phase = "combat" AND mode = "hard"' })).toBe('true');
    });

    it('returns null in an AND expression when one side is false', async () => {
        setTurnVar('phase', 'combat');
        setTurnVar('mode', 'easy');
        expect(await cond.test('', { expression: 'phase = "combat" AND mode = "hard"' })).toBeNull();
    });

    it('fires in an OR expression when one side is true', async () => {
        setTurnVar('phase', 'rest');
        expect(await cond.test('', { expression: 'phase = "combat" OR phase = "rest"' })).toBe('true');
    });

    it('! negation inverts = result', async () => {
        setTurnVar('mood', 'happy');
        expect(await cond.test('', { expression: '!(mood = "happy")' })).toBeNull();
        expect(await cond.test('', { expression: '!(mood = "sad")' })).toBe('true');
    });
});

describe('condition trigger — != operator', () => {
    const cond = TRIGGER_REGISTRY.condition;

    it('fires when the turn var value differs from the literal', async () => {
        setTurnVar('mood', 'sad');
        expect(await cond.test('', { expression: 'mood != "happy"' })).toBe('true');
    });

    it('returns null when values match exactly', async () => {
        setTurnVar('mood', 'happy');
        expect(await cond.test('', { expression: 'mood != "happy"' })).toBeNull();
    });

    it('returns null when values match case-insensitively', async () => {
        setTurnVar('mood', 'Happy');
        expect(await cond.test('', { expression: 'mood != "happy"' })).toBeNull();
    });

    it('fires for an unset var compared to a non-empty literal', async () => {
        expect(await cond.test('', { expression: 'missing != "hello"' })).toBe('true');
    });

    it('fires for chatvar:: when values differ', async () => {
        vi.mocked(getLocalVar5up).mockReturnValue('world');
        expect(await cond.test('', { expression: 'chatvar::state != "hello"' })).toBe('true');
    });

    it('returns null when chatvar:: value matches', async () => {
        vi.mocked(getLocalVar5up).mockReturnValue('hello');
        expect(await cond.test('', { expression: 'chatvar::state != "hello"' })).toBeNull();
    });

    it('fires for globalvar:: when values differ', async () => {
        vi.mocked(getGlobalVar5up).mockReturnValue('world');
        expect(await cond.test('', { expression: 'globalvar::greeting != "hello"' })).toBe('true');
    });
});

// ---------------------------------------------------------------------------
// condition trigger — chatvar:: with hyphenated names
// ---------------------------------------------------------------------------

describe('condition trigger — hyphenated chatvar:: names', () => {
    const cond = TRIGGER_REGISTRY.condition;

    it('= matches a value for a hyphenated chatvar name', async () => {
        vi.mocked(getLocalVar5up).mockReturnValue('hello');
        expect(await cond.test('', { expression: 'chatvar::LT-test = "hello"' })).toBe('true');
    });

    it('!= fires for a hyphenated chatvar name when values differ', async () => {
        vi.mocked(getLocalVar5up).mockReturnValue('world');
        expect(await cond.test('', { expression: 'chatvar::LT-test != "hello"' })).toBe('true');
    });

    it('numeric < works with a hyphenated chatvar name', async () => {
        vi.mocked(getLocalVar5up).mockReturnValue(5);
        expect(await cond.test('', { expression: 'chatvar::my-hp < 10' })).toBe('true');
    });

    it('is works with a hyphenated chatvar name', async () => {
        vi.mocked(getLocalVar5up).mockReturnValue('active');
        expect(await cond.test('', { expression: 'chatvar::my-status is "active"' })).toBe('true');
    });

    it('contains works with a hyphenated chatvar name', async () => {
        vi.mocked(getLocalVar5up).mockReturnValue('combat mode');
        expect(await cond.test('', { expression: 'chatvar::my-state contains "combat"' })).toBe('true');
    });

    it('empty works with a hyphenated chatvar name', async () => {
        vi.mocked(getLocalVar5up).mockReturnValue(null);
        expect(await cond.test('', { expression: 'chatvar::my-flag empty' })).toBe('true');
    });

    it('is empty works with a hyphenated chatvar name', async () => {
        vi.mocked(getLocalVar5up).mockReturnValue(null);
        expect(await cond.test('', { expression: 'chatvar::my-flag is empty' })).toBe('true');
    });
});

// ---------------------------------------------------------------------------
// condition trigger — is empty compound form
// ---------------------------------------------------------------------------

describe('condition trigger — is empty compound', () => {
    const cond = TRIGGER_REGISTRY.condition;

    it('fires for an unset turn var', async () => {
        expect(await cond.test('', { expression: 'missing is empty' })).toBe('true');
    });

    it('fires when turn var is empty string', async () => {
        setTurnVar('flag', '');
        expect(await cond.test('', { expression: 'flag is empty' })).toBe('true');
    });

    it('fires for the "none" sentinel value', async () => {
        setTurnVar('flag', 'none');
        expect(await cond.test('', { expression: 'flag is empty' })).toBe('true');
    });

    it('fires for the "unspecified" sentinel value', async () => {
        setTurnVar('flag', 'unspecified');
        expect(await cond.test('', { expression: 'flag is empty' })).toBe('true');
    });

    it('returns null when turn var has a real value', async () => {
        setTurnVar('flag', 'active');
        expect(await cond.test('', { expression: 'flag is empty' })).toBeNull();
    });

    it('fires for a null chatvar::', async () => {
        vi.mocked(getLocalVar5up).mockReturnValue(null);
        expect(await cond.test('', { expression: 'chatvar::status is empty' })).toBe('true');
    });

    it('fires for an empty-string chatvar::', async () => {
        vi.mocked(getLocalVar5up).mockReturnValue('');
        expect(await cond.test('', { expression: 'chatvar::status is empty' })).toBe('true');
    });

    it('fires for a "none" chatvar:: sentinel', async () => {
        vi.mocked(getLocalVar5up).mockReturnValue('none');
        expect(await cond.test('', { expression: 'chatvar::status is empty' })).toBe('true');
    });

    it('returns null when chatvar:: has a real value', async () => {
        vi.mocked(getLocalVar5up).mockReturnValue('active');
        expect(await cond.test('', { expression: 'chatvar::status is empty' })).toBeNull();
    });

    it('fires for a null globalvar::', async () => {
        vi.mocked(getGlobalVar5up).mockReturnValue(null);
        expect(await cond.test('', { expression: 'globalvar::flag is empty' })).toBe('true');
    });

    it('bare "empty" still fires for empty-string turn var (no regression)', async () => {
        setTurnVar('flag', '');
        expect(await cond.test('', { expression: 'flag empty' })).toBe('true');
    });

    it('bare "empty" still fires for a null chatvar:: (no regression)', async () => {
        vi.mocked(getLocalVar5up).mockReturnValue(null);
        expect(await cond.test('', { expression: 'chatvar::status empty' })).toBe('true');
    });

    it('! negation fires when var is not empty', async () => {
        setTurnVar('flag', 'set');
        expect(await cond.test('', { expression: '!flag is empty' })).toBe('true');
    });

    it('! negation returns null when var is empty', async () => {
        setTurnVar('flag', '');
        expect(await cond.test('', { expression: '!flag is empty' })).toBeNull();
    });

    it('does not confuse "is empty" with is "empty" — quoted "empty" uses is operator', async () => {
        setTurnVar('word', 'empty');
        expect(await cond.test('', { expression: 'word is "empty"' })).toBe('true');
        expect(await cond.test('', { expression: 'word is empty' })).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// condition trigger — in (...) operator
// ---------------------------------------------------------------------------

describe('condition trigger — in operator', () => {
    const cond = TRIGGER_REGISTRY.condition;

    it('fires when turn var value is in the list', async () => {
        setTurnVar('mood', 'happy');
        expect(await cond.test('', { expression: 'mood in (happy, sad, angry)' })).toBe('true');
    });

    it('returns null when turn var value is not in the list', async () => {
        setTurnVar('mood', 'neutral');
        expect(await cond.test('', { expression: 'mood in (happy, sad, angry)' })).toBeNull();
    });

    it('is case-insensitive', async () => {
        setTurnVar('mood', 'HAPPY');
        expect(await cond.test('', { expression: 'mood in (happy, sad)' })).toBe('true');
    });

    it('fires when chatvar:: value is in the list', async () => {
        vi.mocked(getLocalVar5up).mockReturnValue('active');
        expect(await cond.test('', { expression: 'chatvar::status in (active, idle)' })).toBe('true');
    });

    it('returns null when chatvar:: value is not in the list', async () => {
        vi.mocked(getLocalVar5up).mockReturnValue('busy');
        expect(await cond.test('', { expression: 'chatvar::status in (active, idle)' })).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// condition trigger — string operator distinctions
// ---------------------------------------------------------------------------

describe('condition trigger — string operator distinctions', () => {
    const cond = TRIGGER_REGISTRY.condition;

    it('is requires the entire value to equal the word — "happy" does not match "unhappy"', async () => {
        setTurnVar('mood', 'unhappy');
        expect(await cond.test('', { expression: 'mood is "happy"' })).toBeNull();
    });

    it('= enforces full equality — "happy" does not match "unhappy"', async () => {
        setTurnVar('mood', 'unhappy');
        expect(await cond.test('', { expression: 'mood = "happy"' })).toBeNull();
    });

    it('contains matches a substring while = does not', async () => {
        setTurnVar('mood', 'unhappy');
        expect(await cond.test('', { expression: 'mood contains "happy"' })).toBe('true');
        expect(await cond.test('', { expression: 'mood = "happy"' })).toBeNull();
    });

    it('matches tests a regex while = tests exact equality', async () => {
        setTurnVar('val', 'abc123');
        expect(await cond.test('', { expression: 'val matches "[a-z]+"' })).toBe('true');
        expect(await cond.test('', { expression: 'val = "abc123"' })).toBe('true');
        expect(await cond.test('', { expression: 'val = "abc"' })).toBeNull();
    });

    it('is matches a single word while contains matches it as a substring', async () => {
        setTurnVar('tag', 'dragon lord');
        expect(await cond.test('', { expression: 'tag is "dragon"' })).toBeNull();
        expect(await cond.test('', { expression: 'tag contains "dragon"' })).toBe('true');
    });

    it('= and is behave identically for a single exact-match word', async () => {
        setTurnVar('mood', 'happy');
        expect(await cond.test('', { expression: 'mood = "happy"'  })).toBe('true');
        expect(await cond.test('', { expression: 'mood is "happy"' })).toBe('true');
    });
});

// ---------------------------------------------------------------------------
// getLbEntryByName
// ---------------------------------------------------------------------------

describe('getLbEntryByName', () => {
    it('returns null when no entries exist', async () => {
        expect(await getLbEntryByName('Elara Voss')).toBeNull();
    });

    it('returns the matching entry by comment (case insensitive)', async () => {
        const entry = { comment: 'Elara Voss', content: 'An archivist.', disable: false };
        vi.mocked(getSortedEntries).mockResolvedValue([entry]);
        expect(await getLbEntryByName('elara voss')).toBe(entry);
    });

    it('skips disabled entries', async () => {
        const entry = { comment: 'Elara Voss', content: 'An archivist.', disable: true };
        vi.mocked(getSortedEntries).mockResolvedValue([entry]);
        expect(await getLbEntryByName('Elara Voss')).toBeNull();
    });

    it('filters by lbName when provided — loads the named lorebook directly (active or not)', async () => {
        const b = { comment: 'Elara', content: 'B', disable: false };
        vi.mocked(loadWorldInfo).mockImplementation(async name =>
            name === 'LoreB' ? { entries: { 0: b } } : null,
        );
        expect(await getLbEntryByName('Elara', 'LoreB')).toBe(b);
    });
});

// ---------------------------------------------------------------------------
// resolveLbQueryTokens
// ---------------------------------------------------------------------------

describe('resolveLbQueryTokens', () => {
    it('returns the template unchanged when it has no {{lb tokens', async () => {
        expect(await resolveLbQueryTokens('hello {{name}}', {})).toBe('hello {{name}}');
    });

    it('returns the template unchanged when it is empty', async () => {
        expect(await resolveLbQueryTokens('', {})).toBe('');
    });

    it('resolves {{lbTitles}} to a comma-separated list of matching entry titles', async () => {
        const entries = [
            { comment: 'Elara',  disable: false, world: 'Lore' },
            { comment: 'Marcus', disable: false, world: 'Lore' },
        ];
        vi.mocked(getSortedEntries).mockResolvedValue(entries);
        const result = await resolveLbQueryTokens('{{lbTitles:}}', {});
        expect(result).toBe('Elara, Marcus');
    });

    it('resolves {{lbContent:}} to the first matching entry content (default mode is first)', async () => {
        const entries = [
            { comment: 'A', content: 'First content', disable: false, world: 'Lore' },
            { comment: 'B', content: 'Second content', disable: false, world: 'Lore' },
        ];
        vi.mocked(getSortedEntries).mockResolvedValue(entries);
        // Syntax: {{lbContent:lbFilter:titleFilter:keyFilter:mode}}
        // Bare {{lbContent:}} = all filters wildcard, mode defaults to 'first'.
        const result = await resolveLbQueryTokens('{{lbContent:}}', {});
        expect(result).toBe('First content');
    });
});

// ---------------------------------------------------------------------------
// TRIGGER_REGISTRY.event
// ---------------------------------------------------------------------------

describe('TRIGGER_REGISTRY.event', () => {
    const ev = TRIGGER_REGISTRY.event;

    afterEach(() => {
        clearCurrentEvent();
    });

    it('test() returns null when no current event is active', async () => {
        expect(await ev.test('', { event: 'MESSAGE_RECEIVED' })).toBeNull();
    });

    it('test() returns the event name when _currentEvent matches config.event', async () => {
        setCurrentEvent('MESSAGE_RECEIVED');
        expect(await ev.test('', { event: 'MESSAGE_RECEIVED' })).toBe('MESSAGE_RECEIVED');
    });

    it('test() returns null when _currentEvent does not match config.event', async () => {
        setCurrentEvent('GENERATION_STARTED');
        expect(await ev.test('', { event: 'MESSAGE_RECEIVED' })).toBeNull();
    });

    it('test() matches GENERATION_STARTED when set', async () => {
        setCurrentEvent('GENERATION_STARTED');
        expect(await ev.test('', { event: 'GENERATION_STARTED' })).toBe('GENERATION_STARTED');
    });

    it('test() matches CHARACTER_MESSAGE_RENDERED when set', async () => {
        setCurrentEvent('CHARACTER_MESSAGE_RENDERED');
        expect(await ev.test('', { event: 'CHARACTER_MESSAGE_RENDERED' })).toBe('CHARACTER_MESSAGE_RENDERED');
    });

    it('test() returns null when config.event is empty string even if currentEvent is set', async () => {
        setCurrentEvent('MESSAGE_RECEIVED');
        expect(await ev.test('', { event: '' })).toBeNull();
    });

    it('defaultConfig has correct shape', () => {
        expect(ev.defaultConfig).toEqual({ event: 'MESSAGE_RECEIVED' });
    });
});

// ---------------------------------------------------------------------------
// TRIGGER_REGISTRY.badge
// ---------------------------------------------------------------------------

describe('TRIGGER_REGISTRY.badge', () => {
    const badge = TRIGGER_REGISTRY.badge;

    it('test() always returns null — badge never auto-fires', async () => {
        expect(await badge.test('any text', {})).toBeNull();
        expect(await badge.test('', {})).toBeNull();
        expect(await badge.test('keyword', { style: 'inline', keywords: 'keyword' })).toBeNull();
    });

    it('defaultConfig has correct shape', () => {
        const cfg = badge.defaultConfig;
        expect(cfg.style).toBe('top');
        expect(cfg.label).toBe('run');
        expect(cfg.color).toBe('#8888ff');
        expect(cfg.splitOn).toBe('');
        expect(cfg.keywords).toBe('');
        expect(cfg.caseSensitive).toBe(false);
        expect(cfg.clickAction).toBe('fire');
    });
});

