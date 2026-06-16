import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../../../../../script.js', () => ({
    eventSource:        { emit: vi.fn() },
    event_types:        { MESSAGE_UPDATED: 'MESSAGE_UPDATED' },
    updateMessageBlock: vi.fn(),
}));
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

import { replace }                         from '../actions/replace.js';
import { updateMessageBlock, eventSource } from '../../../../../script.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(mesText, overrides = {}) {
    const msg = { mes: mesText, name: 'Char', is_user: false };
    return {
        matchedKeyword: 'dragon',
        messageId:      0,
        stCtx:          {
            chat:     [msg],
            saveChat: vi.fn(async () => {}),
        },
        vars:        {},
        highlighted: '',
        ...overrides,
    };
}

beforeEach(() => { vi.clearAllMocks(); });

// ---------------------------------------------------------------------------
// Guard clauses
// ---------------------------------------------------------------------------

describe('replace — guard clauses', () => {
    it('does nothing when no message exists at messageId', async () => {
        const ctx = makeCtx('irrelevant');
        ctx.stCtx.chat = []; // empty — messageId 0 is missing
        await replace.execute({ replacement: 'X' }, ctx);
        expect(updateMessageBlock).not.toHaveBeenCalled();
    });

    it('does nothing when the keyword is not present in the message', async () => {
        const ctx = makeCtx('A peaceful meadow.');
        await replace.execute({ replacement: 'X' }, ctx);
        expect(updateMessageBlock).not.toHaveBeenCalled();
        expect(ctx.stCtx.chat[0].mes).toBe('A peaceful meadow.');
    });
});

// ---------------------------------------------------------------------------
// Replacement behaviour
// ---------------------------------------------------------------------------

describe('replace — keyword substitution', () => {
    it('replaces a single occurrence of the keyword', async () => {
        const ctx = makeCtx('The dragon roars.');
        await replace.execute({ replacement: 'beast' }, ctx);
        expect(ctx.stCtx.chat[0].mes).toBe('The beast roars.');
    });

    it('replaces ALL occurrences (global flag)', async () => {
        const ctx = makeCtx('A dragon and another dragon.');
        await replace.execute({ replacement: 'beast' }, ctx);
        expect(ctx.stCtx.chat[0].mes).toBe('A beast and another beast.');
    });

    it('replacement is case-insensitive', async () => {
        const ctx = makeCtx('A DRAGON appeared.');
        await replace.execute({ replacement: 'beast' }, ctx);
        expect(ctx.stCtx.chat[0].mes).toBe('A beast appeared.');
    });

    it('preserves surrounding text', async () => {
        const ctx = makeCtx('Before dragon after.');
        await replace.execute({ replacement: 'serpent' }, ctx);
        expect(ctx.stCtx.chat[0].mes).toBe('Before serpent after.');
    });

    it('empty replacement string deletes the keyword', async () => {
        const ctx = makeCtx('A dragon appeared.');
        await replace.execute({ replacement: '' }, ctx);
        expect(ctx.stCtx.chat[0].mes).toBe('A  appeared.');
    });

    it('replacement containing {{keyword}} interpolates the matched keyword', async () => {
        const ctx = makeCtx('A dragon roared.', { matchedKeyword: 'dragon' });
        await replace.execute({ replacement: '[{{keyword}}]' }, ctx);
        expect(ctx.stCtx.chat[0].mes).toBe('A [dragon] roared.');
    });

    it('escapes regex special characters in the keyword so they are matched literally', async () => {
        const ctx = makeCtx('price is $5 today.', { matchedKeyword: '$5' });
        await replace.execute({ replacement: 'ten' }, ctx);
        expect(ctx.stCtx.chat[0].mes).toBe('price is ten today.');
    });
});

// ---------------------------------------------------------------------------
// Side-effects: updateMessageBlock, saveChat, eventSource
// ---------------------------------------------------------------------------

describe('replace — side effects', () => {
    it('calls updateMessageBlock after a successful replacement', async () => {
        const ctx = makeCtx('A dragon appeared.');
        await replace.execute({ replacement: 'beast' }, ctx);
        expect(updateMessageBlock).toHaveBeenCalledWith(0, ctx.stCtx.chat[0]);
    });

    it('calls saveChat after a successful replacement', async () => {
        const ctx = makeCtx('A dragon appeared.');
        await replace.execute({ replacement: 'beast' }, ctx);
        expect(ctx.stCtx.saveChat).toHaveBeenCalledOnce();
    });

    it('emits MESSAGE_UPDATED after a successful replacement', async () => {
        const ctx = makeCtx('A dragon appeared.');
        await replace.execute({ replacement: 'beast' }, ctx);
        expect(eventSource.emit).toHaveBeenCalledWith('MESSAGE_UPDATED', 0);
    });

    it('does not call updateMessageBlock when text is unchanged', async () => {
        const ctx = makeCtx('No keyword here.');
        await replace.execute({ replacement: 'X' }, ctx);
        expect(updateMessageBlock).not.toHaveBeenCalled();
        expect(ctx.stCtx.saveChat).not.toHaveBeenCalled();
    });

    it('does not call saveChat when stCtx.saveChat is not a function', async () => {
        const ctx = makeCtx('A dragon appeared.');
        ctx.stCtx.saveChat = null; // not a function — should not throw
        await expect(
            replace.execute({ replacement: 'beast' }, ctx),
        ).resolves.toBeUndefined();
    });
});
