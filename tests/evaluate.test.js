import { vi, describe, it, expect, beforeEach } from 'vitest';

// Provide empty registry objects as the mocked modules.
// Tests mutate these objects directly; evaluate.js sees the same reference.
vi.mock('../triggers.js',      () => ({ TRIGGER_REGISTRY: {} }));
vi.mock('../actions/index.js', () => ({ ACTION_REGISTRY:  {} }));

import { evaluateTriggers, stageMatches, ruleHasStage, getVarDeps } from '../engine/evaluate.js';
import { TRIGGER_REGISTRY } from '../triggers.js';
import { ACTION_REGISTRY }  from '../actions/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRule(triggers, triggerLogic = 'any', actions = []) {
    return { triggers, triggerLogic, actions };
}

function makeTrigger(type, config = {}) {
    return { type, config };
}

beforeEach(() => {
    for (const k of Object.keys(TRIGGER_REGISTRY)) delete TRIGGER_REGISTRY[k];
    for (const k of Object.keys(ACTION_REGISTRY))  delete ACTION_REGISTRY[k];
});

// ---------------------------------------------------------------------------
// evaluateTriggers
// ---------------------------------------------------------------------------

describe('evaluateTriggers', () => {
    it('returns null when rule has no triggers', async () => {
        expect(await evaluateTriggers(makeRule([]), '')).toBeNull();
    });

    it('returns null when triggers is undefined', async () => {
        expect(await evaluateTriggers({}, '')).toBeNull();
    });

    describe('OR mode (default / triggerLogic: "any")', () => {
        it('returns matched string from first matching trigger', async () => {
            TRIGGER_REGISTRY.kw = { test: vi.fn().mockResolvedValue('hello') };
            expect(await evaluateTriggers(makeRule([makeTrigger('kw')], 'any'), 'hello world')).toBe('hello');
        });

        it('skips non-matching triggers and returns the first match', async () => {
            TRIGGER_REGISTRY.kw1 = { test: vi.fn().mockResolvedValue(null) };
            TRIGGER_REGISTRY.kw2 = { test: vi.fn().mockResolvedValue('world') };
            const rule = makeRule([makeTrigger('kw1'), makeTrigger('kw2')], 'any');
            expect(await evaluateTriggers(rule, 'hello world')).toBe('world');
        });

        it('returns null when no triggers match', async () => {
            TRIGGER_REGISTRY.kw = { test: vi.fn().mockResolvedValue(null) };
            expect(await evaluateTriggers(makeRule([makeTrigger('kw')], 'any'), 'nothing')).toBeNull();
        });

        it('returns null for an unknown trigger type', async () => {
            expect(await evaluateTriggers(makeRule([makeTrigger('ghost')], 'any'), 'text')).toBeNull();
        });

        it('treats a throwing trigger as null and keeps trying', async () => {
            TRIGGER_REGISTRY.bad  = { test: vi.fn().mockRejectedValue(new Error('boom')) };
            TRIGGER_REGISTRY.good = { test: vi.fn().mockResolvedValue('found') };
            const rule = makeRule([makeTrigger('bad'), makeTrigger('good')], 'any');
            expect(await evaluateTriggers(rule, 'text')).toBe('found');
        });
    });

    describe('AND mode (triggerLogic: "all")', () => {
        it('returns first matched string when all triggers match', async () => {
            TRIGGER_REGISTRY.a = { test: vi.fn().mockResolvedValue('match-a') };
            TRIGGER_REGISTRY.b = { test: vi.fn().mockResolvedValue('match-b') };
            const rule = makeRule([makeTrigger('a'), makeTrigger('b')], 'all');
            expect(await evaluateTriggers(rule, 'text')).toBe('match-a');
        });

        it('returns null when any single trigger fails', async () => {
            TRIGGER_REGISTRY.a = { test: vi.fn().mockResolvedValue('match') };
            TRIGGER_REGISTRY.b = { test: vi.fn().mockResolvedValue(null) };
            const rule = makeRule([makeTrigger('a'), makeTrigger('b')], 'all');
            expect(await evaluateTriggers(rule, 'text')).toBeNull();
        });

        it('returns null when all triggers fail', async () => {
            TRIGGER_REGISTRY.a = { test: vi.fn().mockResolvedValue(null) };
            TRIGGER_REGISTRY.b = { test: vi.fn().mockResolvedValue(null) };
            const rule = makeRule([makeTrigger('a'), makeTrigger('b')], 'all');
            expect(await evaluateTriggers(rule, 'text')).toBeNull();
        });
    });
});

