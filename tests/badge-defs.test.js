import { vi, describe, it, expect, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks for engine.js dependencies
// ---------------------------------------------------------------------------

vi.mock('../../../../scripts/world-info.js', () => ({
    getSortedEntries:          vi.fn(async () => []),
    parseRegexFromString:      vi.fn(() => null),
    world_info_case_sensitive: false,
}));

vi.mock('../../../../scripts/variables.js', () => ({
    getLocalVariable:  vi.fn(() => null),
    getGlobalVariable: vi.fn(() => null),
}));

vi.mock('../../../../../scripts/variables.js', () => ({
    getLocalVariable:  vi.fn(() => null),
    getGlobalVariable: vi.fn(() => null),
}));

vi.mock('../settings/storage.js', () => ({
    getSettings:      vi.fn(() => ({ rules: [], verbose: false })),
    getEnabledRules:  vi.fn((s) => (s.rules ?? []).filter(r => r.enabled !== false)),
}));

vi.mock('../badge.js', () => ({
    ensureBadge:             vi.fn(),
    setBadge:                vi.fn(),
    renderRuleBadges:        vi.fn(),
    removeAllBadges:         vi.fn(),
    reinjectAllBadges:       vi.fn(),
    injectInlineBadges:      vi.fn(),
    removeAllInlineBadges:   vi.fn(),
    reinjectAllInlineBadges: vi.fn(),
    buildResolvedPatterns:   vi.fn(async () => []),
    injectPatternsIntoEl:    vi.fn(),
}));

vi.mock('../actions/index.js', () => ({
    clearPrefetchCache: vi.fn(),
    isDispatchActive:   vi.fn(() => false),
}));

vi.mock('../engine/evaluate.js', () => ({
    evaluateTriggers: vi.fn(async () => null),
    ruleHasStage:     vi.fn(() => false),
}));

vi.mock('../engine/live-patch.js', () => ({
    stopPatchObserver:       vi.fn(),
    applyLivePatch:          vi.fn(),
    applyPrefetch:           vi.fn(),
    applyInlineBadgePatch:   vi.fn(),
    clearLivePatchState:     vi.fn(),
    highlightPendingKeyword: vi.fn(),
    clearPendingHighlights:  vi.fn(),
}));

vi.mock('../engine/execute.js', () => ({
    executeActions:    vi.fn(),
    applyEarlyActions: vi.fn(),
    clearEarlyFired:   vi.fn(),
}));

import { reinjectRuleBadges, reinjectInlineBadges } from '../engine.js';
import { getSettings } from '../settings/storage.js';
import { renderRuleBadges, injectInlineBadges } from '../badge.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRule(id, triggerType, triggerConfig, overrides = {}) {
    return {
        id, name: id, enabled: true, when: 'any',
        triggers: [{ type: triggerType, config: triggerConfig }],
        actions:  [],
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSettings).mockReturnValue({ rules: [], verbose: false });
});

// ---------------------------------------------------------------------------
// reinjectRuleBadges — badge defs routing
// ---------------------------------------------------------------------------

