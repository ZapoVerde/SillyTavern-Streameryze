import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Hoisted mock state for prompt-slot (ps) token tests.
// vi.hoisted ensures these arrays exist before any vi.mock factory runs.
const { MOCK_MESSAGES, MOCK_OAI_SETTINGS } = vi.hoisted(() => ({
    MOCK_MESSAGES:     [],
    MOCK_OAI_SETTINGS: { prompts: [] },
}));

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

// Mock ST core files imported by template.js for prompt-slot resolution.
// promptManager.messages.flatten() returns the live MOCK_MESSAGES array so
// tests can mutate it via setupPs() without needing to replace the mock object.
vi.mock('../../../../../scripts/openai.js', () => ({
    oai_settings:  MOCK_OAI_SETTINGS,
    promptManager: { messages: { flatten: () => MOCK_MESSAGES } },
}));

import { interpolate, getTemplateTier, resolveLbTokens } from '../actions/template.js';
import { getLocalVariable, getGlobalVariable }           from '../../../../../scripts/variables.js';

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
// resolveLbTokens — {{psName}} / {{psContent}} prompt-slot tokens
// ---------------------------------------------------------------------------

// Fixtures — five-entry rawPrompt with a mix of system, CNZ, and chat slots.
// chatHistory-0 intentionally has no def entry to exercise the identifier fallback.
const PS_RAW_PROMPT = [
    { role: 'system', content: 'You are an AI.',     identifier: 'main'           },
    { role: 'system', content: 'World info before.', identifier: 'worldInfoBefore' },
    { role: 'system', content: 'World info after.',  identifier: 'worldInfoAfter'  },
    { role: 'system', content: 'RAG content here.',  identifier: 'cnz_rag'         },
    { role: 'user',   content: 'Hello!',             identifier: 'chatHistory-0'   },
];

const PS_DEFS = [
    { identifier: 'main',            name: 'Main Prompt'       },
    { identifier: 'worldInfoBefore', name: 'World Info (Before)' },
    { identifier: 'worldInfoAfter',  name: 'World Info (After)'  },
    { identifier: 'cnz_rag',         name: 'CNZ RAG'            },
    // no def for chatHistory-0 — identifier used as fallback name
];

const PS_MES_ID = 5;

function setupPs(messages = PS_RAW_PROMPT, defs = PS_DEFS) {
    MOCK_MESSAGES.length = 0;
    MOCK_MESSAGES.push(...messages);
    MOCK_OAI_SETTINGS.prompts.length = 0;
    MOCK_OAI_SETTINGS.prompts.push(...defs);
}

// ---------------------------------------------------------------------------
// No-op cases
// ---------------------------------------------------------------------------

describe('resolveLbTokens — {{ps...}} no-op cases', () => {
    it('returns template unchanged when no {{ps token is present', async () => {
        setupPs();
        expect(await resolveLbTokens('hello {{name}}', '', '', {}, PS_MES_ID)).toBe('hello {{name}}');
    });

    it('returns ps token unchanged when messageId is null', async () => {
        setupPs();
        expect(await resolveLbTokens('{{psContent}}', '', '', {}, null)).toBe('{{psContent}}');
    });

    it('returns ps token unchanged when messageId is undefined', async () => {
        setupPs();
        expect(await resolveLbTokens('{{psContent}}', '', '', {}, undefined)).toBe('{{psContent}}');
    });

    it('returns empty string when promptManager has no messages', async () => {
        setupPs([], []);
        expect(await resolveLbTokens('{{psContent}}', '', '', {}, PS_MES_ID)).toBe('');
    });
});

// ---------------------------------------------------------------------------
// {{psName}} — name retrieval
// ---------------------------------------------------------------------------

describe('{{psName}} — name retrieval', () => {
    beforeEach(() => setupPs());

    it('bare token returns all slot names newline-separated (default mode: all)', async () => {
        const result = await resolveLbTokens('{{psName}}', '', '', {}, PS_MES_ID);
        expect(result).toBe('Main Prompt\nWorld Info (Before)\nWorld Info (After)\nCNZ RAG\nchatHistory-0');
    });

    it('first mode returns only the first name', async () => {
        expect(await resolveLbTokens('{{psName::first}}', '', '', {}, PS_MES_ID)).toBe('Main Prompt');
    });

    it('last mode returns only the last name', async () => {
        expect(await resolveLbTokens('{{psName::last}}', '', '', {}, PS_MES_ID)).toBe('chatHistory-0');
    });

    it('filter by identifier literal returns the display name from defs', async () => {
        expect(await resolveLbTokens('{{psName:[cnz_rag]}}', '', '', {}, PS_MES_ID)).toBe('CNZ RAG');
    });

    it('filter by display name literal also resolves via defs', async () => {
        expect(await resolveLbTokens('{{psName:[CNZ RAG]}}', '', '', {}, PS_MES_ID)).toBe('CNZ RAG');
    });

    it('glob on identifier matches multiple entries', async () => {
        const result = await resolveLbTokens('{{psName:[worldInfo*]}}', '', '', {}, PS_MES_ID);
        expect(result).toBe('World Info (Before)\nWorld Info (After)');
    });

    it('unrecognised literal returns empty string', async () => {
        expect(await resolveLbTokens('{{psName:[NoSuchSlot]}}', '', '', {}, PS_MES_ID)).toBe('');
    });

    it('falls back to identifier as name when no def exists for the entry', async () => {
        expect(await resolveLbTokens('{{psName:[chatHistory-0]}}', '', '', {}, PS_MES_ID))
            .toBe('chatHistory-0');
    });
});

