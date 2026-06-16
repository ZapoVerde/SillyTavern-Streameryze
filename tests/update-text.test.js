import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../../../../../script.js', () => ({
    eventSource:        { emit: vi.fn() },
    event_types:        { MESSAGE_UPDATED: 'MESSAGE_UPDATED', WORLDINFO_UPDATED: 'WORLDINFO_UPDATED' },
    name1:              'Alice',
    name2:              'Bot',
    addOneMessage:      vi.fn(),
    updateMessageBlock: vi.fn(),
    getRequestHeaders:  vi.fn(() => ({})),
}));
vi.mock('../../../../../scripts/openai.js', () => ({ oai_settings: { prompts: [] } }));

// lorebookApi.js must be mocked so update.js can import it (lorebook path unused here)
vi.mock('../lorebookApi.js', () => ({
    lbGetLorebook:  vi.fn(async () => ({ entries: {} })),
    lbSaveLorebook: vi.fn(async () => {}),
}));

vi.mock('../triggers.js', () => ({
    clearWiCache:         vi.fn(),
    getLbEntryByName:     vi.fn(async () => null),
    resolveLbQueryTokens: vi.fn(async t => t),
    getTurnVarsSnapshot:  vi.fn(() => ({})),
}));

vi.mock('../../../../../scripts/variables.js', () => ({
    getLocalVariable:  vi.fn(() => null),
    getGlobalVariable: vi.fn(() => null),
}));

import { update }                               from '../actions/update.js';
import { updateMessageBlock, addOneMessage, eventSource } from '../../../../../script.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMsg(mes, name = 'Char') {
    return { mes, name, is_user: false, is_system: false };
}

function makeCtx(mes, overrides = {}) {
    const msg = makeMsg(mes);
    return {
        target:         'text',
        matchedKeyword: 'dragon',
        messageId:      0,
        stCtx: {
            chat:     [msg],
            saveChat: vi.fn(async () => {}),
        },
        vars:                {},
        debug:               false,
        highlighted:         '',
        isCurrentGeneration: () => true,
        ...overrides,
    };
}

function textConfig(mode, value, overrides = {}) {
    return { target: 'text', mode, value, ...overrides };
}

beforeEach(() => { vi.clearAllMocks(); });

// ---------------------------------------------------------------------------
// Guard clause
// ---------------------------------------------------------------------------