describe('reinjectRuleBadges — badge defs routing', () => {
    it('passes correct defs for a top-style badge trigger', () => {
        vi.mocked(getSettings).mockReturnValue({ rules: [
            makeRule('r1', 'badge', { style: 'top', label: 'Go', color: '#ff0000', splitOn: '', clickAction: 'fire' }),
        ]});
        reinjectRuleBadges(0);
        expect(renderRuleBadges).toHaveBeenCalledWith(0, [
            { ruleId: 'r1', label: 'Go', color: '#ff0000', style: 'top', splitOn: '', clickAction: 'fire' },
        ]);
    });

    it('passes correct defs for a bottom-style badge trigger', () => {
        vi.mocked(getSettings).mockReturnValue({ rules: [
            makeRule('r1', 'badge', { style: 'bottom', label: '{{opts}}', color: '#8888ff', splitOn: '\\n', clickAction: 'inject-send' }),
        ]});
        reinjectRuleBadges(0);
        expect(renderRuleBadges).toHaveBeenCalledWith(0, [
            { ruleId: 'r1', label: '{{opts}}', color: '#8888ff', style: 'bottom', splitOn: '\\n', clickAction: 'inject-send' },
        ]);
    });

    it('inline-style badge trigger is excluded from rule badge defs', () => {
        vi.mocked(getSettings).mockReturnValue({ rules: [
            makeRule('r1', 'badge', { style: 'inline', keywords: 'dragon', color: '#8888ff', clickAction: 'fire' }),
        ]});
        reinjectRuleBadges(0);
        expect(renderRuleBadges).toHaveBeenCalledWith(0, []);
    });

    it('legacy badgeTrigger type is treated as style top (backward compat)', () => {
        vi.mocked(getSettings).mockReturnValue({ rules: [
            makeRule('r1', 'badgeTrigger', { label: 'old', color: '#aaaaaa' }),
        ]});
        reinjectRuleBadges(0);
        const [, defs] = vi.mocked(renderRuleBadges).mock.calls[0];
        expect(defs).toHaveLength(1);
        expect(defs[0].style).toBe('top');
        expect(defs[0].label).toBe('old');
        expect(defs[0].clickAction).toBe('fire');
    });

    it('splitOn and clickAction flow through to defs', () => {
        vi.mocked(getSettings).mockReturnValue({ rules: [
            makeRule('r1', 'badge', { style: 'bottom', label: 'a', color: '#8888ff', splitOn: ',', clickAction: 'inject' }),
        ]});
        reinjectRuleBadges(0);
        const [, defs] = vi.mocked(renderRuleBadges).mock.calls[0];
        expect(defs[0].splitOn).toBe(',');
        expect(defs[0].clickAction).toBe('inject');
    });

    it('disabled rules are excluded', () => {
        vi.mocked(getSettings).mockReturnValue({ rules: [
            makeRule('r1', 'badge', { style: 'top', label: 'Run', color: '#8888ff', splitOn: '', clickAction: 'fire' }, { enabled: false }),
        ]});
        reinjectRuleBadges(0);
        expect(renderRuleBadges).toHaveBeenCalledWith(0, []);
    });

    it('rules without a badge trigger are excluded', () => {
        vi.mocked(getSettings).mockReturnValue({ rules: [
            makeRule('r1', 'keywordMatch', { keywords: 'dragon' }),
        ]});
        reinjectRuleBadges(0);
        expect(renderRuleBadges).toHaveBeenCalledWith(0, []);
    });

    it('multiple rules produce multiple defs in order', () => {
        vi.mocked(getSettings).mockReturnValue({ rules: [
            makeRule('r1', 'badge', { style: 'top',    label: 'A', color: '#f00', splitOn: '', clickAction: 'fire' }),
            makeRule('r2', 'badge', { style: 'bottom', label: 'B', color: '#0f0', splitOn: '', clickAction: 'inject-send' }),
        ]});
        reinjectRuleBadges(0);
        const [, defs] = vi.mocked(renderRuleBadges).mock.calls[0];
        expect(defs).toHaveLength(2);
        expect(defs[0].ruleId).toBe('r1');
        expect(defs[1].ruleId).toBe('r2');
    });
});

// ---------------------------------------------------------------------------
// reinjectInlineBadges — inline defs routing
// ---------------------------------------------------------------------------

describe('reinjectInlineBadges — inline defs routing', () => {
    it('passes correct defs for an inline-style badge trigger', () => {
        vi.mocked(getSettings).mockReturnValue({ rules: [
            makeRule('r1', 'badge', { style: 'inline', keywords: 'dragon, sword', caseSensitive: true, color: '#ff0000', clickAction: 'fire' }),
        ]});
        reinjectInlineBadges(0);
        expect(injectInlineBadges).toHaveBeenCalledWith(0, [
            { ruleId: 'r1', keywords: 'dragon, sword', caseSensitive: true, color: '#ff0000', clickAction: 'fire' },
        ]);
    });

    it('legacy inlineBadge type is picked up (backward compat)', () => {
        vi.mocked(getSettings).mockReturnValue({ rules: [
            makeRule('r1', 'inlineBadge', { keywords: 'fire', caseSensitive: false, color: '#8888ff' }),
        ]});
        reinjectInlineBadges(0);
        const [, defs] = vi.mocked(injectInlineBadges).mock.calls[0];
        expect(defs).toHaveLength(1);
        expect(defs[0].ruleId).toBe('r1');
        expect(defs[0].keywords).toBe('fire');
        expect(defs[0].clickAction).toBe('fire');
    });

    it('top and bottom badge triggers are excluded from inline defs', () => {
        vi.mocked(getSettings).mockReturnValue({ rules: [
            makeRule('r1', 'badge', { style: 'top',    label: 'Go', color: '#8888ff', splitOn: '', clickAction: 'fire' }),
            makeRule('r2', 'badge', { style: 'bottom', label: 'Go', color: '#8888ff', splitOn: '', clickAction: 'fire' }),
        ]});
        reinjectInlineBadges(0);
        expect(injectInlineBadges).toHaveBeenCalledWith(0, []);
    });

    it('legacy badgeTrigger type is excluded from inline defs', () => {
        vi.mocked(getSettings).mockReturnValue({ rules: [
            makeRule('r1', 'badgeTrigger', { label: 'run', color: '#8888ff' }),
        ]});
        reinjectInlineBadges(0);
        expect(injectInlineBadges).toHaveBeenCalledWith(0, []);
    });

    it('disabled rules are excluded', () => {
        vi.mocked(getSettings).mockReturnValue({ rules: [
            makeRule('r1', 'badge', { style: 'inline', keywords: 'word', caseSensitive: false, color: '#8888ff', clickAction: 'fire' }, { enabled: false }),
        ]});
        reinjectInlineBadges(0);
        expect(injectInlineBadges).toHaveBeenCalledWith(0, []);
    });
});