// ---------------------------------------------------------------------------
// {{psContent}} — content retrieval
// ---------------------------------------------------------------------------

describe('{{psContent}} — content retrieval', () => {
    beforeEach(() => setupPs());

    it('bare token returns the first slot content (default mode: first)', async () => {
        expect(await resolveLbTokens('{{psContent}}', '', '', {}, PS_MES_ID)).toBe('You are an AI.');
    });

    it('explicit first mode matches implicit default', async () => {
        expect(await resolveLbTokens('{{psContent::first}}', '', '', {}, PS_MES_ID)).toBe('You are an AI.');
    });

    it('last mode returns the final slot content', async () => {
        expect(await resolveLbTokens('{{psContent::last}}', '', '', {}, PS_MES_ID)).toBe('Hello!');
    });

    it('all mode joins all slot contents with a blank line', async () => {
        const result = await resolveLbTokens('{{psContent::all}}', '', '', {}, PS_MES_ID);
        expect(result).toBe(
            'You are an AI.\n\nWorld info before.\n\nWorld info after.\n\nRAG content here.\n\nHello!',
        );
    });

    it('filter by identifier returns that slot\'s content', async () => {
        expect(await resolveLbTokens('{{psContent:[cnz_rag]}}', '', '', {}, PS_MES_ID))
            .toBe('RAG content here.');
    });

    it('filter by display name matches via oai_settings defs', async () => {
        expect(await resolveLbTokens('{{psContent:[CNZ RAG]}}', '', '', {}, PS_MES_ID))
            .toBe('RAG content here.');
    });

    it('filter by display name with explicit first mode', async () => {
        expect(await resolveLbTokens('{{psContent:[Main Prompt]:first}}', '', '', {}, PS_MES_ID))
            .toBe('You are an AI.');
    });

    it('glob filter with all mode joins multiple matching contents', async () => {
        const result = await resolveLbTokens('{{psContent:[worldInfo*]:all}}', '', '', {}, PS_MES_ID);
        expect(result).toBe('World info before.\n\nWorld info after.');
    });

    it('unmatched filter returns empty string', async () => {
        expect(await resolveLbTokens('{{psContent:[NoSuchSlot]}}', '', '', {}, PS_MES_ID)).toBe('');
    });

    it('entries with empty content are excluded from results', async () => {
        setupPs([
            { role: 'system', content: '',      identifier: 'main'           },
            { role: 'system', content: 'Real.', identifier: 'worldInfoBefore' },
        ]);
        expect(await resolveLbTokens('{{psContent}}', '', '', {}, PS_MES_ID)).toBe('Real.');
    });
});

// ---------------------------------------------------------------------------
// Variable substitution in filter args
// ---------------------------------------------------------------------------

describe('{{ps...}} — variable substitution in filter args', () => {
    beforeEach(() => setupPs());

    it('bare word in filter resolves to identifier from vars', async () => {
        const result = await resolveLbTokens('{{psContent:mySlot}}', '', '', { mySlot: 'cnz_rag' }, PS_MES_ID);
        expect(result).toBe('RAG content here.');
    });

    it('var resolving to a display name also matches via defs', async () => {
        const result = await resolveLbTokens('{{psContent:mySlot}}', '', '', { mySlot: 'CNZ RAG' }, PS_MES_ID);
        expect(result).toBe('RAG content here.');
    });

    it('unresolved var (not in snapshot) matches nothing', async () => {
        expect(await resolveLbTokens('{{psContent:mySlot}}', '', '', {}, PS_MES_ID)).toBe('');
    });

    it('[bracket] literal is treated as a literal value, not a var name', async () => {
        expect(await resolveLbTokens('{{psContent:[cnz_rag]}}', '', '', {}, PS_MES_ID))
            .toBe('RAG content here.');
    });
});

