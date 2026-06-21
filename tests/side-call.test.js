import { vi, describe, it, expect, beforeEach } from 'vitest';

if (typeof window === 'undefined') global.window = {};

vi.mock('../../../../../script.js', () => ({
    name1:              'Alice',
    name2:              'Bot',
    eventSource:        { emit: vi.fn() },
    event_types:        { MESSAGE_UPDATED: 'MESSAGE_UPDATED' },
    addOneMessage:      vi.fn(),
    updateMessageBlock: vi.fn(),
}));

vi.mock('../../../shared.js', () => ({
    ConnectionManagerRequestService: { getSupportedProfiles: vi.fn(() => []) },
}));

const { dispatchMock, getPrefetchedMock } = vi.hoisted(() => ({
    dispatchMock:         vi.fn(async () => 'LLM result'),
    getPrefetchedMock:    vi.fn(() => null),
}));

vi.mock('../actions/dispatch.js', () => ({
    dispatch:              dispatchMock,
    getPrefetchedResults:  getPrefetchedMock,
}));

vi.mock('../actions/template.js', () => ({
    interpolate:           vi.fn((tpl, sys, vars) => {
        // Very simple token substitution for testing
        return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => sys?.[k] ?? vars?.[k] ?? `{{${k}}}`);
    }),
    resolveLbTokens:       vi.fn(async s => s),
    resolveHistoryTokens:  vi.fn(s => s),
}));

vi.mock('../actions/text.js', () => ({
    esc:                      vi.fn(s => String(s ?? '')),
    runQueued:                vi.fn(async fns => Promise.all(fns.map(f => f()))),
    extractParagraph:         vi.fn((_text, idx) => ({ text: 'paragraph text', start: 0, end: 14 })),
    collectUniqueParagraphs:  vi.fn(() => [{ text: 'paragraph text', start: 0, end: 14 }]),
}));

vi.mock('../logger.js',          () => ({ trgError: vi.fn(), trgDev: vi.fn() }));
vi.mock('../actions/var-legend.js', () => ({ renderVarLegend: vi.fn(() => '') }));

import { sideCall }            from '../actions/side-call.js';
import { dispatch }            from '../actions/dispatch.js';
import { updateMessageBlock, addOneMessage, eventSource } from '../../../../../script.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(mesText = 'A dragon appeared.', overrides = {}) {
    const msg   = { mes: mesText, name: 'Bot', is_user: false };
    const stCtx = { chat: [msg], saveChat: vi.fn(async () => {}) };
    return {
        matchedKeyword:      'dragon',
        messageId:           0,
        stCtx,
        vars:                {},
        ruleId:              'r1',
        actionIdx:           0,
        debug:               false,
        highlighted:         '',
        isCurrentGeneration: () => true,
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    dispatchMock.mockResolvedValue('LLM result');
    getPrefetchedMock.mockReturnValue(null);
});

// ---------------------------------------------------------------------------
// Guard conditions
// ---------------------------------------------------------------------------

