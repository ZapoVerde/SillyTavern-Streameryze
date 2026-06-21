import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../settings/storage.js', () => ({
    getSettings:      vi.fn(() => ({})),
    getEnabledRules:  vi.fn(() => []),
}));

// Provide a real-enough stageMatches so filtering works in tests, mock the others.
vi.mock('../engine/evaluate.js', () => ({
    stageMatches:      (def, q) => Array.isArray(def) ? def.includes(q) : def === q,
    getVarDeps:        vi.fn(() => []),
    evaluateTriggers:  vi.fn(async () => null),
}));

vi.mock('../engine/live-patch.js', () => ({
    hasLiveResult: vi.fn(() => false),
    setLiveResult: vi.fn(),
}));

// ACTION_REGISTRY starts empty; tests populate it per-case.
vi.mock('../actions/index.js', () => ({
    ACTION_REGISTRY:   {},
    getTemplateTier:   vi.fn(() => 'immediate'),
    resolveLbTokens:   vi.fn(async t => t),
    interpolate:       vi.fn(t => t),
}));

vi.mock('../triggers/turn-vars.js', () => ({
    setTurnVar:          vi.fn(),
    getTurnVar:          vi.fn(() => undefined),
    getTurnVarsSnapshot: vi.fn(() => ({})),
}));

import { executeActions, applyEarlyActions, clearEarlyFired } from '../engine/execute.js';
import { ACTION_REGISTRY, getTemplateTier }                   from '../actions/index.js';
import { setTurnVar }                                         from '../triggers/turn-vars.js';
import { getVarDeps, evaluateTriggers }                       from '../engine/evaluate.js';
import { getEnabledRules }                                    from '../settings/storage.js';
import { setLiveResult }                                      from '../engine/live-patch.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRule(actions, overrides = {}) {
    return { id: 'r1', name: 'Test Rule', devMode: false, actions, ...overrides };
}

function makeAction(type, config = {}, overrides = {}) {
    return { type, config, ...overrides };
}

const execCtx = { matchedKeyword: 'kw', messageId: 0, highlighted: '' };
const genId    = () => 1;

beforeEach(() => {
    clearEarlyFired();
    for (const k of Object.keys(ACTION_REGISTRY)) delete ACTION_REGISTRY[k];
    vi.clearAllMocks();
    vi.mocked(getVarDeps).mockReturnValue([]);
});

// ---------------------------------------------------------------------------
// clearEarlyFired
// ---------------------------------------------------------------------------

