import { vi, describe, it, expect } from 'vitest';

vi.mock('../../../../../script.js', () => ({
    callPopup: vi.fn(),
    eventSource: { on: vi.fn() },
    event_types: {},
}));
vi.mock('../settings/storage.js', () => ({
    getSettings: vi.fn(() => ({ rulesets: [] })),
    makeId: vi.fn(() => 'id'),
}));
vi.mock('../triggers.js',       () => ({ TRIGGER_REGISTRY: {} }));
vi.mock('../actions/index.js',  () => ({ ACTION_REGISTRY: {}, makeActionCtx: vi.fn() }));
vi.mock('../engine.js',         () => ({ reinjectRuleBadges: vi.fn() }));

import { detectOutOfScopeVars } from '../settings/rule-cards.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRuleset(id, rules = []) {
    return { id, enabled: true, rules };
}

function makeRule(id, { actions = [], triggers = [] } = {}) {
    return { id, name: id, enabled: true, actions, triggers };
}

function makeAction(outputVar, extraConfig = {}) {
    return { type: 'compose', config: { outputVar, ...extraConfig } };
}

function makeVarMatchTrigger(varName) {
    return { type: 'varMatch', config: { varName, operator: 'equals', value: 'x' } };
}

// ---------------------------------------------------------------------------
// No cross-scope vars
// ---------------------------------------------------------------------------