// ---------------------------------------------------------------------------
// Multiple tokens in one template
// ---------------------------------------------------------------------------

describe('{{ps...}} — multiple tokens in one template', () => {
    beforeEach(() => setupPs());

    it('psName and psContent tokens resolve independently in the same template', async () => {
        const result = await resolveLbTokens(
            'Names: {{psName:[cnz_rag]}} | Content: {{psContent:[cnz_rag]}}',
            '', '', {}, PS_MES_ID,
        );
        expect(result).toBe('Names: CNZ RAG | Content: RAG content here.');
    });

    it('surrounding text is preserved exactly', async () => {
        const result = await resolveLbTokens(
            'Preamble. {{psContent:[main]}} Postamble.',
            '', '', {}, PS_MES_ID,
        );
        expect(result).toBe('Preamble. You are an AI. Postamble.');
    });

    it('unresolved token leaves empty string in place', async () => {
        const result = await resolveLbTokens(
            'before {{psContent:[Ghost]}} after',
            '', '', {}, PS_MES_ID,
        );
        expect(result).toBe('before  after');
    });
});

// ---------------------------------------------------------------------------
// {{psRows}} — TSV data source
// ---------------------------------------------------------------------------

describe('{{psRows}} — all slots', () => {
    beforeEach(() => setupPs());

    it('bare token outputs all slots as displayName<TAB>charCount rows', async () => {
        const result = await resolveLbTokens('{{psRows}}', '', '', {}, PS_MES_ID);
        expect(result).toBe(
            'Main Prompt\t14\nWorld Info (Before)\t18\nWorld Info (After)\t17\nCNZ RAG\t17\nchatHistory-0\t6',
        );
    });

    it('literal filter by identifier returns the matching row with display name', async () => {
        expect(await resolveLbTokens('{{psRows:[cnz_rag]}}', '', '', {}, PS_MES_ID))
            .toBe('CNZ RAG\t17');
    });

    it('outputs display name (not identifier) in the first column even when matched by display name', async () => {
        expect(await resolveLbTokens('{{psRows:[CNZ RAG]}}', '', '', {}, PS_MES_ID))
            .toBe('CNZ RAG\t17');
    });

    it('glob filter on identifier returns all matching rows with display names', async () => {
        expect(await resolveLbTokens('{{psRows:[worldInfo*]}}', '', '', {}, PS_MES_ID))
            .toBe('World Info (Before)\t18\nWorld Info (After)\t17');
    });

    it('var filter resolves identifier from turn vars and returns display name', async () => {
        const result = await resolveLbTokens('{{psRows:mySlot}}', '', '', { mySlot: 'cnz_rag' }, PS_MES_ID);
        expect(result).toBe('CNZ RAG\t17');
    });

    it('unrecognised literal returns empty string', async () => {
        expect(await resolveLbTokens('{{psRows:[ghost]}}', '', '', {}, PS_MES_ID)).toBe('');
    });

    it('exclusion filter !pattern omits matching rows', async () => {
        expect(await resolveLbTokens('{{psRows:[!worldInfo*]}}', '', '', {}, PS_MES_ID))
            .toBe('Main Prompt\t14\nCNZ RAG\t17\nchatHistory-0\t6');
    });

    it('exclusion-only filter passes everything not excluded', async () => {
        expect(await resolveLbTokens('{{psRows:[!main]}}', '', '', {}, PS_MES_ID))
            .toBe('World Info (Before)\t18\nWorld Info (After)\t17\nCNZ RAG\t17\nchatHistory-0\t6');
    });

    it('preserves surrounding template text', async () => {
        expect(await resolveLbTokens('Slots:\n{{psRows:[main]}}', '', '', {}, PS_MES_ID))
            .toBe('Slots:\nMain Prompt\t14');
    });
});

describe('{{psRows}} — no-op and edge cases', () => {
    it('returns token unchanged when messageId is null', async () => {
        setupPs();
        expect(await resolveLbTokens('{{psRows}}', '', '', {}, null)).toBe('{{psRows}}');
    });

    it('returns token unchanged when messageId is undefined', async () => {
        setupPs();
        expect(await resolveLbTokens('{{psRows}}', '', '', {}, undefined)).toBe('{{psRows}}');
    });

    it('returns empty string when messages is empty', async () => {
        setupPs([], PS_DEFS);
        expect(await resolveLbTokens('{{psRows}}', '', '', {}, PS_MES_ID)).toBe('');
    });

    it('excludes slots with empty content from results', async () => {
        setupPs([
            { role: 'system', content: '',       identifier: 'main'    },
            { role: 'system', content: 'Hello.', identifier: 'cnz_rag' },
        ]);
        expect(await resolveLbTokens('{{psRows}}', '', '', {}, PS_MES_ID))
            .toBe('CNZ RAG\t6');
    });
});