describe('clearEarlyFired', () => {
    it('can be called on a clean state without error', () => {
        expect(() => clearEarlyFired()).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// executeActions
// ---------------------------------------------------------------------------

describe('executeActions', () => {
    it('calls execute on a matching action', async () => {
        ACTION_REGISTRY.act = { stage: 'postMessage', execute: vi.fn() };
        await executeActions(makeRule([makeAction('act')]), 'postMessage', execCtx, genId);
        expect(ACTION_REGISTRY.act.execute).toHaveBeenCalledOnce();
    });

    it('passes execCtx fields and vars into the action', async () => {
        ACTION_REGISTRY.act = { stage: 'postMessage', execute: vi.fn() };
        await executeActions(makeRule([makeAction('act')]), 'postMessage', execCtx, genId);
        const [config, ctx] = ACTION_REGISTRY.act.execute.mock.calls[0];
        expect(ctx.matchedKeyword).toBe('kw');
        expect(ctx.ruleId).toBe('r1');
        expect(ctx.vars).toBeDefined();
    });

    it('does not call execute when the action stage does not match', async () => {
        ACTION_REGISTRY.act = { stage: 'stream', execute: vi.fn() };
        await executeActions(makeRule([makeAction('act')]), 'postMessage', execCtx, genId);
        expect(ACTION_REGISTRY.act.execute).not.toHaveBeenCalled();
    });

    it('skips an action type not present in ACTION_REGISTRY', async () => {
        // no registry entry for 'ghost' — should not throw
        await expect(
            executeActions(makeRule([makeAction('ghost')]), 'postMessage', execCtx, genId)
        ).resolves.toBeUndefined();
    });

    it('does nothing when the rule has no actions', async () => {
        await expect(
            executeActions(makeRule([]), 'postMessage', execCtx, genId)
        ).resolves.toBeUndefined();
    });

    it('catches errors thrown by an action and continues to the next', async () => {
        ACTION_REGISTRY.bad  = { stage: 'postMessage', execute: vi.fn().mockRejectedValue(new Error('boom')) };
        ACTION_REGISTRY.good = { stage: 'postMessage', execute: vi.fn() };
        await executeActions(
            makeRule([makeAction('bad'), makeAction('good')]),
            'postMessage', execCtx, genId,
        );
        expect(ACTION_REGISTRY.good.execute).toHaveBeenCalled();
    });

    it('propagates outputVar to setTurnVar after the action writes it to vars', async () => {
        ACTION_REGISTRY.act = {
            stage:   'postMessage',
            execute: vi.fn(async (_cfg, ctx) => { ctx.vars['myVar'] = 'result'; }),
        };
        const action = makeAction('act', { outputVar: 'myVar' });
        await executeActions(makeRule([action]), 'postMessage', execCtx, genId);
        expect(setTurnVar).toHaveBeenCalledWith('myVar', 'result', undefined);
    });

    it('skips outputVar setTurnVar when the action does not write the var', async () => {
        ACTION_REGISTRY.act = {
            stage:   'postMessage',
            execute: vi.fn(),  // does not touch vars
        };
        const action = makeAction('act', { outputVar: 'myVar' });
        await executeActions(makeRule([action]), 'postMessage', execCtx, genId);
        expect(setTurnVar).not.toHaveBeenCalled();
    });

    it('handles an array stage on an action definition', async () => {
        ACTION_REGISTRY.act = { stage: ['stream', 'postMessage'], execute: vi.fn() };
        await executeActions(makeRule([makeAction('act')]), 'postMessage', execCtx, genId);
        expect(ACTION_REGISTRY.act.execute).toHaveBeenCalled();
    });

    it('provides isCurrentGeneration predicate that matches the captured gen id', async () => {
        let capturedPredicate;
        ACTION_REGISTRY.act = {
            stage:   'postMessage',
            execute: vi.fn(async (_cfg, ctx) => { capturedPredicate = ctx.isCurrentGeneration; }),
        };
        await executeActions(makeRule([makeAction('act')]), 'postMessage', execCtx, genId);
        expect(capturedPredicate()).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// applyEarlyActions
// ---------------------------------------------------------------------------

describe('applyEarlyActions', () => {
    const stCtx = { chat: [{ mes: 'A dragon appeared.' }], chatId: 'c1' };

    function earlyRule(actionType, config = {}) {
        return {
            id: 'r1', name: 'Early Rule', devMode: false, when: 'any',
            triggers: [{ type: 'keyword', config: { mode: 'text', keywords: 'dragon' } }],
            actions:  [{ type: actionType, config }],
        };
    }

    beforeEach(() => {
        vi.mocked(getEnabledRules).mockReturnValue([]);
        vi.mocked(evaluateTriggers).mockResolvedValue(null);
        vi.mocked(getTemplateTier).mockReturnValue('immediate');
        vi.mocked(getVarDeps).mockReturnValue([]);
    });

    it('does nothing when there are no enabled rules', async () => {
        vi.mocked(getEnabledRules).mockReturnValue([]);
        await expect(applyEarlyActions('text', 0, stCtx, genId)).resolves.toBeUndefined();
    });

    it('does not fire when the trigger does not match', async () => {
        const execute = vi.fn();
        ACTION_REGISTRY.compose = { stage: 'postMessage', execute, templateFields: () => [] };
        vi.mocked(getEnabledRules).mockReturnValue([earlyRule('compose', { template: 'hi' })]);
        vi.mocked(evaluateTriggers).mockResolvedValue(null);

        await applyEarlyActions('text', 0, stCtx, genId);
        expect(execute).not.toHaveBeenCalled();
    });

    it('fires an immediate-tier once-action and marks it earlyFired', async () => {
        const execute = vi.fn(async () => {});
        ACTION_REGISTRY.compose = { stage: 'postMessage', execute, templateFields: () => [] };
        vi.mocked(getEnabledRules).mockReturnValue([earlyRule('compose', { template: 'hi' })]);
        vi.mocked(evaluateTriggers).mockResolvedValue('dragon');

        await applyEarlyActions('A dragon appeared.', 0, stCtx, genId);
        expect(execute).toHaveBeenCalledOnce();
    });

    it('action fired early is skipped when executeActions runs at postMessage', async () => {
        const execute = vi.fn(async () => {});
        ACTION_REGISTRY.compose = { stage: 'postMessage', execute, templateFields: () => [] };
        const rule = earlyRule('compose', { template: 'hi' });
        vi.mocked(getEnabledRules).mockReturnValue([rule]);
        vi.mocked(evaluateTriggers).mockResolvedValue('dragon');

        await applyEarlyActions('A dragon appeared.', 0, stCtx, genId);
        execute.mockClear();

        await executeActions(rule, 'postMessage', execCtx, genId);
        expect(execute).not.toHaveBeenCalled();
    });

    it('does not fire a second time when already in earlyFired', async () => {
        const execute = vi.fn(async () => {});
        ACTION_REGISTRY.compose = { stage: 'postMessage', execute, templateFields: () => [] };
        vi.mocked(getEnabledRules).mockReturnValue([earlyRule('compose', { template: 'hi' })]);
        vi.mocked(evaluateTriggers).mockResolvedValue('dragon');

        await applyEarlyActions('A dragon appeared.', 0, stCtx, genId);
        execute.mockClear();
        await applyEarlyActions('A dragon appeared.', 0, stCtx, genId);
        expect(execute).not.toHaveBeenCalled();
    });

    it('skips rules that have a MESSAGE_RECEIVED event trigger', async () => {
        const execute = vi.fn();
        ACTION_REGISTRY.compose = { stage: 'postMessage', execute, templateFields: () => [] };
        const rule = {
            ...earlyRule('compose', { template: 'hi' }),
            triggers: [{ type: 'event', config: { event: 'MESSAGE_RECEIVED' } }],
        };
        vi.mocked(getEnabledRules).mockReturnValue([rule]);
        vi.mocked(evaluateTriggers).mockResolvedValue('dragon');

        await applyEarlyActions('text', 0, stCtx, genId);
        expect(execute).not.toHaveBeenCalled();
    });

    it('skips action with unresolved var deps at early stage', async () => {
        const execute = vi.fn();
        ACTION_REGISTRY.compose = { stage: 'postMessage', execute, templateFields: () => [] };
        vi.mocked(getEnabledRules).mockReturnValue([earlyRule('compose', { template: '{{dep}}' })]);
        vi.mocked(evaluateTriggers).mockResolvedValue('dragon');
        vi.mocked(getVarDeps).mockReturnValue(['dep']);

        await applyEarlyActions('text', 0, stCtx, genId);
        expect(execute).not.toHaveBeenCalled();
    });

    it('skips action when tier is message', async () => {
        const execute = vi.fn();
        ACTION_REGISTRY.compose = { stage: 'postMessage', execute, templateFields: () => [] };
        vi.mocked(getEnabledRules).mockReturnValue([earlyRule('compose', { template: 'hi' })]);
        vi.mocked(evaluateTriggers).mockResolvedValue('dragon');
        vi.mocked(getTemplateTier).mockReturnValue('message');

        await applyEarlyActions('text', 0, stCtx, genId);
        expect(execute).not.toHaveBeenCalled();
    });

    it('sets a live result for live-preview update action without calling execute', async () => {
        const execute = vi.fn();
        ACTION_REGISTRY.update = { stage: 'postMessage', execute, templateFields: () => [] };
        vi.mocked(getEnabledRules).mockReturnValue([
            earlyRule('update', { target: 'text', mode: 'replaceKeyword', value: 'NEW' }),
        ]);
        vi.mocked(evaluateTriggers).mockResolvedValue('dragon');

        await applyEarlyActions('A dragon appeared.', 0, stCtx, genId);
        expect(execute).not.toHaveBeenCalled();
        expect(setLiveResult).toHaveBeenCalledOnce();
    });

    it('persists outputVar written by early action via setTurnVar', async () => {
        ACTION_REGISTRY.compose = {
            stage: 'postMessage',
            execute: vi.fn(async (_cfg, ctx) => { ctx.vars['label'] = 'fired'; }),
            templateFields: () => [],
        };
        vi.mocked(getEnabledRules).mockReturnValue([
            earlyRule('compose', { template: 'hi', outputVar: 'label' }),
        ]);
        vi.mocked(evaluateTriggers).mockResolvedValue('dragon');

        await applyEarlyActions('A dragon appeared.', 0, stCtx, genId);
        expect(setTurnVar).toHaveBeenCalledWith('label', 'fired');
    });
});
