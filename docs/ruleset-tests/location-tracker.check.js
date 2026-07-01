/**
 * Automated harness check for docs/examples/location-tracker.json.
 *
 * Not part of the default `npm test` run — location-tracker.json is documentation
 * content, not engine code, and can change independently of it. Run explicitly with
 * `npm run test:rulesets` when touching this example (or the engine paths it exercises:
 * getVarDeps sequencing, the condition evaluator, lorebook inactive-scope queries).
 *
 * See docs/ruleset-harness.md for what this checks and why it's separate from
 * docs/test-ruleset.md's manual in-ST toast methodology.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';

const { stVarStore, lbStore } = vi.hoisted(() => ({
    stVarStore: new Map(),
    lbStore:    new Map(),
}));

vi.mock('../../../../../script.js', () => ({
    eventSource:          { emit: vi.fn() },
    event_types:          { MESSAGE_UPDATED: 'MESSAGE_UPDATED', WORLDINFO_UPDATED: 'WORLDINFO_UPDATED' },
    name1:                'Alice',
    name2:                'Bot',
    addOneMessage:        vi.fn(),
    updateMessageBlock:   vi.fn(),
    appendMediaToMessage: vi.fn(),
    callPopup:            vi.fn(async () => false),
    getRequestHeaders:    vi.fn(() => ({})),
    generateQuietPrompt:  vi.fn(async () => ({ content: '' })),
    messageFormatting:    vi.fn(() => ''),
    itemizedPrompts:      [],
    saveSettingsDebounced: vi.fn(),
}));
vi.mock('../../../../../scripts/openai.js', () => ({ oai_settings: { prompts: [] }, promptManager: null }));
vi.mock('../../../../../scripts/itemized-prompts.js', () => ({ itemizedPrompts: [] }));

vi.mock('../../../../scripts/world-info.js', () => ({
    getSortedEntries:          vi.fn(async () => []),
    parseRegexFromString:      vi.fn(() => null),
    world_info_case_sensitive: false,
    loadWorldInfo:             vi.fn(async () => ({ entries: {} })),
    world_names:               [],
}));
vi.mock('../../../../../scripts/world-info.js', () => ({
    getSortedEntries:          vi.fn(async () => []),   // nothing "active" — trg_utility is inactive-scope
    parseRegexFromString:      vi.fn(() => null),
    world_info_case_sensitive: false,
    loadWorldInfo:             vi.fn(async (name) => {
        // Real async hop to mimic real disk/HTTP latency — this is what exposes
        // same-rule sibling-action races that a synchronous mock would hide.
        await new Promise(r => setTimeout(r, 5));
        const stored = lbStore.get(name);
        return stored ? { entries: { ...stored.entries } } : { entries: {} };
    }),
    get world_names() { return [...lbStore.keys()]; },
}));

vi.mock('../../../../scripts/variables.js', () => ({
    getLocalVariable:  vi.fn(() => null),
    getGlobalVariable: vi.fn(() => null),
}));
vi.mock('../../../../../scripts/variables.js', () => ({
    getLocalVariable:  (name) => stVarStore.get(name) ?? null,
    getGlobalVariable: (name) => stVarStore.get(`global:${name}`) ?? null,
    setLocalVariable:  (name, value) => stVarStore.set(name, value),
    setGlobalVariable: (name, value) => stVarStore.set(`global:${name}`, value),
}));

vi.mock('../../lorebookApi.js', () => ({
    lbGetLorebook: async (name) => {
        const stored = lbStore.get(name);
        return stored ? { entries: { ...stored.entries } } : { entries: {} };
    },
    lbSaveLorebook: async (name, data) => { lbStore.set(name, { entries: { ...data.entries } }); },
}));

vi.mock('../../engine/live-patch.js', () => ({
    hasLiveResult:       vi.fn(() => false),
    setLiveResult:       vi.fn(),
    stopPatchObserver:   vi.fn(),
    clearLivePatchState: vi.fn(),
}));

vi.mock('../../badge.js', () => ({
    ensureBadge:           vi.fn(),
    setBadge:              vi.fn(),
    renderRuleBadges:      vi.fn(),
    clearRuleBadges:       vi.fn(),
    clearAllMessageBadges: vi.fn(),
}));

// Only the action types this ruleset actually uses — avoids needing to mock every other
// action's ST dependencies (preset-manager.js, imageGen.js, etc).
vi.mock('../../actions/index.js', () => ({ ACTION_REGISTRY: {}, makeActionCtx: vi.fn() }));

const { mockDispatch } = vi.hoisted(() => ({ mockDispatch: vi.fn() }));
vi.mock('../../actions/dispatch.js', () => ({
    dispatch: mockDispatch,
    getPrefetchedResults: () => null,
    isDispatchActive: () => false,
    clearPrefetchCache: vi.fn(),
    prefetchSideCall: vi.fn(),
}));

vi.mock('../../settings/storage.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, getSettings: () => globalThis.__trgSettings };
});

// ---------------------------------------------------------------------------
// Real modules under test
// ---------------------------------------------------------------------------

import { rebuildRegistry }    from '../../engine/rule-registry.js';
import { clearTurnState, getTurnVar } from '../../engine/turn-state.js';
import { clearWiCache }       from '../../triggers/lb-query.js';
import { makeId }             from '../../settings/storage.js';
import { ACTION_REGISTRY }    from '../../actions/index.js';
import { compose }            from '../../actions/compose.js';
import { update }             from '../../actions/update.js';
import { slashCmd }           from '../../actions/slash-cmd.js';
import { toast }              from '../../actions/toast.js';
import { sideCall }           from '../../actions/side-call.js';
import { makeStCtx, loadRulesetFromFile, simulateTurn } from '../../tests/ruleset-harness.js';
import { lintRule }           from '../../settings/rule-lint.js';

Object.assign(ACTION_REGISTRY, { compose, update, slashCmd, toast, sideCall });

// The canonical file lives in docs/examples/ — imported by relative path so this check
// always tracks the real doc, not a stale copy.
const canonicalPath = path.resolve(__dirname, '../examples/location-tracker.json');

let executedCommands;

beforeEach(() => {
    clearTurnState();
    clearWiCache();
    stVarStore.clear();
    lbStore.clear();
    executedCommands = [];

    const { ruleset, warnings } = loadRulesetFromFile(canonicalPath, makeId);
    expect(warnings).toEqual([]);

    globalThis.__trgSettings = { enabled: true, verbose: false, showBadges: true, rulesets: [ruleset] };
    rebuildRegistry();
});

function wireStCtx(mes) {
    const stCtx = makeStCtx(mes, {
        executeSlashCommandsWithOptions: vi.fn(async (cmd) => { executedCommands.push(cmd); return { pipe: '' }; }),
    });
    vi.stubGlobal('window', {
        SillyTavern: { getContext: () => stCtx },
        toastr: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() },
    });
    return stCtx;
}

describe('location-tracker.json — known-location revisit', () => {
    it('primary path: a well-formed header for an already-known location injects, does not discover', async () => {
        lbStore.set('trg_utility', {
            entries: {
                0: { uid: 0, comment: 'The Tavern - Common Room', content: '',
                     key: ['test-chat', 'location', 'The Tavern'], disable: false },
            },
        });
        stVarStore.set('LT-current_loc', 'The Old Place');

        const headerText =
            '[ Morning | 🗓️ Monday, June 01, 2026 | 📍 The Tavern - Common Room]\nPresent: Bob';
        wireStCtx(headerText);

        await simulateTurn({ messageText: headerText });

        expect(getTurnVar('LT-current_loc', globalThis.__trgSettings.rulesets[0].id))
            .toBe('The Tavern - Common Room');
        expect(executedCommands).toEqual(['/vlz-inject-location The Tavern - Common Room']);
    });

    it('fallback path: a missing header for an already-known location injects, does not discover', async () => {
        lbStore.set('trg_utility', {
            entries: {
                0: { uid: 0, comment: 'The Tavern - Common Room', content: '',
                     key: ['test-chat', 'location', 'The Tavern'], disable: false },
            },
        });
        stVarStore.set('LT-current_loc', 'The Tavern - Common Room'); // unchanged from last turn

        const messageText = 'Bob walks into the common room and sits down.'; // no 📍 header at all
        mockDispatch.mockResolvedValue(
            '[ Morning | 🗓️ Monday, June 01, 2026 | 📍 The Tavern - Common Room]\nPresent: Bob',
        );
        wireStCtx(messageText);

        await simulateTurn({ messageText });

        expect(executedCommands).toEqual(['/vlz-inject-location The Tavern - Common Room']);
    });
});

describe('location-tracker.json — static lint', () => {
    it('has no rule-lint red flags', () => {
        const ruleset = globalThis.__trgSettings.rulesets[0];
        for (const rule of ruleset.rules) {
            const flags = lintRule(rule, ruleset.id, globalThis.__trgSettings.rulesets);
            expect(flags, `rule "${rule.name}": ${flags.map(f => f.message).join('; ')}`).toEqual([]);
        }
    });
});