// ---------------------------------------------------------------------------
// {{psMaxNameLen}} — longest display name length
// ---------------------------------------------------------------------------

describe('{{psMaxNameLen}} — longest display name length', () => {
    beforeEach(() => setupPs());

    it('bare token returns max name length across all slots', async () => {
        // Names: 'Main Prompt'(11), 'World Info (Before)'(19), 'World Info (After)'(18),
        //        'CNZ RAG'(7), 'chatHistory-0'(13) — max = 19
        expect(await resolveLbTokens('{{psMaxNameLen}}', '', '', {}, PS_MES_ID)).toBe('19');
    });

    it('exclusion filter returns max of remaining names', async () => {
        // Excluding chatHistory-0 (13): max of 11, 19, 18, 7 = 19
        expect(await resolveLbTokens('{{psMaxNameLen:[!chatHistory*]}}', '', '', {}, PS_MES_ID)).toBe('19');
    });

    it('glob filter returns max within the matching set', async () => {
        // worldInfo*: 'World Info (Before)'(19), 'World Info (After)'(18) — max = 19
        expect(await resolveLbTokens('{{psMaxNameLen:[worldInfo*]}}', '', '', {}, PS_MES_ID)).toBe('19');
    });

    it('single-slot filter returns that name length', async () => {
        // 'CNZ RAG' = 7
        expect(await resolveLbTokens('{{psMaxNameLen:[cnz_rag]}}', '', '', {}, PS_MES_ID)).toBe('7');
    });

    it('unmatched filter returns 0', async () => {
        expect(await resolveLbTokens('{{psMaxNameLen:[ghost]}}', '', '', {}, PS_MES_ID)).toBe('0');
    });

    it('returns token unchanged when messageId is null', async () => {
        expect(await resolveLbTokens('{{psMaxNameLen}}', '', '', {}, null)).toBe('{{psMaxNameLen}}');
    });

    it('returns 0 when messages is empty', async () => {
        setupPs([], PS_DEFS);
        expect(await resolveLbTokens('{{psMaxNameLen}}', '', '', {}, PS_MES_ID)).toBe('0');
    });
});

// ---------------------------------------------------------------------------
// {{psCharSum}} — aggregate character count
// ---------------------------------------------------------------------------

describe('{{psCharSum}} — aggregate character count', () => {
    beforeEach(() => setupPs());

    it('bare token sums all slot char counts', async () => {
        // 14 + 18 + 17 + 17 + 6 = 72
        expect(await resolveLbTokens('{{psCharSum}}', '', '', {}, PS_MES_ID)).toBe('72');
    });

    it('filter by glob returns summed count for matching slots', async () => {
        expect(await resolveLbTokens('{{psCharSum:[chatHistory*]}}', '', '', {}, PS_MES_ID)).toBe('6');
    });

    it('filter by identifier literal sums just that slot', async () => {
        expect(await resolveLbTokens('{{psCharSum:[cnz_rag]}}', '', '', {}, PS_MES_ID)).toBe('17');
    });

    it('exclusion filter sums everything not excluded', async () => {
        // all (72) minus chatHistory-0 (6) = 66
        expect(await resolveLbTokens('{{psCharSum:[!chatHistory*]}}', '', '', {}, PS_MES_ID)).toBe('66');
    });

    it('unmatched filter returns 0', async () => {
        expect(await resolveLbTokens('{{psCharSum:[ghost]}}', '', '', {}, PS_MES_ID)).toBe('0');
    });

    it('returns token unchanged when messageId is null', async () => {
        expect(await resolveLbTokens('{{psCharSum:[chatHistory*]}}', '', '', {}, null))
            .toBe('{{psCharSum:[chatHistory*]}}');
    });

    it('returns token unchanged when messageId is undefined', async () => {
        expect(await resolveLbTokens('{{psCharSum:[chatHistory*]}}', '', '', {}, undefined))
            .toBe('{{psCharSum:[chatHistory*]}}');
    });

    it('returns 0 when messages is empty', async () => {
        setupPs([], PS_DEFS);
        expect(await resolveLbTokens('{{psCharSum}}', '', '', {}, PS_MES_ID)).toBe('0');
    });

    it('can be used inline alongside other text', async () => {
        const result = await resolveLbTokens('total: {{psCharSum:[chatHistory*]}} chars', '', '', {}, PS_MES_ID);
        expect(result).toBe('total: 6 chars');
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