// ---------------------------------------------------------------------------
// stageMatches
// ---------------------------------------------------------------------------

describe('stageMatches', () => {
    it('matches when defStage is the same string', () => {
        expect(stageMatches('stream', 'stream')).toBe(true);
    });

    it('does not match different strings', () => {
        expect(stageMatches('stream', 'postMessage')).toBe(false);
    });

    it('matches when queryStage is in a defStage array', () => {
        expect(stageMatches(['stream', 'postMessage'], 'stream')).toBe(true);
        expect(stageMatches(['stream', 'postMessage'], 'postMessage')).toBe(true);
    });

    it('does not match when queryStage is absent from the array', () => {
        expect(stageMatches(['stream', 'postMessage'], 'immediate')).toBe(false);
    });

    it('returns false for an empty array', () => {
        expect(stageMatches([], 'stream')).toBe(false);
    });

    it('returns false when defStage is null', () => {
        expect(stageMatches(null, 'stream')).toBe(false);
    });

    it('returns false when defStage is undefined', () => {
        expect(stageMatches(undefined, 'stream')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// ruleHasStage
// ---------------------------------------------------------------------------

describe('ruleHasStage', () => {
    it('returns false for a rule with no actions', () => {
        expect(ruleHasStage({ actions: [] }, 'stream')).toBe(false);
    });

    it('returns false when the action type is not in the registry', () => {
        expect(ruleHasStage({ actions: [{ type: 'ghost' }] }, 'stream')).toBe(false);
    });

    it('returns true when an action stage string matches', () => {
        ACTION_REGISTRY.act = { stage: 'stream' };
        expect(ruleHasStage({ actions: [{ type: 'act' }] }, 'stream')).toBe(true);
    });

    it('returns false when an action stage string does not match', () => {
        ACTION_REGISTRY.act = { stage: 'postMessage' };
        expect(ruleHasStage({ actions: [{ type: 'act' }] }, 'stream')).toBe(false);
    });

    it('returns true when the queried stage is inside an array stage', () => {
        ACTION_REGISTRY.act = { stage: ['stream', 'postMessage'] };
        expect(ruleHasStage({ actions: [{ type: 'act' }] }, 'postMessage')).toBe(true);
    });

    it('returns true when any one action matches even if others do not', () => {
        ACTION_REGISTRY.a = { stage: 'postMessage' };
        ACTION_REGISTRY.b = { stage: 'stream' };
        const rule = { actions: [{ type: 'a' }, { type: 'b' }] };
        expect(ruleHasStage(rule, 'stream')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// getVarDeps
// ---------------------------------------------------------------------------

describe('getVarDeps', () => {
    it('returns empty array when knownVars is empty', () => {
        expect(getVarDeps({ text: '{{foo}}' }, new Set())).toEqual([]);
    });

    it('returns empty array when config has no template tokens', () => {
        expect(getVarDeps({ text: 'plain text' }, new Set(['foo']))).toEqual([]);
    });

    it('returns matching var names present in knownVars', () => {
        expect(getVarDeps({ text: 'Result: {{output}}' }, new Set(['output', 'other']))).toEqual(['output']);
    });

    it('does not return vars absent from knownVars', () => {
        expect(getVarDeps({ text: '{{unknown}}' }, new Set(['output']))).toEqual([]);
    });

    it('scans all string fields in the config object', () => {
        const config = { field1: '{{a}}', field2: '{{b}}', n: 42, flag: true };
        const result = getVarDeps(config, new Set(['a', 'b']));
        expect(result).toContain('a');
        expect(result).toContain('b');
    });

    it('trims whitespace from matched var names', () => {
        expect(getVarDeps({ text: '{{ spaced }}' }, new Set(['spaced']))).toEqual(['spaced']);
    });

    it('returns empty array when config is null', () => {
        expect(getVarDeps(null, new Set(['x']))).toEqual([]);
    });

    it('returns empty array when config is undefined', () => {
        expect(getVarDeps(undefined, new Set(['x']))).toEqual([]);
    });
});
