import { vi, describe, it, expect, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — mirror event-routing.test.js (same engine.js dependency surface)
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
    getSettings:     vi.fn(() => ({ rules: [], verbose: false, enabled: true })),
    getEnabledRules: vi.fn((s) => (s.rules ?? []).filter(r => r.enabled !== false)),
}));

vi.mock('../badge.js', () => ({
    ensureBadge:                    vi.fn(),
    setBadge:                       vi.fn(),
    renderRuleBadges:               vi.fn(),
    clearAllMessageBadges:          vi.fn(),
    removeAllBadges:                vi.fn(),
    reinjectAllBadges:              vi.fn(),
    injectInlineBadges:             vi.fn(),
    removeAllInlineBadges:          vi.fn(),
    reinjectAllInlineBadges:        vi.fn(),
    buildResolvedPatterns:          vi.fn(async () => []),
    injectPatternsIntoEl:           vi.fn(),
    stopInlineBadgeRemovalWatcher:  vi.fn(),
    startInlineBadgeRemovalWatcher: vi.fn(),
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
    executeActions:    vi.fn(async () => {}),
    applyEarlyActions: vi.fn(async () => {}),
    clearEarlyFired:   vi.fn(),
}));

import { onMessageReceived, cancelCurrentOperations } from '../engine.js';
import { getSettings }                                from '../settings/storage.js';
import { evaluateTriggers, ruleHasStage }             from '../engine/evaluate.js';
import { executeActions }                              from '../engine/execute.js';
import { setBadge }                                    from '../badge.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRule(id) {
    return { id, name: id, enabled: true, when: 'any', triggers: [], actions: [] };
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSettings).mockReturnValue({ rules: [], verbose: false, enabled: true });
    vi.mocked(evaluateTriggers).mockResolvedValue(null);
    vi.mocked(ruleHasStage).mockReturnValue(false);
    global.window    = { SillyTavern: { getContext: () => ({ chat: [{ is_user: false, mes: 'hello' }] }) } };
    global.document  = { querySelector: vi.fn(() => null) };
    global.performance = { now: () => 0 };
});

// ---------------------------------------------------------------------------
// cancelCurrentOperations
// ---------------------------------------------------------------------------

describe('cancelCurrentOperations', () => {
    it('stops the postMessage loop before a second rule fires', async () => {
        const r1 = makeRule('r1');
        const r2 = makeRule('r2');
        vi.mocked(getSettings).mockReturnValue({ rules: [r1, r2], enabled: true });
        vi.mocked(ruleHasStage).mockReturnValue(true);
        // Both triggers match
        vi.mocked(evaluateTriggers).mockResolvedValue('kw');

        const r1Execute = vi.fn(async () => { cancelCurrentOperations(); });
        const r2Execute = vi.fn(async () => {});

        // First executeActions call cancels; second should never be reached
        vi.mocked(executeActions)
            .mockImplementationOnce(r1Execute)
            .mockImplementation(r2Execute);

        await onMessageReceived(0);

        expect(r1Execute).toHaveBeenCalledOnce();
        expect(r2Execute).not.toHaveBeenCalled();
    });

    it('sets badge to modified after the cancelled action completes', async () => {
        const r1 = makeRule('r1');
        vi.mocked(getSettings).mockReturnValue({ rules: [r1], enabled: true });
        vi.mocked(ruleHasStage).mockReturnValue(true);
        vi.mocked(evaluateTriggers).mockResolvedValue('kw');
        vi.mocked(executeActions).mockImplementationOnce(async () => { cancelCurrentOperations(); });

        await onMessageReceived(0);

        // The loop sets 'thinking' before executeActions and 'modified' after it returns
        expect(setBadge).toHaveBeenCalledWith(0, 'thinking');
        expect(setBadge).toHaveBeenCalledWith(0, 'modified');
    });

    it('allows a subsequent onMessageReceived to run normally after cancellation', async () => {
        cancelCurrentOperations();

        const r1 = makeRule('r1');
        vi.mocked(getSettings).mockReturnValue({ rules: [r1], enabled: true });
        vi.mocked(ruleHasStage).mockReturnValue(true);
        vi.mocked(evaluateTriggers).mockResolvedValue('kw');

        await onMessageReceived(0);

        expect(executeActions).toHaveBeenCalledOnce();
    });
});
