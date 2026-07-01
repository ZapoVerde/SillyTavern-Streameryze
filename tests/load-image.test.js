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

vi.mock('../imageGen.js', () => ({
    SOURCE_LABELS:        { pollinations: 'Pollinations' },
    loadModelsForSource:  vi.fn(async () => []),
    generatePreviewBlob:  vi.fn(async () => 'blob:test'),
    generateAndUpload:    vi.fn(async () => '/gen/result.png'),
}));

vi.mock('../../../../../scripts/openai.js', () => ({ oai_settings: { prompts: [] } }));

vi.mock('../actions/template.js', () => ({
    interpolate:          vi.fn((_tpl, _sys, vars) => _tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars?.[k] ?? '')),
    resolveLbTokens:      vi.fn(async (s) => s),
    resolveHistoryTokens: vi.fn((s) => s),
}));

vi.mock('../actions/text.js',       () => ({ esc: vi.fn(s => String(s ?? '')) }));
vi.mock('../actions/var-legend.js', () => ({ renderVarLegend: vi.fn(() => '') }));
vi.mock('../logger.js',             () => ({ trgError: vi.fn(), trgPerf: vi.fn() }));

vi.stubGlobal('$', vi.fn(() => ({ length: 0 })));

import { image } from '../actions/image.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx({ path = 'img/dragon.png', outputVar = '', persist = true, vars = {}, messageId = 0, mes = 'A dragon appeared.' } = {}) {
    return {
        config: { source: 'path', path, outputVar, persist, model: '', comfyUiUrl: '', prompt: '{{keyword}}' },
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
// execute() — path mode
// ---------------------------------------------------------------------------

describe('image(path) — execute()', () => {
    it('does nothing when there is no message at messageId', async () => {
        const { config, ctx } = makeCtx();
        ctx.stCtx.chat = [];
        await image.execute(config, ctx);
        expect(saveChat).not.toHaveBeenCalled();
    });

    it('does nothing when resolved path is empty', async () => {
        const { config, ctx } = makeCtx({ path: '' });
        await image.execute(config, ctx);
        expect(saveChat).not.toHaveBeenCalled();
    });

    it('pushes correct media entry into msg.extra.media', async () => {
        const { config, ctx } = makeCtx();
        await image.execute(config, ctx);
        const msg = ctx.stCtx.chat[0];
        expect(msg.extra.media).toHaveLength(1);
        expect(msg.extra.media[0]).toMatchObject({ url: 'img/dragon.png', type: 'image', source: 'loaded' });
    });

    it('does not add the same path twice (idempotency)', async () => {
        const { config, ctx } = makeCtx();
        await image.execute(config, ctx);
        await image.execute(config, ctx);
        const msg = ctx.stCtx.chat[0];
        expect(msg.extra.media).toHaveLength(1);
    });

    it('stores resolved path in vars when outputVar is set', async () => {
        const vars = {};
        const { config, ctx } = makeCtx({ outputVar: 'imgPath', vars });
        await image.execute(config, ctx);
        expect(vars.imgPath).toBe('img/dragon.png');
    });

    it('calls saveChat when persist is true', async () => {
        const { config, ctx } = makeCtx({ persist: true });
        await image.execute(config, ctx);
        expect(saveChat).toHaveBeenCalled();
    });

    it('does not call saveChat when persist is false', async () => {
        const { config, ctx } = makeCtx({ persist: false });
        await image.execute(config, ctx);
        expect(saveChat).not.toHaveBeenCalled();
    });

    it('emits MESSAGE_UPDATED when persist is true', async () => {
        const { config, ctx } = makeCtx({ persist: true });
        await image.execute(config, ctx);
        expect(emitFn).toHaveBeenCalledWith('MESSAGE_UPDATED', 0);
    });

    it('does not emit MESSAGE_UPDATED when persist is false', async () => {
        const { config, ctx } = makeCtx({ persist: false });
        await image.execute(config, ctx);
        expect(emitFn).not.toHaveBeenCalled();
    });

    it('initializes msg.extra when it is not an object', async () => {
        const { config, ctx } = makeCtx();
        ctx.stCtx.chat[0].extra = null;
        await image.execute(config, ctx);
        expect(ctx.stCtx.chat[0].extra.media).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

describe('image — metadata', () => {
    it('defaultConfig has expected shape', () => {
        expect(image.defaultConfig).toMatchObject({ source: 'pollinations', path: '', outputVar: '', persist: true });
    });
});

// ---------------------------------------------------------------------------
// preview()
// ---------------------------------------------------------------------------

describe('image — preview', () => {
    it('returns a hint when the prompt is empty (generation source)', async () => {
        const result = await image.preview({ source: 'pollinations', prompt: '' }, 'some text');
        expect(result.hint).toBeTruthy();
    });

    it('returns a hint when the path is empty (path source)', async () => {
        const result = await image.preview({ source: 'path', path: '' }, 'some text');
        expect(result.hint).toBeTruthy();
    });

    it('resolves the prompt without ever calling generateAndUpload', async () => {
        const { generateAndUpload } = await import('../imageGen.js');
        const result = await image.preview({ source: 'pollinations', prompt: 'a scene' }, 'A dragon appeared.');
        expect(result.output).toBe('Would generate image from prompt:\na scene');
        expect(generateAndUpload).not.toHaveBeenCalled();
    });

    it('resolves the path without attaching anything to the message', async () => {
        const { config, ctx } = makeCtx({ path: 'img/dragon.png' });
        const result = await image.preview({ ...config, source: 'path' }, 'A dragon appeared.');
        expect(result.output).toBe('Would attach image from path:\nimg/dragon.png');
        expect(ctx.stCtx.chat[0].extra.media).toBeUndefined();
    });
});