describe('sideCall — guard conditions', () => {
    it('does nothing when the prompt resolves to an empty string', async () => {
        const ctx = makeCtx('A dragon appeared.');
        await sideCall.execute({ prompt: '', outputMode: 'replaceKeyword' }, ctx);
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('does nothing when isCurrentGeneration returns false after dispatch', async () => {
        let flipped = false;
        dispatchMock.mockImplementation(async () => { flipped = true; return 'text'; });
        const ctx = makeCtx('A dragon appeared.', {
            isCurrentGeneration: () => !flipped,
        });
        await sideCall.execute({ prompt: 'Tell me about {{keyword}}', outputMode: 'replaceKeyword' }, ctx);
        expect(updateMessageBlock).not.toHaveBeenCalled();
    });

    it('does nothing when dispatch returns empty string', async () => {
        dispatchMock.mockResolvedValue('');
        const ctx = makeCtx('A dragon appeared.');
        await sideCall.execute({ prompt: 'Describe {{keyword}}', outputMode: 'replaceKeyword' }, ctx);
        expect(updateMessageBlock).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// once mode — output modes
// ---------------------------------------------------------------------------

describe('sideCall — replaceKeyword (once)', () => {
    it('replaces all keyword occurrences in the message', async () => {
        dispatchMock.mockResolvedValue('wyvern');
        const ctx = makeCtx('A dragon and another dragon appeared.');
        await sideCall.execute({ prompt: 'Synonym for {{keyword}}', outputMode: 'replaceKeyword', callMode: 'once' }, ctx);
        expect(ctx.stCtx.chat[0].mes).toBe('A wyvern and another wyvern appeared.');
    });

    it('calls updateMessageBlock after replacing', async () => {
        const ctx = makeCtx('A dragon appeared.');
        await sideCall.execute({ prompt: 'Describe {{keyword}}', outputMode: 'replaceKeyword', callMode: 'once' }, ctx);
        expect(updateMessageBlock).toHaveBeenCalledWith(0, ctx.stCtx.chat[0]);
    });

    it('stores result in outputVar when set', async () => {
        dispatchMock.mockResolvedValue('fierce beast');
        const ctx = makeCtx('A dragon appeared.');
        await sideCall.execute({ prompt: 'Describe {{keyword}}', outputMode: 'replaceKeyword', callMode: 'once', outputVar: 'desc' }, ctx);
        expect(ctx.vars.desc).toBe('fierce beast');
    });
});

describe('sideCall — silent (once)', () => {
    it('stores result in outputVar without touching the message', async () => {
        dispatchMock.mockResolvedValue('fierce');
        const ctx = makeCtx('A dragon appeared.');
        await sideCall.execute({ prompt: 'One word for {{keyword}}', outputMode: 'silent', callMode: 'once', outputVar: 'mood' }, ctx);
        expect(ctx.vars.mood).toBe('fierce');
        expect(updateMessageBlock).not.toHaveBeenCalled();
        expect(ctx.stCtx.chat[0].mes).toBe('A dragon appeared.');
    });

    it('does not mutate message even without an outputVar', async () => {
        const ctx = makeCtx('A dragon appeared.');
        await sideCall.execute({ prompt: 'Describe {{keyword}}', outputMode: 'silent', callMode: 'once' }, ctx);
        expect(ctx.stCtx.chat[0].mes).toBe('A dragon appeared.');
    });
});

describe('sideCall — appendToMessage (once)', () => {
    it('appends the result to the message with double newline', async () => {
        dispatchMock.mockResolvedValue('The dragon was defeated.');
        const ctx = makeCtx('A dragon appeared.');
        await sideCall.execute({ prompt: 'Narrate', outputMode: 'appendToMessage', callMode: 'once' }, ctx);
        expect(ctx.stCtx.chat[0].mes).toBe('A dragon appeared.\n\nThe dragon was defeated.');
    });

    it('calls updateMessageBlock after appending', async () => {
        const ctx = makeCtx('A dragon appeared.');
        await sideCall.execute({ prompt: 'Narrate', outputMode: 'appendToMessage', callMode: 'once' }, ctx);
        expect(updateMessageBlock).toHaveBeenCalledOnce();
    });
});

describe('sideCall — insertMessage (once)', () => {
    it('inserts a new message after the current one', async () => {
        dispatchMock.mockResolvedValue('Narrator: The dragon fled.');
        const ctx = makeCtx('A dragon appeared.');
        await sideCall.execute({ prompt: 'Narrate', outputMode: 'insertMessage', callMode: 'once' }, ctx);
        expect(addOneMessage).toHaveBeenCalledOnce();
        expect(ctx.stCtx.chat).toHaveLength(2);
        expect(ctx.stCtx.chat[1].mes).toBe('Narrator: The dragon fled.');
    });

    it('new message is inserted at messageId + 1', async () => {
        dispatchMock.mockResolvedValue('Appended.');
        const ctx = makeCtx('A dragon appeared.');
        await sideCall.execute({ prompt: 'Narrate', outputMode: 'insertMessage', callMode: 'once' }, ctx);
        expect(ctx.stCtx.chat[1]).toBeDefined();
        expect(ctx.stCtx.chat[1].is_user).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Prefetch cache
// ---------------------------------------------------------------------------

describe('sideCall — prefetch cache', () => {
    it('uses a prefetched promise instead of calling dispatch', async () => {
        getPrefetchedMock.mockReturnValue([Promise.resolve('cached result')]);
        const ctx = makeCtx('A dragon appeared.');
        await sideCall.execute({ prompt: 'Describe {{keyword}}', outputMode: 'replaceKeyword', callMode: 'once' }, ctx);
        expect(dispatch).not.toHaveBeenCalled();
        expect(ctx.stCtx.chat[0].mes).toBe('A cached result appeared.');
    });
});

// ---------------------------------------------------------------------------
// replaceParagraph (once)
// ---------------------------------------------------------------------------

describe('sideCall — replaceParagraph (once)', () => {
    it('replaces the paragraph containing the keyword', async () => {
        dispatchMock.mockResolvedValue('New paragraph text.');
        const ctx = makeCtx('A dragon appeared.\nMore text.');
        await sideCall.execute({ prompt: 'Rewrite', outputMode: 'replaceParagraph', callMode: 'once' }, ctx);
        expect(dispatch).toHaveBeenCalledOnce();
    });
});
