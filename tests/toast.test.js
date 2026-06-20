import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../../../../../script.js', () => ({ name1: 'User', name2: 'Char' }));
vi.mock('../../../../../scripts/openai.js', () => ({ oai_settings: { prompts: [] } }));

vi.mock('../actions/template.js', () => ({
    interpolate:     vi.fn((tpl, _sys, vars) => tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars?.[k] ?? '')),
    resolveLbTokens: vi.fn(async (s) => s),
}));

vi.mock('../actions/text.js',       () => ({ esc: vi.fn(s => String(s ?? '')) }));
vi.mock('../actions/var-legend.js', () => ({ renderVarLegend: vi.fn(() => '') }));
vi.mock('../logger.js',             () => ({ trgDev: vi.fn() }));

// Stub window — test environment is node, no browser globals.
vi.stubGlobal('window', {});

import { toast } from '../actions/toast.js';

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

function makeToastr() {
    return { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() };
}

beforeEach(() => {
    vi.clearAllMocks();
    window.toastr = makeToastr();
});

// ---------------------------------------------------------------------------
// execute() — no-op guard
// ---------------------------------------------------------------------------

describe('toast — execute() no-op cases', () => {
    it('does nothing when message is empty', async () => {
        await toast.execute({ message: '', title: '', level: 'info', tapToDismiss: false, copyOnClick: false }, makeCtx());
        expect(window.toastr.info).not.toHaveBeenCalled();
    });

    it('does nothing when message is absent', async () => {
        await toast.execute({ level: 'info', tapToDismiss: false, copyOnClick: false }, makeCtx());
        expect(window.toastr.info).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// execute() — level routing
// ---------------------------------------------------------------------------

describe('toast — execute() level routing', () => {
    it('calls toastr.info for level "info"', async () => {
        await toast.execute({ message: 'hello', title: '', level: 'info', tapToDismiss: false, copyOnClick: false }, makeCtx());
        expect(window.toastr.info).toHaveBeenCalledWith('hello', undefined, undefined);
    });

    it('calls toastr.success for level "success"', async () => {
        await toast.execute({ message: 'ok', title: '', level: 'success', tapToDismiss: false, copyOnClick: false }, makeCtx());
        expect(window.toastr.success).toHaveBeenCalled();
        expect(window.toastr.info).not.toHaveBeenCalled();
    });

    it('calls toastr.warning for level "warning"', async () => {
        await toast.execute({ message: 'warn', title: '', level: 'warning', tapToDismiss: false, copyOnClick: false }, makeCtx());
        expect(window.toastr.warning).toHaveBeenCalled();
    });

    it('calls toastr.error for level "error"', async () => {
        await toast.execute({ message: 'bad', title: '', level: 'error', tapToDismiss: false, copyOnClick: false }, makeCtx());
        expect(window.toastr.error).toHaveBeenCalled();
    });

    it('falls back to info for an unknown level', async () => {
        await toast.execute({ message: 'hi', title: '', level: 'critical', tapToDismiss: false, copyOnClick: false }, makeCtx());
        expect(window.toastr.info).toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// execute() — title and options
// ---------------------------------------------------------------------------

describe('toast — execute() title and options', () => {
    it('passes title string when non-empty', async () => {
        await toast.execute({ message: 'body', title: 'Heading', level: 'info', tapToDismiss: false, copyOnClick: false }, makeCtx());
        const [, title] = window.toastr.info.mock.calls[0];
        expect(title).toBe('Heading');
    });

    it('passes undefined title when title is empty', async () => {
        await toast.execute({ message: 'body', title: '', level: 'info', tapToDismiss: false, copyOnClick: false }, makeCtx());
        const [, title] = window.toastr.info.mock.calls[0];
        expect(title).toBeUndefined();
    });

    it('sets tapToDismiss option when enabled', async () => {
        await toast.execute({ message: 'body', title: '', level: 'info', tapToDismiss: true, copyOnClick: false }, makeCtx());
        const [, , opts] = window.toastr.info.mock.calls[0];
        expect(opts?.tapToDismiss).toBe(true);
    });

    it('sets onclick option when copyOnClick is enabled', async () => {
        await toast.execute({ message: 'body', title: '', level: 'info', tapToDismiss: false, copyOnClick: true }, makeCtx());
        const [, , opts] = window.toastr.info.mock.calls[0];
        expect(typeof opts?.onclick).toBe('function');
    });

    it('passes no options object when neither tap nor copy is set', async () => {
        await toast.execute({ message: 'body', title: '', level: 'info', tapToDismiss: false, copyOnClick: false }, makeCtx());
        const [, , opts] = window.toastr.info.mock.calls[0];
        expect(opts).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

describe('toast — metadata', () => {
    it('stage includes both stream and postMessage', () => {
        const stages = [].concat(toast.stage);
        expect(stages).toContain('stream');
        expect(stages).toContain('postMessage');
    });

    it('defaultConfig has message, title, level, and boolean flags', () => {
        expect(toast.defaultConfig).toMatchObject({
            message: '', title: '', level: 'info',
            tapToDismiss: false, copyOnClick: false,
        });
    });
});
