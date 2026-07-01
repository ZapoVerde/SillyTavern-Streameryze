import { vi, describe, it, expect, beforeEach } from 'vitest';

const { onceMock } = vi.hoisted(() => ({ onceMock: vi.fn() }));

vi.mock('../../../../../script.js', () => ({
    eventSource: { once: onceMock },
    event_types: { GENERATION_STOPPED: 'GENERATION_STOPPED' },
}));

import { stop } from '../actions/stop.js';

function makeCtx(overrides = {}) {
    return {
        stCtx: { stopGeneration: vi.fn() },
        ...overrides,
    };
}

beforeEach(() => { vi.clearAllMocks(); });

// ---------------------------------------------------------------------------
// execute()
// ---------------------------------------------------------------------------

describe('stop — execute', () => {
    it('stops generation', async () => {
        const ctx = makeCtx();
        await stop.execute({ andContinue: false }, ctx);
        expect(ctx.stCtx.stopGeneration).toHaveBeenCalledOnce();
    });

    it('does not register a continue listener when andContinue is off', async () => {
        await stop.execute({ andContinue: false }, makeCtx());
        expect(onceMock).not.toHaveBeenCalled();
    });

    it('registers a GENERATION_STOPPED listener when andContinue is on', async () => {
        await stop.execute({ andContinue: true }, makeCtx());
        expect(onceMock).toHaveBeenCalledWith('GENERATION_STOPPED', expect.any(Function));
    });

    it('tolerates a missing stCtx.stopGeneration', async () => {
        await expect(stop.execute({ andContinue: false }, { stCtx: {} })).resolves.not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// preview()
// ---------------------------------------------------------------------------

describe('stop — preview', () => {
    it('reports a plain stop when andContinue is off', async () => {
        const result = await stop.preview({ andContinue: false });
        expect(result.hint).toBe('Stops generation.');
    });

    it('mentions the resume when andContinue is on', async () => {
        const result = await stop.preview({ andContinue: true });
        expect(result.hint).toBe('Stops generation, then resumes (continue).');
    });
});

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

describe('stop — metadata', () => {
    it('templateFields is always empty', () => {
        expect(stop.templateFields()).toEqual([]);
    });

    it('defaultConfig has andContinue: false', () => {
        expect(stop.defaultConfig).toEqual({ andContinue: false });
    });
});
