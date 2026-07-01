import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

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

// var-legend.js has DOM dependencies; only used in renderConfig, not execute()
vi.mock('../actions/var-legend.js', () => ({ renderVarLegend: vi.fn(() => '') }));

import { slashCmd } from '../actions/slash-cmd.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeExec(pipe = null) {
    return vi.fn(async () => ({ pipe }));
}

function makeCtx(overrides = {}) {
    return {
        matchedKeyword: 'dragon',
        messageId:      0,
        stCtx: {
            chat: [{ mes: 'A dragon appeared.' }],
            executeSlashCommandsWithOptions: makeExec(),
        },
        vars:        {},
        debug:       false,
        highlighted: '',
        ...overrides,
    };
}

beforeEach(() => { vi.clearAllMocks(); });

// ---------------------------------------------------------------------------
// Execution — command reaches the ST executor
// ---------------------------------------------------------------------------

describe('slashCmd — execution', () => {
    it('calls executeSlashCommandsWithOptions exactly once', async () => {
        const ctx = makeCtx();
        await slashCmd.execute({ command: '/echo hello', outputVar: '' }, ctx);
        expect(ctx.stCtx.executeSlashCommandsWithOptions).toHaveBeenCalledTimes(1);
    });

    it('passes the interpolated command as the sole argument', async () => {
        const ctx = makeCtx();
        await slashCmd.execute({ command: '/echo hello', outputVar: '' }, ctx);
        expect(ctx.stCtx.executeSlashCommandsWithOptions).toHaveBeenCalledWith('/echo hello');
    });

    it('passes an empty string when config.command is blank', async () => {
        const ctx = makeCtx();
        await slashCmd.execute({ command: '', outputVar: '' }, ctx);
        expect(ctx.stCtx.executeSlashCommandsWithOptions).toHaveBeenCalledWith('');
    });

    it('preserves newlines in a multi-command string', async () => {
        const ctx = makeCtx();
        await slashCmd.execute({ command: '/cmd1\n/cmd2', outputVar: '' }, ctx);
        expect(ctx.stCtx.executeSlashCommandsWithOptions).toHaveBeenCalledWith('/cmd1\n/cmd2');
    });
});

// ---------------------------------------------------------------------------
// System variable interpolation
// Default fixture: text = 'A dragon appeared.', keyword = 'dragon'
// 'dragon' is at index 2 → upTo = 'A '
// Single paragraph → paragraph = full text
// ---------------------------------------------------------------------------

describe('slashCmd — system variable interpolation', () => {
    it('resolves {{keyword}} to the matched keyword', async () => {
        const ctx = makeCtx({ matchedKeyword: 'dragon' });
        await slashCmd.execute({ command: '{{keyword}}', outputVar: '' }, ctx);
        expect(ctx.stCtx.executeSlashCommandsWithOptions).toHaveBeenCalledWith('dragon');
    });

    it('resolves {{message}} to the full message text', async () => {
        const ctx = makeCtx();
        await slashCmd.execute({ command: '{{message}}', outputVar: '' }, ctx);
        expect(ctx.stCtx.executeSlashCommandsWithOptions).toHaveBeenCalledWith('A dragon appeared.');
    });

    it('resolves {{user}} to name1', async () => {
        const ctx = makeCtx();
        await slashCmd.execute({ command: '{{user}}', outputVar: '' }, ctx);
        expect(ctx.stCtx.executeSlashCommandsWithOptions).toHaveBeenCalledWith('Alice');
    });

    it('resolves {{char}} to name2', async () => {
        const ctx = makeCtx();
        await slashCmd.execute({ command: '{{char}}', outputVar: '' }, ctx);
        expect(ctx.stCtx.executeSlashCommandsWithOptions).toHaveBeenCalledWith('Bot');
    });

    it('resolves {{up-to}} to message text before the first keyword occurrence', async () => {
        // 'A dragon appeared.' — 'dragon' at index 2, so upTo = 'A '
        const ctx = makeCtx();
        await slashCmd.execute({ command: '{{up-to}}', outputVar: '' }, ctx);
        expect(ctx.stCtx.executeSlashCommandsWithOptions).toHaveBeenCalledWith('A ');
    });

    it('resolves {{paragraph}} to the paragraph containing the keyword', async () => {
        // Single-paragraph text → paragraph is the entire message
        const ctx = makeCtx();
        await slashCmd.execute({ command: '{{paragraph}}', outputVar: '' }, ctx);
        expect(ctx.stCtx.executeSlashCommandsWithOptions).toHaveBeenCalledWith('A dragon appeared.');
    });

    it('{{up-to}} is empty string when keyword is null', async () => {
        const ctx = makeCtx({ matchedKeyword: null });
        await slashCmd.execute({ command: '{{up-to}}', outputVar: '' }, ctx);
        expect(ctx.stCtx.executeSlashCommandsWithOptions).toHaveBeenCalledWith('');
    });

    it('{{paragraph}} is empty string when keyword is null', async () => {
        const ctx = makeCtx({ matchedKeyword: null });
        await slashCmd.execute({ command: '{{paragraph}}', outputVar: '' }, ctx);
        expect(ctx.stCtx.executeSlashCommandsWithOptions).toHaveBeenCalledWith('');
    });

    it('expands rule variables from vars into the command', async () => {
        const ctx = makeCtx();
        ctx.vars.mood = 'angry';
        await slashCmd.execute({ command: '/setvar key=mood value={{mood}}', outputVar: '' }, ctx);
        expect(ctx.stCtx.executeSlashCommandsWithOptions)
            .toHaveBeenCalledWith('/setvar key=mood value=angry');
    });
});

