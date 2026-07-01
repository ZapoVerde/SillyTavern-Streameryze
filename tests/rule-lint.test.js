import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../scripts/variables.js', () => ({
    getLocalVariable:  vi.fn(() => null),
    getGlobalVariable: vi.fn(() => null),
}));
vi.mock('../../../../../scripts/variables.js', () => ({
    getLocalVariable:  vi.fn(() => null),
    getGlobalVariable: vi.fn(() => null),
}));

import { lintRule } from '../settings/rule-lint.js';

function makeRuleset(id, rules) {
    return { id, name: id, enabled: true, rules };
}

describe('lintRule — dead conditions', () => {
    it('flags a condition trigger whose right-hand side is an unwrapped bare name, at that trigger\'s index', () => {
        const rule = {
            id: 'r1', name: 'R1', triggers: [
                { type: 'event', config: { event: 'MESSAGE_RECEIVED' } },
                { type: 'condition', config: { expression: 'chatvar::loc != loc' } },
            ], actions: [],
        };
        const flags = lintRule(rule, 'rs1', [makeRuleset('rs1', [rule])]);
        const flag = flags.find(f => f.message.includes('never resolve'));
        expect(flag).toMatchObject({ scope: 'trigger', index: 1 });
    });

    it('does not flag a condition using the {{varName}} reference form', () => {
        const rule = {
            id: 'r1', name: 'R1', triggers: [
                { type: 'condition', config: { expression: 'chatvar::loc != {{loc}}' } },
            ], actions: [{ type: 'compose', config: { outputVar: 'loc', template: 'x' } }],
        };
        const flags = lintRule(rule, 'rs1', [makeRuleset('rs1', [rule])]);
        expect(flags.some(f => f.message.includes('never resolve'))).toBe(false);
    });
});

describe('lintRule — unknown variable references', () => {
    it('flags a template reference to a variable no action produces, at that action\'s index', () => {
        const rule = {
            id: 'r1', name: 'R1', triggers: [],
            actions: [
                { type: 'compose', config: { outputVar: 'x', template: 'hello' } },
                { type: 'toast',   config: { message: '{{typo_var}}' } },
            ],
        };
        const flags = lintRule(rule, 'rs1', [makeRuleset('rs1', [rule])]);
        const flag = flags.find(f => f.message.includes('typo_var'));
        expect(flag).toMatchObject({ scope: 'action', index: 1 });
    });

    it('does not flag a reference to a variable produced earlier in the same rule', () => {
        const rule = {
            id: 'r1', name: 'R1', triggers: [],
            actions: [
                { type: 'compose', config: { outputVar: 'x', template: 'hello' } },
                { type: 'toast',   config: { message: '{{x}}' } },
            ],
        };
        const flags = lintRule(rule, 'rs1', [makeRuleset('rs1', [rule])]);
        expect(flags.some(f => f.message.includes('"x"'))).toBe(false);
    });

    it('does not flag a $global variable produced in a different ruleset', () => {
        const producer = {
            id: 'p1', name: 'Producer', triggers: [],
            actions: [{ type: 'compose', config: { outputVar: '$shared', template: 'x' } }],
        };
        const consumer = {
            id: 'c1', name: 'Consumer', triggers: [],
            actions: [{ type: 'toast', config: { message: '{{$shared}}' } }],
        };
        const flags = lintRule(consumer, 'rs2', [makeRuleset('rs1', [producer]), makeRuleset('rs2', [consumer])]);
        expect(flags.some(f => f.message.includes('$shared'))).toBe(false);
    });

    it('does not double-report a bare (non-$) reference to a var produced in another ruleset — detectOutOfScopeVars already covers it', () => {
        const producer = {
            id: 'p1', name: 'Producer', triggers: [],
            actions: [{ type: 'compose', config: { outputVar: 'notGlobal', template: 'x' } }],
        };
        const consumer = {
            id: 'c1', name: 'Consumer', triggers: [],
            actions: [{ type: 'toast', config: { message: '{{notGlobal}}' } }],
        };
        const flags = lintRule(consumer, 'rs2', [makeRuleset('rs1', [producer]), makeRuleset('rs2', [consumer])]);
        expect(flags.some(f => f.message.includes('notGlobal'))).toBe(false);
    });

    it('does not double-report the same name referenced twice in one action', () => {
        const rule = {
            id: 'r1', name: 'R1', triggers: [],
            actions: [{ type: 'toast', config: { message: '{{typo_var}} and {{typo_var}} again' } }],
        };
        const flags = lintRule(rule, 'rs1', [makeRuleset('rs1', [rule])]);
        expect(flags.filter(f => f.message.includes('typo_var')).length).toBe(1);
    });
});

describe('lintRule — statically empty required fields', () => {
    it('flags an update(lorebook) action with empty lorebook and title, at that action\'s index', () => {
        const rule = {
            id: 'r1', name: 'R1', triggers: [],
            actions: [
                { type: 'toast', config: { message: 'hi' } },
                { type: 'update', config: { target: 'lorebook', lorebook: '', title: '' } },
            ],
        };
        const flags = lintRule(rule, 'rs1', [makeRuleset('rs1', [rule])]);
        const empties = flags.filter(f => f.message.includes('always fail'));
        expect(empties.length).toBe(2);
        expect(empties.every(f => f.scope === 'action' && f.index === 1)).toBe(true);
    });

    it('does not flag when the field has a {{...}} template, even if currently empty-looking', () => {
        const rule = {
            id: 'r1', name: 'R1', triggers: [],
            actions: [{ type: 'update', config: { target: 'lorebook', lorebook: '{{lb}}', title: '{{title}}' } }],
        };
        const flags = lintRule(rule, 'rs1', [makeRuleset('rs1', [rule])]);
        expect(flags.some(f => f.message.includes('always fail'))).toBe(false);
    });

    it('flags a call-llm (sideCall) action with an empty prompt', () => {
        const rule = {
            id: 'r1', name: 'R1', triggers: [],
            actions: [{ type: 'sideCall', config: { prompt: '' } }],
        };
        const flags = lintRule(rule, 'rs1', [makeRuleset('rs1', [rule])]);
        expect(flags.some(f => f.message.includes('prompt'))).toBe(true);
    });
});

describe('lintRule — dead-end outputs', () => {
    it('flags an outputVar never referenced anywhere else, at the producing action\'s index', () => {
        const rule = {
            id: 'r1', name: 'R1', triggers: [],
            actions: [
                { type: 'toast', config: { message: 'hi' } },
                { type: 'compose', config: { outputVar: 'unused', template: 'hello' } },
            ],
        };
        const flags = lintRule(rule, 'rs1', [makeRuleset('rs1', [rule])]);
        const flag = flags.find(f => f.message.includes('unused'));
        expect(flag).toMatchObject({ scope: 'action', index: 1 });
    });

    it('does not flag an outputVar read by a var-match in another rule', () => {
        const producer = {
            id: 'p1', name: 'Producer', triggers: [],
            actions: [{ type: 'compose', config: { outputVar: 'flag', template: 'true' } }],
        };
        const consumer = {
            id: 'c1', name: 'Consumer',
            triggers: [{ type: 'varMatch', config: { varName: 'flag', operator: 'equals', value: 'true' } }],
            actions: [],
        };
        const flags = lintRule(producer, 'rs1', [makeRuleset('rs1', [producer, consumer])]);
        expect(flags.some(f => f.message.includes('flag'))).toBe(false);
    });
});