describe('update (text) — guard clause', () => {
    it('does nothing when no message exists at messageId', async () => {
        const ctx = makeCtx('text');
        ctx.stCtx.chat = [];
        await update.execute(textConfig('replaceKeyword', 'X'), ctx);
        expect(updateMessageBlock).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// replaceKeyword mode
// ---------------------------------------------------------------------------

describe('update (text) — replaceKeyword', () => {
    it('replaces the matched keyword with the value', async () => {
        const ctx = makeCtx('A dragon roared.');
        await update.execute(textConfig('replaceKeyword', 'beast'), ctx);
        expect(ctx.stCtx.chat[0].mes).toBe('A beast roared.');
    });

    it('replaces ALL occurrences (global flag)', async () => {
        const ctx = makeCtx('dragon and dragon.');
        await update.execute(textConfig('replaceKeyword', 'serpent'), ctx);
        expect(ctx.stCtx.chat[0].mes).toBe('serpent and serpent.');
    });

    it('replacement is case-insensitive', async () => {
        const ctx = makeCtx('A DRAGON appeared.');
        await update.execute(textConfig('replaceKeyword', 'beast'), ctx);
        expect(ctx.stCtx.chat[0].mes).toBe('A beast appeared.');
    });

    it('resolves {{keyword}} inside the value', async () => {
        const ctx = makeCtx('A dragon roared.', { matchedKeyword: 'dragon' });
        await update.execute(textConfig('replaceKeyword', '[{{keyword}}]'), ctx);
        expect(ctx.stCtx.chat[0].mes).toBe('A [dragon] roared.');
    });

    it('calls updateMessageBlock, saveChat, and emits MESSAGE_UPDATED', async () => {
        const ctx = makeCtx('A dragon roared.');
        await update.execute(textConfig('replaceKeyword', 'beast'), ctx);
        expect(updateMessageBlock).toHaveBeenCalledWith(0, ctx.stCtx.chat[0]);
        expect(ctx.stCtx.saveChat).toHaveBeenCalledOnce();
        expect(eventSource.emit).toHaveBeenCalledWith('MESSAGE_UPDATED', 0);
    });

    it('does not call save when isCurrentGeneration returns false', async () => {
        const ctx = makeCtx('A dragon roared.', { isCurrentGeneration: () => false });
        await update.execute(textConfig('replaceKeyword', 'beast'), ctx);
        expect(updateMessageBlock).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// replaceParagraph mode
// ---------------------------------------------------------------------------

describe('update (text) — replaceParagraph', () => {
    it('replaces the entire paragraph containing the keyword', async () => {
        const ctx = makeCtx('A dragon roared.\nA knight rode.');
        await update.execute(textConfig('replaceParagraph', '[replaced]'), ctx);
        // 'dragon' is in the first paragraph; that paragraph is replaced
        expect(ctx.stCtx.chat[0].mes).toBe('[replaced]\nA knight rode.');
    });

    it('replaces multiple paragraphs when the keyword appears in each', async () => {
        const ctx = makeCtx('dragon here.\nanother dragon.\nno match here.');
        await update.execute(textConfig('replaceParagraph', 'X'), ctx);
        expect(ctx.stCtx.chat[0].mes).toBe('X\nX\nno match here.');
    });

    it('does nothing when the keyword is not in the message', async () => {
        const ctx = makeCtx('A knight rode.\nNo match here.');
        await update.execute(textConfig('replaceParagraph', 'X'), ctx);
        // no change → save not called
        expect(updateMessageBlock).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// appendToMessage mode
// ---------------------------------------------------------------------------

describe('update (text) — appendToMessage', () => {
    it('appends the value after a double newline', async () => {
        const ctx = makeCtx('Original text.');
        await update.execute(textConfig('appendToMessage', 'Appended.'), ctx);
        expect(ctx.stCtx.chat[0].mes).toBe('Original text.\n\nAppended.');
    });

    it('always appends even when keyword is not in the message', async () => {
        const ctx = makeCtx('No match here.', { matchedKeyword: 'dragon' });
        await update.execute(textConfig('appendToMessage', 'Appended.'), ctx);
        expect(ctx.stCtx.chat[0].mes).toBe('No match here.\n\nAppended.');
    });

    it('resolves {{keyword}} inside the appended value', async () => {
        const ctx = makeCtx('Text.', { matchedKeyword: 'dragon' });
        await update.execute(textConfig('appendToMessage', 'Keyword: {{keyword}}'), ctx);
        expect(ctx.stCtx.chat[0].mes).toBe('Text.\n\nKeyword: dragon');
    });

    it('calls updateMessageBlock and saveChat', async () => {
        const ctx = makeCtx('Text.');
        await update.execute(textConfig('appendToMessage', 'More.'), ctx);
        expect(updateMessageBlock).toHaveBeenCalledOnce();
        expect(ctx.stCtx.saveChat).toHaveBeenCalledOnce();
    });
});

// ---------------------------------------------------------------------------
// insertMessage mode
// ---------------------------------------------------------------------------

describe('update (text) — insertMessage', () => {
    it('inserts a new message into stCtx.chat after messageId', async () => {
        const ctx = makeCtx('Original.');
        await update.execute(textConfig('insertMessage', 'New message.'), ctx);
        expect(ctx.stCtx.chat).toHaveLength(2);
        expect(ctx.stCtx.chat[1].mes).toBe('New message.');
    });

    it('new message is not a user message and not a system message', async () => {
        const ctx = makeCtx('Original.');
        await update.execute(textConfig('insertMessage', 'Hello.'), ctx);
        const newMsg = ctx.stCtx.chat[1];
        expect(newMsg.is_user).toBe(false);
        expect(newMsg.is_system).toBe(false);
    });

    it('new message name is name2 (Bot)', async () => {
        const ctx = makeCtx('Original.');
        await update.execute(textConfig('insertMessage', 'Hello.'), ctx);
        expect(ctx.stCtx.chat[1].name).toBe('Bot');
    });

    it('calls addOneMessage with the new message and insertAfter option', async () => {
        const ctx = makeCtx('Original.');
        await update.execute(textConfig('insertMessage', 'Hello.'), ctx);
        expect(addOneMessage).toHaveBeenCalledWith(
            expect.objectContaining({ mes: 'Hello.' }),
            expect.objectContaining({ insertAfter: 0 }),
        );
    });

    it('calls saveChat after inserting', async () => {
        const ctx = makeCtx('Original.');
        await update.execute(textConfig('insertMessage', 'Hello.'), ctx);
        expect(ctx.stCtx.saveChat).toHaveBeenCalledOnce();
    });

    it('resolves {{keyword}} in the inserted message value', async () => {
        const ctx = makeCtx('Text.', { matchedKeyword: 'dragon' });
        await update.execute(textConfig('insertMessage', 'A {{keyword}} was seen.'), ctx);
        expect(ctx.stCtx.chat[1].mes).toBe('A dragon was seen.');
    });
});