// ---------------------------------------------------------------------------
// messageId resolution — which chat entry supplies the message text
// ---------------------------------------------------------------------------

describe('slashCmd — messageId resolution', () => {
    it('uses stCtx.chat[messageId] when messageId is a number', async () => {
        const ctx = makeCtx({ messageId: 1 });
        ctx.stCtx.chat = [{ mes: 'first' }, { mes: 'second' }];
        await slashCmd.execute({ command: '{{message}}', outputVar: '' }, ctx);
        expect(ctx.stCtx.executeSlashCommandsWithOptions).toHaveBeenCalledWith('second');
    });

    it('falls back to the last message when messageId is null', async () => {
        const ctx = makeCtx({ messageId: null });
        ctx.stCtx.chat = [{ mes: 'first' }, { mes: 'last' }];
        await slashCmd.execute({ command: '{{message}}', outputVar: '' }, ctx);
        expect(ctx.stCtx.executeSlashCommandsWithOptions).toHaveBeenCalledWith('last');
    });

    it('produces empty message text when chatIdx points to a missing entry', async () => {
        const ctx = makeCtx({ messageId: 99 });
        ctx.stCtx.chat = [{ mes: 'only' }];
        await slashCmd.execute({ command: '{{message}}', outputVar: '' }, ctx);
        expect(ctx.stCtx.executeSlashCommandsWithOptions).toHaveBeenCalledWith('');
    });
});

// ---------------------------------------------------------------------------
// Keyword escaping — regex metacharacters in the keyword must be escaped
// ---------------------------------------------------------------------------

describe('slashCmd — keyword escaping', () => {
    it('escapes a dot in the keyword so it only matches a literal dot, not any character', async () => {
        // Without escaping, /fire.ball/ would match 'fire_ball' (dot = wildcard).
        // With escaping, /fire\.ball/ does not match 'fire_ball' → no firstMatch → upTo = ''.
        const ctx = makeCtx({
            matchedKeyword: 'fire.ball',
            stCtx: {
                chat: [{ mes: 'a fire_ball event' }],
                executeSlashCommandsWithOptions: makeExec(),
            },
        });
        await slashCmd.execute({ command: '{{up-to}}', outputVar: '' }, ctx);
        expect(ctx.stCtx.executeSlashCommandsWithOptions).toHaveBeenCalledWith('');
    });

    it('does not throw when keyword contains (, ), and + characters', async () => {
        // Without escaping, /(fire+ball)/ would be a capturing group with a quantifier.
        const ctx = makeCtx({
            matchedKeyword: '(fire+ball)',
            stCtx: {
                chat: [{ mes: 'nothing here' }],
                executeSlashCommandsWithOptions: makeExec(),
            },
        });
        await slashCmd.execute({ command: '/echo {{keyword}}', outputVar: '' }, ctx);
        expect(ctx.stCtx.executeSlashCommandsWithOptions)
            .toHaveBeenCalledWith('/echo (fire+ball)');
    });
});

// ---------------------------------------------------------------------------
// Pipe capture — outputVar and result.pipe
// ---------------------------------------------------------------------------

