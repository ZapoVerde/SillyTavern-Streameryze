import { vi, describe, it, expect, beforeEach } from 'vitest';

const { appendMediaToMessage, saveChat, emitFn } = vi.hoisted(() => ({
    appendMediaToMessage: vi.fn(),
    saveChat:             vi.fn(async () => {}),
    emitFn:              vi.fn(),
}));

vi.mock('../../../../../script.js', () => ({
    eventSource:          { emit: emitFn },
    event_types:          { MESSAGE_UPDATED: 'MESSAGE_UPDATED' },
    name1:                'User',
    name2:                'Char',
    appendMediaToMessage,
}));

vi.mock('../../../../../scripts/openai.js', () => ({ oai_settings: { prompts: [] } }));

vi.mock('../actions/template.js', () => ({
    interpolate:          vi.fn((_tpl, _sys, vars) => _tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars?.[k] ?? '')),
    resolveLbTokens:      vi.fn(async (s) => s),
    resolveHistoryTokens: vi.fn((s) => s),
}));

vi.mock('../actions/text.js',       () => ({ esc: vi.fn(s => String(s ?? '')) }));
vi.mock('../actions/var-legend.js', () => ({ renderVarLegend: vi.fn(() => '') }));
vi.mock('../logger.js',             () => ({ trgError: vi.fn() }));

// jQuery stub — returns {length:0} so the DOM branch is skipped but the try block continues.
vi.stubGlobal('$', vi.fn(() => ({ length: 0 })));

import { loadImage } from '../actions/load-image.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx({ path = 'img/dragon.png', outputVar = '', persist = true, vars = {}, messageId = 0, mes = 'A dragon appeared.' } = {}) {
    return {
        config: { path, outputVar, persist },
        ctx: {
            matchedKeyword: 'dragon',
            messageId,
            stCtx: { chat: [{ mes, extra: {} }], saveChat },
            vars,
            highlighted: '',
        },
    };
}

beforeEach(() => {
    vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// execute() — core behavior
// ---------------------------------------------------------------------------

describe('loadImage — execute()', () => {
    it('does nothing when there is no message at messageId', async () => {
        const { config, ctx } = makeCtx();
        ctx.stCtx.chat = [];
        await loadImage.execute(config, ctx);
        expect(saveChat).not.toHaveBeenCalled();
    });

    it('does nothing when resolved path is empty', async () => {
        const { config, ctx } = makeCtx({ path: '' });
        await loadImage.execute(config, ctx);
        expect(saveChat).not.toHaveBeenCalled();
    });

    it('pushes correct media entry into msg.extra.media', async () => {
        const { config, ctx } = makeCtx();
        await loadImage.execute(config, ctx);
        const msg = ctx.stCtx.chat[0];
        expect(msg.extra.media).toHaveLength(1);
        expect(msg.extra.media[0]).toMatchObject({ url: 'img/dragon.png', type: 'image', source: 'loaded' });
    });

    it('does not add the same path twice (idempotency)', async () => {
        const { config, ctx } = makeCtx();
        await loadImage.execute(config, ctx);
        await loadImage.execute(config, ctx);
        const msg = ctx.stCtx.chat[0];
        expect(msg.extra.media).toHaveLength(1);
    });

    it('stores resolved path in vars when outputVar is set', async () => {
        const vars = {};
        const { config, ctx } = makeCtx({ outputVar: 'imgPath', vars });
        await loadImage.execute(config, ctx);
        expect(vars.imgPath).toBe('img/dragon.png');
    });

    it('calls saveChat when persist is true', async () => {
        const { config, ctx } = makeCtx({ persist: true });
        await loadImage.execute(config, ctx);
        expect(saveChat).toHaveBeenCalled();
    });

    it('does not call saveChat when persist is false', async () => {
        const { config, ctx } = makeCtx({ persist: false });
        await loadImage.execute(config, ctx);
        expect(saveChat).not.toHaveBeenCalled();
    });

    it('emits MESSAGE_UPDATED when persist is true', async () => {
        const { config, ctx } = makeCtx({ persist: true });
        await loadImage.execute(config, ctx);
        expect(emitFn).toHaveBeenCalledWith('MESSAGE_UPDATED', 0);
    });

    it('does not emit MESSAGE_UPDATED when persist is false', async () => {
        const { config, ctx } = makeCtx({ persist: false });
        await loadImage.execute(config, ctx);
        expect(emitFn).not.toHaveBeenCalled();
    });

    it('initializes msg.extra when it is not an object', async () => {
        const { config, ctx } = makeCtx();
        ctx.stCtx.chat[0].extra = null;
        await loadImage.execute(config, ctx);
        expect(ctx.stCtx.chat[0].extra.media).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

describe('loadImage — metadata', () => {
    it('stage is both', () => {
        expect(loadImage.stage).toBe('both');
    });

    it('defaultConfig has path, outputVar, and persist', () => {
        expect(loadImage.defaultConfig).toMatchObject({ path: '', outputVar: '', persist: true });
    });
});
