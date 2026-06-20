import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../actions/template.js', () => ({
    interpolate: vi.fn((template, _vars, ruleVars) => {
        return template.replace(/\{\{(\w+)\}\}/g, (_, k) => ruleVars?.[k] ?? '');
    }),
}));

vi.mock('../actions/text.js',       () => ({ esc: vi.fn(s => String(s ?? '')) }));
vi.mock('../actions/var-legend.js', () => ({ renderVarLegend: vi.fn(() => '') }));

// Stub document and CustomEvent — test environment is node, no DOM.
const dispatchEventFn = vi.fn();
vi.stubGlobal('document', { dispatchEvent: dispatchEventFn });
vi.stubGlobal('CustomEvent', class CustomEvent {
    constructor(type, opts) { this.type = type; this.detail = opts?.detail ?? null; }
});

import { domEvent } from '../actions/domEvent.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(vars = {}) {
    return { vars, matchedKeyword: '', messageId: 0, debug: false };
}

beforeEach(() => { vi.clearAllMocks(); });

// ---------------------------------------------------------------------------
// execute() — dispatches CustomEvent on document
// ---------------------------------------------------------------------------

describe('domEvent action — execute()', () => {
    it('dispatches a CustomEvent with the configured eventName', async () => {
        await domEvent.execute({ eventName: 'plz:request-rmbg', payload: '{}' }, makeCtx());

        expect(dispatchEventFn).toHaveBeenCalledTimes(1);
        expect(dispatchEventFn.mock.calls[0][0].type).toBe('plz:request-rmbg');
    });

    it('parses the payload JSON and passes it as event detail', async () => {
        await domEvent.execute(
            { eventName: 'my:event', payload: '{"foo":"bar","count":3}' },
            makeCtx(),
        );

        expect(dispatchEventFn.mock.calls[0][0].detail).toEqual({ foo: 'bar', count: 3 });
    });

    it('interpolates vars into payload before parsing', async () => {
        await domEvent.execute(
            { eventName: 'my:event', payload: '{"uuid":"{{dom_event_uuid}}"}' },
            makeCtx({ dom_event_uuid: 'abc-123' }),
        );

        expect(dispatchEventFn.mock.calls[0][0].detail).toEqual({ uuid: 'abc-123' });
    });

    it('falls back to { raw } detail when payload is not valid JSON', async () => {
        await domEvent.execute({ eventName: 'my:event', payload: 'not json' }, makeCtx());

        expect(dispatchEventFn.mock.calls[0][0].detail).toEqual({ raw: 'not json' });
    });

    it('does nothing when eventName is empty', async () => {
        await domEvent.execute({ eventName: '', payload: '{}' }, makeCtx());
        await domEvent.execute({ eventName: '   ', payload: '{}' }, makeCtx());

        expect(dispatchEventFn).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

describe('domEvent action — metadata', () => {
    it('stage is postMessage', () => {
        expect(domEvent.stage).toBe('postMessage');
    });

    it('defaultConfig has eventName and payload', () => {
        expect(domEvent.defaultConfig).toMatchObject({ eventName: expect.any(String), payload: '{}' });
    });
});
