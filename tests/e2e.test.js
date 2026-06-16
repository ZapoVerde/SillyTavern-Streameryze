/**
 * End-to-end pipeline tests.
 *
 * Each test defines a complete rule (triggers + actions), drives it through the
 * real evaluateTriggers → executeActions stack, and asserts the observable output.
 * The ST boundary (DOM, HTTP, events) is mocked; all extension logic is real.
 *
 * One lane per functional pathway:
 *   1. Keyword → compose → replace (chain / var sequencing)
 *   2. Math in compose template
 *   3. AND trigger gate (all triggers must match)
 *   4. OR trigger gate (any trigger matches)
 *   5. Chance trigger (probability gate)
 *   6. Condition trigger (chatvar evaluated in a condition)
 *   7. Lorebook write via update action
 *   8. ST variable write (set-stvar) → turn-var read-back
 *   9. Imaging pathway (action routing to imageGen)
 *  10. Disabled rule is a no-op
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Shared in-memory stores — created before mock factories run
// ---------------------------------------------------------------------------

const { stVarStore, lbStore } = vi.hoisted(() => ({
    stVarStore: new Map(),  // backing store for ST chat/global variables
    lbStore:    new Map(),  // backing store for lorebook HTTP calls
}));

// ---------------------------------------------------------------------------
// Mock: external ST boundary (files that do not exist on disk in test env)
// ---------------------------------------------------------------------------

vi.mock('../../../../../script.js', () => ({
    eventSource:        { emit: vi.fn() },
    event_types:        { MESSAGE_UPDATED: 'MESSAGE_UPDATED', WORLDINFO_UPDATED: 'WORLDINFO_UPDATED' },
    name1:              'Alice',
    name2:              'Bot',
    addOneMessage:      vi.fn(),
    updateMessageBlock: vi.fn(),
    appendMediaToMessage: vi.fn(),
    callPopup:          vi.fn(async () => false),
    getRequestHeaders:  vi.fn(() => ({})),
    generateQuietPrompt: vi.fn(async () => ({ content: '' })),
    messageFormatting:  vi.fn(() => ''),
    itemizedPrompts:    [],
}));
vi.mock('../../../../../scripts/openai.js', () => ({ oai_settings: { prompts: [] } }));

// triggers.js (project root) uses 4-up paths to reach world-info and variables.
// triggers/ submodules (lb-query.js, keyword.js) use 5-up — mirror both.
vi.mock('../../../../scripts/world-info.js', () => ({
    getSortedEntries:          vi.fn(async () => []),
    parseRegexFromString:      vi.fn(() => null),
    world_info_case_sensitive: false,
}));
vi.mock('../../../../../scripts/world-info.js', () => ({
    getSortedEntries:          vi.fn(async () => []),
    parseRegexFromString:      vi.fn(() => null),
    world_info_case_sensitive: false,
}));

vi.mock('../../../../scripts/variables.js', () => ({
    getLocalVariable:  vi.fn(() => null),
    getGlobalVariable: vi.fn(() => null),
}));

// actions/ and condition.js use 5-up paths — back them with the in-memory store
vi.mock('../../../../../scripts/variables.js', () => ({
    getLocalVariable:  (name, opts = {}) => {
        const key = opts?.index !== undefined ? `${name}[${opts.index}]` : name;
        return stVarStore.get(key) ?? null;
    },
    getGlobalVariable: (name, opts = {}) => stVarStore.get(`global:${name}`) ?? null,
    setLocalVariable:  (name, value, opts = {}) => {
        const key = opts?.index !== undefined ? `${name}[${opts.index}]` : name;
        stVarStore.set(key, value);
    },
    setGlobalVariable: (name, value) => stVarStore.set(`global:${name}`, value),
}));

// ---------------------------------------------------------------------------
// Mock: local files with external dependencies
// ---------------------------------------------------------------------------

// Lorebook HTTP layer — backed by lbStore
vi.mock('../lorebookApi.js', () => ({
    lbGetLorebook: async (name) => {
        const stored = lbStore.get(name);
        return stored ? { ...stored, entries: { ...stored.entries } } : { entries: {} };
    },
    lbSaveLorebook: async (name, data) => { lbStore.set(name, data); },
}));

// live-patch.js — DOM-heavy; provide minimal stubs used by execute.js
vi.mock('../engine/live-patch.js', () => ({
    hasLiveResult:       vi.fn(() => false),
    setLiveResult:       vi.fn(),
    stopPatchObserver:   vi.fn(),
    clearLivePatchState: vi.fn(),
}));

// settings/storage.js — return empty settings (no rules, not verbose)
vi.mock('../settings/storage.js', () => ({
    getSettings: vi.fn(() => ({ rules: [] })),
}));

// actions/index.js — mutable ACTION_REGISTRY populated per-test; stub the
// re-exported template helpers (only used in applyEarlyActions, not executeActions)
vi.mock('../actions/index.js', () => ({
    ACTION_REGISTRY:  {},
    getTemplateTier:  vi.fn(() => 'immediate'),
    resolveLbTokens:  vi.fn(async t => t),
    interpolate:      vi.fn(t => t),
}));

// ---------------------------------------------------------------------------
// Real module imports (trigger + engine pipeline)
// ---------------------------------------------------------------------------

import { evaluateTriggers }                             from '../engine/evaluate.js';
import { executeActions, clearEarlyFired }              from '../engine/execute.js';
import { ACTION_REGISTRY }                              from '../actions/index.js';
import { clearTurnVars, setTurnVar, getTurnVar } from '../triggers/turn-vars.js';
import { clearWiCache }                           from '../triggers/lb-query.js';
import { setCurrentEvent, clearCurrentEvent }     from '../triggers/event.js';
import { getSortedEntries }                             from '../../../../scripts/world-info.js';

// Real action implementations under test
import { compose }  from '../actions/compose.js';
import { replace }  from '../actions/replace.js';
import { setStVar } from '../actions/set-stvar.js';
import { update }   from '../actions/update.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRule(triggers, actions, overrides = {}) {
    return {
        id: 'e2e', name: 'E2E rule', enabled: true, devMode: false,
        when: 'any', triggers, actions, ...overrides,
    };
}

function makeMsg(mes) { return { mes, name: 'Bot', is_user: false, is_system: false }; }

function makeStCtx(mes) {
    const msg = makeMsg(mes);
    return { chat: [msg], saveChat: vi.fn(async () => {}) };
}

async function run(rule, text, stCtx) {
    const matched = await evaluateTriggers(rule, text);
    if (matched === null) return { matched, vars: {} };
    const execCtx = { matchedKeyword: matched, messageId: 0, highlighted: '', stCtx };
    await executeActions(rule, 'postMessage', execCtx, () => 1);
    return { matched };
}

beforeEach(() => {
    clearTurnVars();
    clearWiCache();
    clearEarlyFired();
    stVarStore.clear();
    lbStore.clear();
    vi.clearAllMocks();
    // Reset ACTION_REGISTRY to empty before each test
    for (const k of Object.keys(ACTION_REGISTRY)) delete ACTION_REGISTRY[k];
});

// ---------------------------------------------------------------------------
// 1. Keyword → compose → replace  (variable-sequencing pipeline)
// ---------------------------------------------------------------------------

describe('pathway: keyword → compose → replace', () => {
    it('compose result is available to replace as a rule variable', async () => {
        ACTION_REGISTRY.compose  = compose;
        ACTION_REGISTRY.replace  = replace;

        const stCtx = makeStCtx('A dragon appeared.');
        const rule = makeRule(
            [{ type: 'keyword', config: { mode: 'text', keywords: 'dragon' } }],
            [
                { type: 'compose', config: { outputVar: 'label', template: '{{keyword}} slain' } },
                { type: 'replace', config: { replacement: '[{{label}}]' } },
            ],
        );

        const { matched } = await run(rule, 'A dragon appeared.', stCtx);

        expect(matched).toBe('dragon');
        expect(stCtx.chat[0].mes).toBe('A [dragon slain] appeared.');
    });

    it('trigger miss: no match → actions do not run', async () => {
        ACTION_REGISTRY.compose = compose;
        const stCtx = makeStCtx('A peaceful meadow.');
        const rule = makeRule(
            [{ type: 'keyword', config: { mode: 'text', keywords: 'dragon' } }],
            [{ type: 'compose', config: { outputVar: 'x', template: 'fired' } }],
        );

        const { matched } = await run(rule, 'A peaceful meadow.', stCtx);

        expect(matched).toBeNull();
        expect(getTurnVar('x')).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// 2. Math in compose template
// ---------------------------------------------------------------------------

describe('pathway: math expressions', () => {
    it('{{math:}} is evaluated inside a compose template', async () => {
        ACTION_REGISTRY.compose = compose;

        const stCtx = makeStCtx('A dragon appeared.');
        const rule = makeRule(
            [{ type: 'keyword', config: { mode: 'text', keywords: 'dragon' } }],
            [{ type: 'compose', config: { outputVar: 'result', template: '{{math: 6 * 7}}' } }],
        );

        await run(rule, 'A dragon appeared.', stCtx);

        expect(getTurnVar('result')).toBe('42');
    });

    it('math expression using up-to text length via compose', async () => {
        ACTION_REGISTRY.compose = compose;

        const stCtx = makeStCtx('ABC dragon');
        const rule = makeRule(
            [{ type: 'keyword', config: { mode: 'text', keywords: 'dragon' } }],
            // Verify operator precedence: 2 + 3 * 4 = 14, not 20
            [{ type: 'compose', config: { outputVar: 'calc', template: '{{math: 2 + 3 * 4}}' } }],
        );

        await run(rule, 'ABC dragon', stCtx);

        expect(getTurnVar('calc')).toBe('14');
    });
});

// ---------------------------------------------------------------------------
// 3. AND trigger gate (when: 'all')
// ---------------------------------------------------------------------------

describe('pathway: AND gate (all triggers must match)', () => {
    it('does not fire when only one of two required triggers matches', async () => {
        ACTION_REGISTRY.compose = compose;

        const rule = makeRule(
            [
                { type: 'keyword', config: { mode: 'text', keywords: 'dragon' } },
                { type: 'varMatch',     config: { varName: 'mood', operator: 'equals', value: 'angry' } },
            ],
            [{ type: 'compose', config: { outputVar: 'outcome', template: 'fired' } }],
            { when: 'all' },
        );

        // Only keyword matches; varMatch fails (mood not set)
        const matched = await evaluateTriggers(rule, 'A dragon appeared.');
        expect(matched).toBeNull();
    });

    it('fires when both triggers match', async () => {
        ACTION_REGISTRY.compose = compose;

        setTurnVar('mood', 'angry');
        const rule = makeRule(
            [
                { type: 'keyword', config: { mode: 'text', keywords: 'dragon' } },
                { type: 'varMatch',     config: { varName: 'mood', operator: 'equals', value: 'angry' } },
            ],
            [{ type: 'compose', config: { outputVar: 'outcome', template: 'rage triggered' } }],
            { when: 'all' },
        );

        const stCtx = makeStCtx('A dragon appeared.');
        const { matched } = await run(rule, 'A dragon appeared.', stCtx);

        expect(matched).toBe('dragon');
        expect(getTurnVar('outcome')).toBe('rage triggered');
    });
});

// ---------------------------------------------------------------------------
// 4. OR trigger gate (when: 'any')
// ---------------------------------------------------------------------------

describe('pathway: OR gate (any trigger is sufficient)', () => {
    it('fires on the first matching trigger', async () => {
        ACTION_REGISTRY.compose = compose;

        const rule = makeRule(
            [
                { type: 'keyword', config: { mode: 'text', keywords: 'dragon' } },
                { type: 'keyword', config: { mode: 'text', keywords: 'serpent' } },
            ],
            [{ type: 'compose', config: { outputVar: 'beast', template: '{{keyword}}' } }],
            { when: 'any' },
        );

        const stCtx = makeStCtx('A serpent coils.');
        await run(rule, 'A serpent coils.', stCtx);

        expect(getTurnVar('beast')).toBe('serpent');
    });

    it('fires on the second trigger when the first does not match', async () => {
        ACTION_REGISTRY.compose = compose;

        const rule = makeRule(
            [
                { type: 'keyword', config: { mode: 'text', keywords: 'dragon' } },
                { type: 'event', config: { event: 'MESSAGE_RECEIVED' } },
            ],
            [{ type: 'compose', config: { outputVar: 'tag', template: 'chat-done' } }],
            { when: 'any' },
        );

        // No 'dragon' in text, but MESSAGE_RECEIVED event is active
        setCurrentEvent('MESSAGE_RECEIVED');

        const stCtx = makeStCtx('All quiet.');
        await run(rule, 'All quiet.', stCtx);

        expect(getTurnVar('tag')).toBe('chat-done');

        clearCurrentEvent();
    });
});

// ---------------------------------------------------------------------------
// 5. Chance trigger (probability gate)
// ---------------------------------------------------------------------------

describe('pathway: chance trigger', () => {
    it('fires when the random roll falls below the threshold', async () => {
        ACTION_REGISTRY.compose = compose;

        vi.spyOn(Math, 'random').mockReturnValue(0.2); // 20 < 50 → fires

        const rule = makeRule(
            [{ type: 'chance', config: { chance: 50 } }],
            [{ type: 'compose', config: { outputVar: 'fired', template: 'yes' } }],
        );

        const stCtx = makeStCtx('Any text.');
        await run(rule, 'Any text.', stCtx);

        expect(getTurnVar('fired')).toBe('yes');
    });

    it('does not fire when the random roll meets or exceeds the threshold', async () => {
        ACTION_REGISTRY.compose = compose;

        vi.spyOn(Math, 'random').mockReturnValue(0.8); // 80 >= 50 → blocked

        const rule = makeRule(
            [{ type: 'chance', config: { chance: 50 } }],
            [{ type: 'compose', config: { outputVar: 'fired', template: 'yes' } }],
        );

        const matched = await evaluateTriggers(rule, 'Any text.');
        expect(matched).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// 6. Condition trigger (chatvar evaluated in boolean expression)
// ---------------------------------------------------------------------------

describe('pathway: condition trigger (chatvar)', () => {
    it('fires when the chatvar condition is true', async () => {
        ACTION_REGISTRY.compose = compose;

        // Use chatvar:: prefix so the lookup calls getLocalVariable (backed by stVarStore).
        // Bare variable names in conditions resolve from the turn-var snapshot, not ST vars.
        stVarStore.set('hp', '15');

        const rule = makeRule(
            [{ type: 'condition', config: { expression: 'chatvar::hp < 20' } }],
            [{ type: 'compose', config: { outputVar: 'status', template: 'critical' } }],
        );

        const stCtx = makeStCtx('');
        await run(rule, '', stCtx);

        expect(getTurnVar('status')).toBe('critical');
    });

    it('does not fire when the condition is false', async () => {
        ACTION_REGISTRY.compose = compose;

        stVarStore.set('hp', '80');

        const rule = makeRule(
            [{ type: 'condition', config: { expression: 'chatvar::hp < 20' } }],
            [{ type: 'compose', config: { outputVar: 'status', template: 'critical' } }],
        );

        const matched = await evaluateTriggers(rule, '');
        expect(matched).toBeNull();
    });

    it('AND/OR logic works inside the condition expression', async () => {
        ACTION_REGISTRY.compose = compose;

        stVarStore.set('hp', '5');
        stVarStore.set('shield', 'broken');

        const rule = makeRule(
            [{ type: 'condition', config: { expression: 'chatvar::hp < 20 AND chatvar::shield is "broken"' } }],
            [{ type: 'compose', config: { outputVar: 'alert', template: 'in danger' } }],
        );

        const stCtx = makeStCtx('');
        await run(rule, '', stCtx);

        expect(getTurnVar('alert')).toBe('in danger');
    });
});

// ---------------------------------------------------------------------------
// 7. Lorebook write via update action
// ---------------------------------------------------------------------------

describe('pathway: lorebook write (update action)', () => {
    it('creates a lorebook entry via the trigger → update pipeline', async () => {
        ACTION_REGISTRY.update = update;

        const stCtx = makeStCtx('A dragon appeared.');
        const rule = makeRule(
            [{ type: 'keyword', config: { mode: 'text', keywords: 'dragon' } }],
            [{
                type:   'update',
                config: { target: 'lorebook', lorebook: 'testBook', title: 'Dragon', keys: 'dragon', content: 'A fearsome beast: {{keyword}}' },
            }],
        );

        await run(rule, 'A dragon appeared.', stCtx);

        const lbData = lbStore.get('testBook');
        expect(lbData).toBeDefined();
        const entry = Object.values(lbData.entries).find(e => e.comment === 'Dragon');
        expect(entry).toBeDefined();
        expect(entry.content).toBe('A fearsome beast: dragon');
    });

    it('lorebook write from getSortedEntries mock supports keyword (lorebook mode) trigger', async () => {
        // Populate the WI mock with an entry whose key 'elara' will trigger
        vi.mocked(getSortedEntries).mockResolvedValue([
            { comment: 'Elara Voss', content: 'An archivist.', disable: false, world: 'testBook', key: ['elara'], keysecondary: [] },
        ]);

        ACTION_REGISTRY.compose = compose;

        const rule = makeRule(
            [{ type: 'keyword', config: { mode: 'lorebook' } }],
            [{ type: 'compose', config: { outputVar: 'who', template: '{{keyword}} found' } }],
        );

        const stCtx = makeStCtx('Elara arrived at the archive.');
        await run(rule, 'Elara arrived at the archive.', stCtx);

        expect(getTurnVar('who')).toMatch(/elara/i);
    });
});

// ---------------------------------------------------------------------------
// 8. ST variable pipeline (set-stvar → chatvar read-back)
// ---------------------------------------------------------------------------

describe('pathway: ST variable write (set-stvar) + read-back', () => {
    it('set-stvar stores the value; subsequent compose reads it via stVarStore', async () => {
        ACTION_REGISTRY.setStVar  = setStVar;
        ACTION_REGISTRY.compose   = compose;

        const stCtx = makeStCtx('A dragon appeared.');
        const rule = makeRule(
            [{ type: 'keyword', config: { mode: 'text', keywords: 'dragon' } }],
            [
                { type: 'setStVar', config: { scope: 'chat', varName: 'creature', key: '', value: '{{keyword}}' } },
                { type: 'compose',  config: { outputVar: 'echo', template: '{{chatvar::creature}} was stored' } },
            ],
        );

        await run(rule, 'A dragon appeared.', stCtx);

        // set-stvar should have written to stVarStore via the 5-up variables mock
        expect(stVarStore.get('creature')).toBe('dragon');
        // compose should have read it back via {{chatvar::creature}}
        expect(getTurnVar('echo')).toBe('dragon was stored');
    });

    it('global scope: set-stvar writes to global, compose reads via {{globalvar::}}', async () => {
        ACTION_REGISTRY.setStVar = setStVar;
        ACTION_REGISTRY.compose  = compose;

        const stCtx = makeStCtx('A dragon appeared.');
        const rule = makeRule(
            [{ type: 'keyword', config: { mode: 'text', keywords: 'dragon' } }],
            [
                { type: 'setStVar', config: { scope: 'global', varName: 'lastBeast', key: '', value: '{{keyword}}' } },
                { type: 'compose',  config: { outputVar: 'echo', template: '{{globalvar::lastBeast}}' } },
            ],
        );

        await run(rule, 'A dragon appeared.', stCtx);

        expect(stVarStore.get('global:lastBeast')).toBe('dragon');
        expect(getTurnVar('echo')).toBe('dragon');
    });
});

// ---------------------------------------------------------------------------
// 9. Imaging pathway (action routing)
// ---------------------------------------------------------------------------

describe('pathway: imaging (imageGen action routing)', () => {
    it('imageGen action execute is called when the trigger fires', async () => {
        const imageGenExecute = vi.fn(async () => {});
        ACTION_REGISTRY.imageGen = { stage: 'postMessage', execute: imageGenExecute };

        const stCtx = makeStCtx('A dragon appeared.');
        const rule = makeRule(
            [{ type: 'keyword', config: { mode: 'text', keywords: 'dragon' } }],
            [{ type: 'imageGen', config: { prompt: 'A {{keyword}} in a cave' } }],
        );

        const { matched } = await run(rule, 'A dragon appeared.', stCtx);

        expect(matched).toBe('dragon');
        expect(imageGenExecute).toHaveBeenCalledOnce();
        // Verify the config and matched keyword were passed through correctly
        const [config, ctx] = imageGenExecute.mock.calls[0];
        expect(config.prompt).toBe('A {{keyword}} in a cave');
        expect(ctx.matchedKeyword).toBe('dragon');
    });

    it('imageGen is not called when the trigger does not match', async () => {
        const imageGenExecute = vi.fn(async () => {});
        ACTION_REGISTRY.imageGen = { stage: 'postMessage', execute: imageGenExecute };

        const rule = makeRule(
            [{ type: 'keyword', config: { mode: 'text', keywords: 'dragon' } }],
            [{ type: 'imageGen', config: { prompt: 'A beast' } }],
        );

        const matched = await evaluateTriggers(rule, 'A peaceful meadow.');
        expect(matched).toBeNull();
        expect(imageGenExecute).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// 10. Stage gating — action stage must match the execution stage
// ---------------------------------------------------------------------------

describe('pathway: stage gating', () => {
    it('postMessage action is skipped when executing under the streaming stage', async () => {
        // compose.stage = 'postMessage'; executing with stage='streaming' should skip it
        ACTION_REGISTRY.compose = compose;

        const stCtx = makeStCtx('A dragon appeared.');
        const rule = makeRule(
            [{ type: 'keyword', config: { mode: 'text', keywords: 'dragon' } }],
            [{ type: 'compose', config: { outputVar: 'x', template: 'fired' } }],
        );

        const matched = await evaluateTriggers(rule, 'A dragon appeared.');
        const execCtx = { matchedKeyword: matched, messageId: 0, highlighted: '', stCtx };
        await executeActions(rule, 'streaming', execCtx, () => 1);

        expect(getTurnVar('x')).toBeUndefined();
    });

    it('postMessage action runs when stage matches', async () => {
        ACTION_REGISTRY.compose = compose;

        const stCtx = makeStCtx('A dragon appeared.');
        const rule = makeRule(
            [{ type: 'keyword', config: { mode: 'text', keywords: 'dragon' } }],
            [{ type: 'compose', config: { outputVar: 'x', template: 'fired' } }],
        );

        const matched = await evaluateTriggers(rule, 'A dragon appeared.');
        const execCtx = { matchedKeyword: matched, messageId: 0, highlighted: '', stCtx };
        await executeActions(rule, 'postMessage', execCtx, () => 1);

        expect(getTurnVar('x')).toBe('fired');
    });
});