describe('detectOutOfScopeVars — no cross-scope output vars', () => {
    it('returns empty when there are no other rulesets', () => {
        const rule = makeRule('r1', {
            actions: [makeAction('result', { template: '{{result}}' })],
        });
        expect(detectOutOfScopeVars(rule, 'rs1', [makeRuleset('rs1', [rule])])).toEqual([]);
    });

    it('returns empty when other rulesets have no rules', () => {
        const rule = makeRule('r1', { actions: [makeAction('x', { template: '{{x}}' })] });
        const rulesets = [makeRuleset('rs1', [rule]), makeRuleset('rs2', [])];
        expect(detectOutOfScopeVars(rule, 'rs1', rulesets)).toEqual([]);
    });

    it('returns empty when other rulesets have rules with no actions', () => {
        const rule = makeRule('r1', { actions: [makeAction('x', { template: '{{x}}' })] });
        const other = makeRule('r2');
        const rulesets = [makeRuleset('rs1', [rule]), makeRuleset('rs2', [other])];
        expect(detectOutOfScopeVars(rule, 'rs1', rulesets)).toEqual([]);
    });

    it('returns empty when the only cross-scope outputVars are $ prefixed', () => {
        const rule = makeRule('r1', { actions: [makeAction('x', { template: '{{$shared}}' })] });
        const other = makeRule('r2', { actions: [makeAction('$shared')] });
        const rulesets = [makeRuleset('rs1', [rule]), makeRuleset('rs2', [other])];
        expect(detectOutOfScopeVars(rule, 'rs1', rulesets)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Reference detection — action config strings
// ---------------------------------------------------------------------------

describe('detectOutOfScopeVars — action config string scanning', () => {
    it('flags a var referenced via {{token}} in an action template', () => {
        const rule = makeRule('r1', {
            actions: [{ type: 'compose', config: { outputVar: 'mine', template: '{{emotion}}' } }],
        });
        const other = makeRule('r2', { actions: [makeAction('emotion')] });
        const rulesets = [makeRuleset('rs1', [rule]), makeRuleset('rs2', [other])];
        expect(detectOutOfScopeVars(rule, 'rs1', rulesets)).toEqual(['emotion']);
    });

    it('flags a var referenced in a replacement field', () => {
        const rule = makeRule('r1', {
            actions: [{ type: 'replace', config: { replacement: '[{{mood}}]' } }],
        });
        const other = makeRule('r2', { actions: [makeAction('mood')] });
        const rulesets = [makeRuleset('rs1', [rule]), makeRuleset('rs2', [other])];
        expect(detectOutOfScopeVars(rule, 'rs1', rulesets)).toEqual(['mood']);
    });

    it('flags multiple out-of-scope vars referenced in the same action', () => {
        const rule = makeRule('r1', {
            actions: [{ type: 'compose', config: { template: '{{emotion}} {{mood}}' } }],
        });
        const other = makeRule('r2', { actions: [makeAction('emotion'), makeAction('mood')] });
        const rulesets = [makeRuleset('rs1', [rule]), makeRuleset('rs2', [other])];
        const result = detectOutOfScopeVars(rule, 'rs1', rulesets);
        expect(result).toContain('emotion');
        expect(result).toContain('mood');
        expect(result).toHaveLength(2);
    });

    it('flags a var referenced across multiple actions', () => {
        const rule = makeRule('r1', {
            actions: [
                { type: 'compose', config: { template: '{{label}}' } },
                { type: 'replace', config: { replacement: '{{label}}' } },
            ],
        });
        const other = makeRule('r2', { actions: [makeAction('label')] });
        const rulesets = [makeRuleset('rs1', [rule]), makeRuleset('rs2', [other])];
        expect(detectOutOfScopeVars(rule, 'rs1', rulesets)).toEqual(['label']);
    });

    it('does not flag a $ var referenced in an action template', () => {
        const rule = makeRule('r1', {
            actions: [{ type: 'compose', config: { template: '{{$shared}}' } }],
        });
        const other = makeRule('r2', { actions: [makeAction('shared')] });
        const rulesets = [makeRuleset('rs1', [rule]), makeRuleset('rs2', [other])];
        expect(detectOutOfScopeVars(rule, 'rs1', rulesets)).toEqual([]);
    });

    it('trims whitespace inside {{ }} when matching', () => {
        const rule = makeRule('r1', {
            actions: [{ type: 'compose', config: { template: '{{ emotion }}' } }],
        });
        const other = makeRule('r2', { actions: [makeAction('emotion')] });
        const rulesets = [makeRuleset('rs1', [rule]), makeRuleset('rs2', [other])];
        expect(detectOutOfScopeVars(rule, 'rs1', rulesets)).toEqual(['emotion']);
    });
});

// ---------------------------------------------------------------------------
// Reference detection — varMatch triggers
// ---------------------------------------------------------------------------

describe('detectOutOfScopeVars — varMatch trigger scanning', () => {
    it('flags a var referenced in a varMatch trigger varName', () => {
        const rule = makeRule('r1', {
            triggers: [makeVarMatchTrigger('emotion')],
        });
        const other = makeRule('r2', { actions: [makeAction('emotion')] });
        const rulesets = [makeRuleset('rs1', [rule]), makeRuleset('rs2', [other])];
        expect(detectOutOfScopeVars(rule, 'rs1', rulesets)).toEqual(['emotion']);
    });

    it('does not flag a $ varMatch varName', () => {
        const rule = makeRule('r1', {
            triggers: [makeVarMatchTrigger('$shared')],
        });
        const other = makeRule('r2', { actions: [makeAction('shared')] });
        const rulesets = [makeRuleset('rs1', [rule]), makeRuleset('rs2', [other])];
        expect(detectOutOfScopeVars(rule, 'rs1', rulesets)).toEqual([]);
    });

    it('ignores non-varMatch triggers', () => {
        const rule = makeRule('r1', {
            triggers: [{ type: 'keyword', config: { keywords: 'emotion' } }],
        });
        const other = makeRule('r2', { actions: [makeAction('emotion')] });
        const rulesets = [makeRuleset('rs1', [rule]), makeRuleset('rs2', [other])];
        expect(detectOutOfScopeVars(rule, 'rs1', rulesets)).toEqual([]);
    });

    it('flags vars from both triggers and actions when both reference cross-scope names', () => {
        const rule = makeRule('r1', {
            triggers: [makeVarMatchTrigger('mood')],
            actions:  [{ type: 'compose', config: { template: '{{emotion}}' } }],
        });
        const other = makeRule('r2', { actions: [makeAction('emotion'), makeAction('mood')] });
        const rulesets = [makeRuleset('rs1', [rule]), makeRuleset('rs2', [other])];
        const result = detectOutOfScopeVars(rule, 'rs1', rulesets);
        expect(result).toContain('emotion');
        expect(result).toContain('mood');
    });
});

// ---------------------------------------------------------------------------
// Same-ruleset vars are never flagged
// ---------------------------------------------------------------------------

describe('detectOutOfScopeVars — same-ruleset vars are not flagged', () => {
    it('does not flag a var produced by another rule in the same ruleset', () => {
        const sibling = makeRule('r2', { actions: [makeAction('emotion')] });
        const rule    = makeRule('r1', {
            actions: [{ type: 'compose', config: { template: '{{emotion}}' } }],
        });
        const rulesets = [makeRuleset('rs1', [rule, sibling])];
        expect(detectOutOfScopeVars(rule, 'rs1', rulesets)).toEqual([]);
    });

    it('does not flag a var produced by the rule itself', () => {
        const rule = makeRule('r1', {
            actions: [
                makeAction('emotion'),
                { type: 'replace', config: { replacement: '{{emotion}}' } },
            ],
        });
        const rulesets = [makeRuleset('rs1', [rule])];
        expect(detectOutOfScopeVars(rule, 'rs1', rulesets)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Cross-ruleset var exists but is NOT referenced — no warning
// ---------------------------------------------------------------------------

describe('detectOutOfScopeVars — cross-scope var exists but is not referenced', () => {
    it('returns empty when the cross-scope var name is not used in the rule', () => {
        const rule  = makeRule('r1', {
            actions: [{ type: 'compose', config: { template: 'hello world' } }],
        });
        const other = makeRule('r2', { actions: [makeAction('emotion')] });
        const rulesets = [makeRuleset('rs1', [rule]), makeRuleset('rs2', [other])];
        expect(detectOutOfScopeVars(rule, 'rs1', rulesets)).toEqual([]);
    });

    it('returns empty when the rule has no actions and no triggers', () => {
        const rule  = makeRule('r1');
        const other = makeRule('r2', { actions: [makeAction('emotion')] });
        const rulesets = [makeRuleset('rs1', [rule]), makeRuleset('rs2', [other])];
        expect(detectOutOfScopeVars(rule, 'rs1', rulesets)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Multiple rulesets
// ---------------------------------------------------------------------------

describe('detectOutOfScopeVars — multiple other rulesets', () => {
    it('collects cross-scope names from all other rulesets', () => {
        const rule = makeRule('r1', {
            actions: [{ type: 'compose', config: { template: '{{a}} {{b}}' } }],
        });
        const rs2 = makeRuleset('rs2', [makeRule('r2', { actions: [makeAction('a')] })]);
        const rs3 = makeRuleset('rs3', [makeRule('r3', { actions: [makeAction('b')] })]);
        const rulesets = [makeRuleset('rs1', [rule]), rs2, rs3];
        const result = detectOutOfScopeVars(rule, 'rs1', rulesets);
        expect(result).toContain('a');
        expect(result).toContain('b');
    });

    it('only flags names that exist in another ruleset, not arbitrary tokens', () => {
        const rule = makeRule('r1', {
            actions: [{ type: 'compose', config: { template: '{{a}} {{keyword}} {{char}}' } }],
        });
        const rs2 = makeRuleset('rs2', [makeRule('r2', { actions: [makeAction('a')] })]);
        const rulesets = [makeRuleset('rs1', [rule]), rs2];
        expect(detectOutOfScopeVars(rule, 'rs1', rulesets)).toEqual(['a']);
    });
});
