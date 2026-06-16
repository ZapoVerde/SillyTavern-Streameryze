import { vi, describe, it, expect, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — mirror badge-defs.test.js (same engine.js dependency surface)
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

import { onGenerationStarted, onCharacterMessageRendered } from '../engine.js';
import { getSettings }                                     from '../settings/storage.js';
import { evaluateTriggers, ruleHasStage }                  from '../engine/evaluate.js';
import { executeActions }                                   from '../engine/execute.js';

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
    vi.mocked(getSettings).mockReturnValue({ rules: [], verbose: false, enabled: true });
    vi.mocked(evaluateTriggers).mockResolvedValue(null);
    vi.mocked(ruleHasStage).mockReturnValue(false);
    // Provide a minimal window stub — engine uses window.SillyTavern?.getContext?.() (optional chain)
    global.window = {};
});

// ---------------------------------------------------------------------------
// onGenerationStarted — event:GENERATION_STARTED routing
// ---------------------------------------------------------------------------

describe('onGenerationStarted — event:GENERATION_STARTED routing', () => {
    it('fires a matching rule when evaluateTriggers returns a match', async () => {
        const rule = makeRule('r1', 'event', { event: 'GENERATION_STARTED' });
        vi.mocked(getSettings).mockReturnValue({ rules: [rule], verbose: false, enabled: true });
        vi.mocked(ruleHasStage).mockReturnValue(true);
        vi.mocked(evaluateTriggers).mockResolvedValue('GENERATION_STARTED');

        await onGenerationStarted();

        expect(executeActions).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'r1' }),
            'postMessage',
            expect.anything(),
            expect.any(Function),
        );
    });

    it('does not fire a rule when evaluateTriggers returns null', async () => {
        const rule = makeRule('r1', 'event', { event: 'GENERATION_STARTED' });
        vi.mocked(getSettings).mockReturnValue({ rules: [rule], verbose: false, enabled: true });
        vi.mocked(ruleHasStage).mockReturnValue(true);
        vi.mocked(evaluateTriggers).mockResolvedValue(null);

        await onGenerationStarted();

        expect(executeActions).not.toHaveBeenCalled();
    });

    it('ignores rules without event:GENERATION_STARTED trigger', async () => {
        const rule = makeRule('r1', 'event', { event: 'MESSAGE_RECEIVED' });
        vi.mocked(getSettings).mockReturnValue({ rules: [rule], verbose: false, enabled: true });
        vi.mocked(ruleHasStage).mockReturnValue(true);
        vi.mocked(evaluateTriggers).mockResolvedValue('MESSAGE_RECEIVED');

        await onGenerationStarted();

        expect(executeActions).not.toHaveBeenCalled();
    });

    it('ignores rules with event:GENERATION_STARTED but no postMessage stage', async () => {
        const rule = makeRule('r1', 'event', { event: 'GENERATION_STARTED' });
        vi.mocked(getSettings).mockReturnValue({ rules: [rule], verbose: false, enabled: true });
        vi.mocked(ruleHasStage).mockReturnValue(false);

        await onGenerationStarted();

        expect(executeActions).not.toHaveBeenCalled();
    });

    it('ignores disabled rules', async () => {
        const rule = makeRule('r1', 'event', { event: 'GENERATION_STARTED' }, { enabled: false });
        vi.mocked(getSettings).mockReturnValue({ rules: [rule], verbose: false, enabled: true });
        vi.mocked(ruleHasStage).mockReturnValue(true);
        vi.mocked(evaluateTriggers).mockResolvedValue('GENERATION_STARTED');

        await onGenerationStarted();

        expect(executeActions).not.toHaveBeenCalled();
    });

    it('does nothing when the extension is disabled', async () => {
        const rule = makeRule('r1', 'event', { event: 'GENERATION_STARTED' });
        vi.mocked(getSettings).mockReturnValue({ rules: [rule], verbose: false, enabled: false });
        vi.mocked(ruleHasStage).mockReturnValue(true);
        vi.mocked(evaluateTriggers).mockResolvedValue('GENERATION_STARTED');

        await onGenerationStarted();

        expect(executeActions).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// onCharacterMessageRendered — event:CHARACTER_MESSAGE_RENDERED routing
// ---------------------------------------------------------------------------

describe('onCharacterMessageRendered — event:CHARACTER_MESSAGE_RENDERED routing', () => {
    it('fires a matching rule for the given messageId when it is the last AI message', async () => {
        const rule = makeRule('r1', 'event', { event: 'CHARACTER_MESSAGE_RENDERED' });
        vi.mocked(getSettings).mockReturnValue({ rules: [rule], verbose: false, enabled: true });
        vi.mocked(ruleHasStage).mockReturnValue(true);
        vi.mocked(evaluateTriggers).mockResolvedValue('CHARACTER_MESSAGE_RENDERED');
        // Build a 6-entry chat where index 5 is the last AI message
        global.window = {
            SillyTavern: { getContext: () => ({
                chat: Array.from({ length: 6 }, (_, i) => ({ is_user: i % 2 === 0 ? true : false }))
                    .map((m, i) => (i === 5 ? { is_user: false } : m)),
            }) },
        };

        await onCharacterMessageRendered(5);

        expect(executeActions).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'r1' }),
            'postMessage',
            expect.objectContaining({ messageId: 5 }),
            expect.any(Function),
        );
    });

    it('does not fire when evaluateTriggers returns null', async () => {
        const rule = makeRule('r1', 'event', { event: 'CHARACTER_MESSAGE_RENDERED' });
        vi.mocked(getSettings).mockReturnValue({ rules: [rule], verbose: false, enabled: true });
        vi.mocked(ruleHasStage).mockReturnValue(true);
        vi.mocked(evaluateTriggers).mockResolvedValue(null);

        await onCharacterMessageRendered(5);

        expect(executeActions).not.toHaveBeenCalled();
    });

    it('ignores rules without event:CHARACTER_MESSAGE_RENDERED trigger', async () => {
        const rule = makeRule('r1', 'event', { event: 'MESSAGE_RECEIVED' });
        vi.mocked(getSettings).mockReturnValue({ rules: [rule], verbose: false, enabled: true });
        vi.mocked(ruleHasStage).mockReturnValue(true);

        await onCharacterMessageRendered(5);

        expect(executeActions).not.toHaveBeenCalled();
    });

    it('does nothing when the extension is disabled', async () => {
        const rule = makeRule('r1', 'event', { event: 'CHARACTER_MESSAGE_RENDERED' });
        vi.mocked(getSettings).mockReturnValue({ rules: [rule], verbose: false, enabled: false });
        vi.mocked(ruleHasStage).mockReturnValue(true);
        vi.mocked(evaluateTriggers).mockResolvedValue('CHARACTER_MESSAGE_RENDERED');

        await onCharacterMessageRendered(5);

        expect(executeActions).not.toHaveBeenCalled();
    });

    it('skips historical messages on chat load — only fires for the last AI message', async () => {
        const rule = makeRule('r1', 'event', { event: 'CHARACTER_MESSAGE_RENDERED' });
        vi.mocked(getSettings).mockReturnValue({ rules: [rule], verbose: false, enabled: true });
        vi.mocked(ruleHasStage).mockReturnValue(true);
        vi.mocked(evaluateTriggers).mockResolvedValue('CHARACTER_MESSAGE_RENDERED');
        // Chat has 3 messages: AI(0), user(1), AI(2) — last AI is index 2
        global.window = {
            SillyTavern: { getContext: () => ({
                chat: [
                    { is_user: false },
                    { is_user: true  },
                    { is_user: false },
                ],
            }) },
        };

        await onCharacterMessageRendered(0); // historical AI message — should skip
        expect(executeActions).not.toHaveBeenCalled();

        await onCharacterMessageRendered(2); // last AI message — should fire
        expect(executeActions).toHaveBeenCalledOnce();
    });
});
