import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../../../../../script.js',         () => ({ name1: 'Alice', name2: 'Bot' }));
vi.mock('../../../../../scripts/openai.js', () => ({ oai_settings: { prompts: [] } }));

vi.mock('../triggers.js', () => ({
    getLbEntryByName:     vi.fn(async () => null),
    resolveLbQueryTokens: vi.fn(async t => t),
    getTurnVarsSnapshot:  vi.fn(() => ({})),
}));

vi.mock('../../../../../scripts/variables.js', () => ({
    getLocalVariable:  vi.fn(() => null),
    getGlobalVariable: vi.fn(() => null),
}));

import { compose } from '../actions/compose.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides = {}) {
    return {
        matchedKeyword: 'dragon',
        messageId:      0,
        stCtx:          { chat: [{ mes: 'A dragon appeared.' }] },
        vars:           {},
        debug:          false,
        highlighted:    '',
        ...overrides,
    };
}

beforeEach(() => { vi.clearAllMocks(); });

// ---------------------------------------------------------------------------
// Guard clauses
// ---------------------------------------------------------------------------

describe('compose — guard clauses', () => {
    it('does nothing when outputVar is empty', async () => {
        const ctx = makeCtx();
        await compose.execute({ outputVar: '', template: 'hello' }, ctx);
        expect(Object.keys(ctx.vars)).toHaveLength(0);
    });

    it('does nothing when vars is null', async () => {
        const ctx = makeCtx({ vars: null });
        await compose.execute({ outputVar: 'x', template: 'hello' }, { ...ctx, vars: null });
        // no throw, no write
    });

    it('writes nothing to unrelated vars keys', async () => {
        const ctx = makeCtx();
        ctx.vars.existing = 'untouched';
        await compose.execute({ outputVar: 'result', template: 'new' }, ctx);
        expect(ctx.vars.existing).toBe('untouched');
    });
});

// ---------------------------------------------------------------------------
// Basic template evaluation
// ---------------------------------------------------------------------------

describe('compose — template evaluation', () => {
    it('writes a literal string to the named variable', async () => {
        const ctx = makeCtx();
        await compose.execute({ outputVar: 'greeting', template: 'hello world' }, ctx);
        expect(ctx.vars.greeting).toBe('hello world');
    });

    it('writes an empty string for a blank template', async () => {
        const ctx = makeCtx();
        await compose.execute({ outputVar: 'x', template: '' }, ctx);
        expect(ctx.vars.x).toBe('');
    });

    it('resolves {{keyword}} to the matched keyword', async () => {
        const ctx = makeCtx({ matchedKeyword: 'dragon' });
        await compose.execute({ outputVar: 'tag', template: 'trigger: {{keyword}}' }, ctx);
        expect(ctx.vars.tag).toBe('trigger: dragon');
    });

    it('resolves {{message}} to the message text', async () => {
        const ctx = makeCtx();
        await compose.execute({ outputVar: 'copy', template: '{{message}}' }, ctx);
        expect(ctx.vars.copy).toBe('A dragon appeared.');
    });

    it('resolves {{char}} to name2', async () => {
        const ctx = makeCtx();
        await compose.execute({ outputVar: 'who', template: '{{char}}' }, ctx);
        expect(ctx.vars.who).toBe('Bot');
    });

    it('resolves {{user}} to name1', async () => {
        const ctx = makeCtx();
        await compose.execute({ outputVar: 'who', template: '{{user}}' }, ctx);
        expect(ctx.vars.who).toBe('Alice');
    });

    it('resolves {{up-to}} to text before the first keyword match', async () => {
        const ctx = makeCtx({ matchedKeyword: 'dragon' });
        await compose.execute({ outputVar: 'prefix', template: '{{up-to}}' }, ctx);
        // 'dragon' starts at index 2 in 'A dragon appeared.' → 'A '
        expect(ctx.vars.prefix).toBe('A ');
    });
});

// ---------------------------------------------------------------------------
// Template with conditional blocks
// ---------------------------------------------------------------------------

describe('compose — conditional blocks', () => {
    it('includes conditional content when condition is true', async () => {
        const ctx = makeCtx({ matchedKeyword: 'dragon' });
        await compose.execute({
            outputVar: 'label',
            template:  '{{if keyword is "dragon"}}beast sighted{{/if}}',
        }, ctx);
        expect(ctx.vars.label).toBe('beast sighted');
    });

    it('excludes conditional content when condition is false', async () => {
        const ctx = makeCtx({ matchedKeyword: 'kitten' });
        await compose.execute({
            outputVar: 'label',
            template:  '{{if keyword is "dragon"}}beast sighted{{/if}}',
        }, ctx);
        expect(ctx.vars.label).toBe('');
    });

    it('can use existing vars in the condition', async () => {
        const ctx = makeCtx();
        ctx.vars.mood = 'happy';
        await compose.execute({
            outputVar: 'result',
            template:  '{{if mood is "happy"}}positive{{/if}}',
        }, ctx);
        expect(ctx.vars.result).toBe('positive');
    });
});

// ---------------------------------------------------------------------------
// Interaction with existing vars
// ---------------------------------------------------------------------------

describe('compose — reads from existing vars', () => {
    it('resolves a prior var referenced in the template', async () => {
        const ctx = makeCtx();
        ctx.vars.hp = '42';
        await compose.execute({ outputVar: 'summary', template: 'hp={{hp}}' }, ctx);
        expect(ctx.vars.summary).toBe('hp=42');
    });

    it('a second compose can read the output of the first', async () => {
        const ctx = makeCtx();
        await compose.execute({ outputVar: 'a', template: 'first' }, ctx);
        await compose.execute({ outputVar: 'b', template: '{{a}} second' }, ctx);
        expect(ctx.vars.b).toBe('first second');
    });

    it('overwrites the variable on a second compose to the same name', async () => {
        const ctx = makeCtx();
        await compose.execute({ outputVar: 'x', template: 'old' }, ctx);
        await compose.execute({ outputVar: 'x', template: 'new' }, ctx);
        expect(ctx.vars.x).toBe('new');
    });
});

// ---------------------------------------------------------------------------
// preview()
// ---------------------------------------------------------------------------

describe('compose — preview', () => {
    it('returns a hint when outputVar is empty', async () => {
        const result = await compose.preview({ outputVar: '', template: 'hello' }, 'some text');
        expect(result.hint).toBeTruthy();
    });

    it('resolves the template against the given text without writing any vars', async () => {
        const result = await compose.preview({ outputVar: 'tag', template: 'seen: {{message}}' }, 'A dragon appeared.');
        expect(result.output).toBe('tag =\nseen: A dragon appeared.');
    });

    it('resolves {{keyword}} to empty since preview has no live trigger match', async () => {
        const result = await compose.preview({ outputVar: 'tag', template: 'kw={{keyword}}' }, 'A dragon appeared.');
        expect(result.output).toBe('tag =\nkw=');
    });
});