describe('slashCmd — pipe capture', () => {
    it('writes the pipe result to vars[outputVar] when outputVar is set', async () => {
        const ctx = makeCtx();
        ctx.stCtx.executeSlashCommandsWithOptions = vi.fn(async () => ({ pipe: 'hello' }));
        await slashCmd.execute({ command: '/echo hello', outputVar: 'result' }, ctx);
        expect(ctx.vars.result).toBe('hello');
    });

    it('does not write to vars when pipe is null', async () => {
        const ctx = makeCtx();
        ctx.stCtx.executeSlashCommandsWithOptions = vi.fn(async () => ({ pipe: null }));
        await slashCmd.execute({ command: '/echo', outputVar: 'result' }, ctx);
        expect(ctx.vars.result).toBeUndefined();
    });

    it('does not write to vars when pipe is undefined', async () => {
        const ctx = makeCtx();
        ctx.stCtx.executeSlashCommandsWithOptions = vi.fn(async () => ({}));
        await slashCmd.execute({ command: '/echo', outputVar: 'result' }, ctx);
        expect(ctx.vars.result).toBeUndefined();
    });

    it('does not write to vars when outputVar is empty', async () => {
        const ctx = makeCtx();
        ctx.stCtx.executeSlashCommandsWithOptions = vi.fn(async () => ({ pipe: 'value' }));
        await slashCmd.execute({ command: '/echo', outputVar: '' }, ctx);
        expect(Object.keys(ctx.vars)).toHaveLength(0);
    });

    it('does not throw when vars is null and a pipe result arrives', async () => {
        const ctx = makeCtx();
        ctx.stCtx.executeSlashCommandsWithOptions = vi.fn(async () => ({ pipe: 'value' }));
        // vars guard: `config.outputVar && vars && ...` short-circuits on null vars
        await slashCmd.execute({ command: '/echo', outputVar: 'result' }, { ...ctx, vars: null });
    });

    it('does not throw when executeSlashCommandsWithOptions returns null', async () => {
        const ctx = makeCtx();
        ctx.stCtx.executeSlashCommandsWithOptions = vi.fn(async () => null);
        await slashCmd.execute({ command: '/echo', outputVar: 'result' }, ctx);
    });

    it('does not clobber pre-existing vars keys', async () => {
        const ctx = makeCtx();
        ctx.vars.existing = 'untouched';
        ctx.stCtx.executeSlashCommandsWithOptions = vi.fn(async () => ({ pipe: 'new' }));
        await slashCmd.execute({ command: '/echo', outputVar: 'result' }, ctx);
        expect(ctx.vars.existing).toBe('untouched');
    });

    it('stores a numeric pipe value as-is', async () => {
        const ctx = makeCtx();
        ctx.stCtx.executeSlashCommandsWithOptions = vi.fn(async () => ({ pipe: 42 }));
        await slashCmd.execute({ command: '/echo', outputVar: 'count' }, ctx);
        expect(ctx.vars.count).toBe(42);
    });
});

// ---------------------------------------------------------------------------
// Debug logging
// ---------------------------------------------------------------------------

describe('slashCmd — debug logging', () => {
    let logSpy;

    beforeEach(() => {
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        logSpy.mockRestore();
    });

    it('logs the command when debug is true', async () => {
        const ctx = makeCtx({ debug: true });
        await slashCmd.execute({ command: '/echo hello', outputVar: '' }, ctx);
        expect(logSpy).toHaveBeenCalledWith('[TRG:dev]', expect.stringContaining('slashCmd'), '/echo hello');
    });

    it('also logs the pipe when debug is true and pipe is non-null', async () => {
        const ctx = makeCtx({ debug: true });
        ctx.stCtx.executeSlashCommandsWithOptions = vi.fn(async () => ({ pipe: 'pipeValue' }));
        await slashCmd.execute({ command: '/echo hello', outputVar: '' }, ctx);
        expect(logSpy).toHaveBeenCalledTimes(2);
        expect(logSpy).toHaveBeenLastCalledWith('[TRG:dev]', expect.stringContaining('pipe'), 'pipeValue');
    });

    it('does not log when debug is false', async () => {
        const ctx = makeCtx({ debug: false });
        await slashCmd.execute({ command: '/echo hello', outputVar: '' }, ctx);
        expect(logSpy).not.toHaveBeenCalled();
    });

    it('only logs once when debug is true but pipe is null', async () => {
        const ctx = makeCtx({ debug: true });
        // default makeExec returns { pipe: null }
        await slashCmd.execute({ command: '/echo hello', outputVar: '' }, ctx);
        expect(logSpy).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------
// preview()
// ---------------------------------------------------------------------------

describe('slashCmd — preview', () => {
    it('returns a hint when command is empty', async () => {
        const result = await slashCmd.preview({ command: '', outputVar: '' }, 'some text');
        expect(result.hint).toBeTruthy();
    });

    it('resolves the command against the given text without running it — preview takes no stCtx, so there is nothing it could execute against', async () => {
        const result = await slashCmd.preview({ command: '/echo {{message}}', outputVar: '' }, 'A dragon appeared.');
        expect(result.output).toBe('Would run:\n/echo A dragon appeared.');
    });
});
