/**
 * E2E pipeline tests for preset, slash-cmd, and ST variable actions.
 *
 * Covers the full evaluate → execute → action path for three action types
 * that the base e2e.test.js only touches lightly. The ST boundary is mocked;
 * all extension logic (engine, triggers, actions, template) is real.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted stores
// ---------------------------------------------------------------------------

const { stVarStore, pmRef } = vi.hoisted(() => ({
    stVarStore: new Map(),
    pmRef:      { current: null },
}));

// ---------------------------------------------------------------------------
// PromptManager mock factory
// ---------------------------------------------------------------------------

function makePm() {
    const prompts = [];
    const order   = [{ identifier: 'chatHistory', enabled: true }];
    return {
        serviceSettings:  { prompts },
        activeCharacter:  { name: 'TestChar' },
        getPromptById(id) { return prompts.find(p => p.identifier === id) ?? null; },
        addPrompt(obj, id) { prompts.push({ ...obj, identifier: id }); },
        getPromptOrderForCharacter(_char) { return order; },
        saveServiceSettings: vi.fn(),
        _prompts: prompts,
        _order:   order,
    };
}

// ---------------------------------------------------------------------------
// Mocks — ST boundary
// ---------------------------------------------------------------------------

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
}));

vi.mock('../../../../../scripts/openai.js', () => ({
    get promptManager() { return pmRef.current; },
    oai_settings: { prompts: [] },
}));

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
vi.mock('../../../../../scripts/variables.js', () => ({
    getLocalVariable:  (name, opts = {}) => {
        const key = opts?.index !== undefined ? `${name}[${opts.index}]` : name;
        return stVarStore.get(key) ?? null;
    },
    getGlobalVariable: (name) => stVarStore.get(`global:${name}`) ?? null,
    setLocalVariable:  (name, value, opts = {}) => {
        const key = opts?.index !== undefined ? `${name}[${opts.index}]` : name;
        stVarStore.set(key, value);
    },
    setGlobalVariable: (name, value) => stVarStore.set(`global:${name}`, value),
}));

// ---------------------------------------------------------------------------
// Mocks — internal
// ---------------------------------------------------------------------------

vi.mock('../lorebookApi.js', () => ({
    lbGetLorebook:  async () => ({ entries: {} }),
    lbSaveLorebook: vi.fn(),
}));
vi.mock('../engine/live-patch.js', () => ({
    hasLiveResult:       vi.fn(() => false),
    setLiveResult:       vi.fn(),
    stopPatchObserver:   vi.fn(),
    clearLivePatchState: vi.fn(),
}));
vi.mock('../settings/storage.js', () => ({
    getSettings: vi.fn(() => ({ rules: [] })),
}));
vi.mock('../actions/index.js', () => ({
    ACTION_REGISTRY: {},
    getTemplateTier: vi.fn(() => 'immediate'),
    resolveLbTokens: vi.fn(async t => t),
    interpolate:     vi.fn(t => t),
}));

vi.stubGlobal('window', {
    toastr:  { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() },
    confirm: vi.fn(() => true),
});

// ---------------------------------------------------------------------------
// Real modules
// ---------------------------------------------------------------------------

import { evaluateTriggers }            from '../engine/evaluate.js';
import { executeActions, clearEarlyFired } from '../engine/execute.js';
import { ACTION_REGISTRY }             from '../actions/index.js';
import { clearTurnVars, getTurnVar }   from '../triggers/turn-vars.js';

import { preset }   from '../actions/preset.js';
import { slashCmd } from '../actions/slash-cmd.js';
import { setStVar } from '../actions/set-stvar.js';
import { compose }  from '../actions/compose.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRule(triggers, actions, overrides = {}) {
    return { id: 'e2e', name: 'E2E rule', enabled: true, devMode: false,
             when: 'any', triggers, actions, ...overrides };
}

function makeMsg(mes) { return { mes, name: 'Bot', is_user: false, is_system: false }; }

function makeStCtx(mes, extra = {}) {
    const msg = makeMsg(mes);
    return { chat: [msg], saveChat: vi.fn(async () => {}), ...extra };
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
    clearEarlyFired();
    stVarStore.clear();
    vi.clearAllMocks();
    pmRef.current = makePm();
    window.toastr  = { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() };
    window.confirm = vi.fn(() => true);
    for (const k of Object.keys(ACTION_REGISTRY)) delete ACTION_REGISTRY[k];
});

// ============================================================================
// PRESET
// ============================================================================

describe('pathway: preset — write (create)', () => {
    it('creates a new prompt entry with the resolved name', async () => {
        ACTION_REGISTRY.preset = preset;

        const stCtx = makeStCtx('A dragon appeared.');
        const rule = makeRule(
            [{ type: 'keyword', config: { mode: 'text', keywords: 'dragon' } }],
            [{ type: 'preset', config: { name: 'Scene Mood', content: 'tense', mode: 'write' } }],
        );

        await run(rule, 'A dragon appeared.', stCtx);

        const pm = pmRef.current;
        const prompt = pm.getPromptById('trg_preset_scene-mood');
        expect(prompt).not.toBeNull();
        expect(prompt.content).toBe('tense');
    });

    it('interpolates {{keyword}} into the preset name and content', async () => {
        ACTION_REGISTRY.preset = preset;

        const stCtx = makeStCtx('A dragon appeared.');
        const rule = makeRule(
            [{ type: 'keyword', config: { mode: 'text', keywords: 'dragon' } }],
            [{ type: 'preset', config: { name: '{{keyword}} scene', content: 'a {{keyword}} looms', mode: 'write' } }],
        );

        await run(rule, 'A dragon appeared.', stCtx);

        const pm     = pmRef.current;
        const prompt = pm.getPromptById('trg_preset_dragon-scene');
        expect(prompt).not.toBeNull();
        expect(prompt.content).toBe('a dragon looms');
    });

    it('uses a compose-produced turn variable in the preset content', async () => {
        ACTION_REGISTRY.compose = compose;
        ACTION_REGISTRY.preset  = preset;

        const stCtx = makeStCtx('A dragon appeared.');
        const rule = makeRule(
            [{ type: 'keyword', config: { mode: 'text', keywords: 'dragon' } }],
            [
                { type: 'compose', config: { outputVar: 'mood', template: '{{keyword}} detected' } },
                { type: 'preset',  config: { name: 'Status', content: '{{mood}}', mode: 'write' } },
            ],
        );

        await run(rule, 'A dragon appeared.', stCtx);

        const pm     = pmRef.current;
        const prompt = pm.getPromptById('trg_preset_status');
        expect(prompt?.content).toBe('dragon detected');
    });

    it('inserts the new prompt before chatHistory in the order', async () => {
        ACTION_REGISTRY.preset = preset;

        const stCtx = makeStCtx('A dragon appeared.');
        const rule = makeRule(
            [{ type: 'keyword', config: { mode: 'text', keywords: 'dragon' } }],
            [{ type: 'preset', config: { name: 'Mood', content: 'tense', mode: 'write' } }],
        );

        await run(rule, 'A dragon appeared.', stCtx);

        const order = pmRef.current._order;
        const moodIdx = order.findIndex(e => e.identifier === 'trg_preset_mood');
        const histIdx = order.findIndex(e => e.identifier === 'chatHistory');
        expect(moodIdx).toBeGreaterThanOrEqual(0);
        expect(moodIdx).toBeLessThan(histIdx);
    });
});

describe('pathway: preset — write (update)', () => {
    it('updates content of an existing prompt without duplicating it', async () => {
        ACTION_REGISTRY.preset = preset;

        const pm = pmRef.current;
        pm.addPrompt({ name: 'Mood', content: 'calm', role: 'system', enabled: true }, 'trg_preset_mood');

        const stCtx = makeStCtx('A dragon appeared.');
        const rule = makeRule(
            [{ type: 'keyword', config: { mode: 'text', keywords: 'dragon' } }],
            [{ type: 'preset', config: { name: 'Mood', content: 'tense', mode: 'write' } }],
        );

        await run(rule, 'A dragon appeared.', stCtx);

        const prompts = pm._prompts.filter(p => p.identifier === 'trg_preset_mood');
        expect(prompts).toHaveLength(1);
        expect(prompts[0].content).toBe('tense');
    });
});

describe('pathway: preset — clear', () => {
    it('empties the content of an existing prompt', async () => {
        ACTION_REGISTRY.preset = preset;

        const pm = pmRef.current;
        pm.addPrompt({ name: 'Mood', content: 'tense', role: 'system', enabled: true }, 'trg_preset_mood');

        const stCtx = makeStCtx('A dragon appeared.');
        const rule = makeRule(
            [{ type: 'keyword', config: { mode: 'text', keywords: 'dragon' } }],
            [{ type: 'preset', config: { name: 'Mood', content: '', mode: 'clear' } }],
        );

        await run(rule, 'A dragon appeared.', stCtx);

        expect(pm.getPromptById('trg_preset_mood')?.content).toBe('');
    });
});

describe('pathway: preset — remove', () => {
    it('removes the prompt from the list and the order', async () => {
        ACTION_REGISTRY.preset = preset;

        const pm = pmRef.current;
        pm.addPrompt({ name: 'Mood', content: 'tense', role: 'system', enabled: true }, 'trg_preset_mood');
        pm._order.push({ identifier: 'trg_preset_mood', enabled: true });

        const stCtx = makeStCtx('A dragon appeared.');
        const rule = makeRule(
            [{ type: 'keyword', config: { mode: 'text', keywords: 'dragon' } }],
            [{ type: 'preset', config: { name: 'Mood', content: '', mode: 'remove' } }],
        );

        await run(rule, 'A dragon appeared.', stCtx);

        expect(pm.getPromptById('trg_preset_mood')).toBeNull();
        expect(pm._order.some(e => e.identifier === 'trg_preset_mood')).toBe(false);
    });
});

describe('pathway: preset — guard conditions', () => {
    it('does nothing when promptManager is unavailable', async () => {
        ACTION_REGISTRY.preset = preset;
        pmRef.current = null;

        const stCtx = makeStCtx('A dragon appeared.');
        const rule = makeRule(
            [{ type: 'keyword', config: { mode: 'text', keywords: 'dragon' } }],
            [{ type: 'preset', config: { name: 'Mood', content: 'tense', mode: 'write' } }],
        );

        await expect(run(rule, 'A dragon appeared.', stCtx)).resolves.not.toThrow();
    });

    it('does nothing when the resolved name is empty', async () => {
        ACTION_REGISTRY.preset = preset;

        const stCtx = makeStCtx('A dragon appeared.');
        const rule = makeRule(
            [{ type: 'keyword', config: { mode: 'text', keywords: 'dragon' } }],
            [{ type: 'preset', config: { name: '', content: 'tense', mode: 'write' } }],
        );

        await run(rule, 'A dragon appeared.', stCtx);

        expect(pmRef.current._prompts).toHaveLength(0);
    });
});

// ============================================================================
// SLASH-CMD
// ============================================================================

describe('pathway: slash-cmd', () => {
    it('calls executeSlashCommandsWithOptions with the interpolated command', async () => {
        ACTION_REGISTRY.slashCmd = slashCmd;

        const executeSlash = vi.fn(async () => ({ pipe: null }));
        const stCtx = makeStCtx('A dragon appeared.', {
            executeSlashCommandsWithOptions: executeSlash,
        });

        const rule = makeRule(
            [{ type: 'keyword', config: { mode: 'text', keywords: 'dragon' } }],
            [{ type: 'slashCmd', config: { command: '/setvar key=beast value="{{keyword}}"', outputVar: '' } }],
        );

        await run(rule, 'A dragon appeared.', stCtx);

        expect(executeSlash).toHaveBeenCalledOnce();
        expect(executeSlash.mock.calls[0][0]).toContain('dragon');
    });

    it('stores the pipe result in a turn variable when outputVar is set', async () => {
        ACTION_REGISTRY.slashCmd = slashCmd;

        const executeSlash = vi.fn(async () => ({ pipe: 'angry' }));
        const stCtx = makeStCtx('A dragon appeared.', {
            executeSlashCommandsWithOptions: executeSlash,
        });

        const rule = makeRule(
            [{ type: 'keyword', config: { mode: 'text', keywords: 'dragon' } }],
            [{ type: 'slashCmd', config: { command: '/getvar key=mood', outputVar: 'result' } }],
        );

        await run(rule, 'A dragon appeared.', stCtx);

        expect(getTurnVar('result')).toBe('angry');
    });

    it('discards the pipe when outputVar is not set', async () => {
        ACTION_REGISTRY.slashCmd = slashCmd;

        const executeSlash = vi.fn(async () => ({ pipe: 'angry' }));
        const stCtx = makeStCtx('A dragon.', {
            executeSlashCommandsWithOptions: executeSlash,
        });

        const rule = makeRule(
            [{ type: 'keyword', config: { mode: 'text', keywords: 'dragon' } }],
            [{ type: 'slashCmd', config: { command: '/getvar key=mood', outputVar: '' } }],
        );

        await run(rule, 'A dragon.', stCtx);

        expect(getTurnVar('result')).toBeUndefined();
    });

    it('slash pipe output is available to a subsequent compose action', async () => {
        ACTION_REGISTRY.slashCmd = slashCmd;
        ACTION_REGISTRY.compose  = compose;

        const executeSlash = vi.fn(async () => ({ pipe: 'fierce' }));
        const stCtx = makeStCtx('A dragon appeared.', {
            executeSlashCommandsWithOptions: executeSlash,
        });

        const rule = makeRule(
            [{ type: 'keyword', config: { mode: 'text', keywords: 'dragon' } }],
            [
                { type: 'slashCmd', config: { command: '/getvar key=mood', outputVar: 'mood' } },
                { type: 'compose',  config: { outputVar: 'label', template: 'The {{keyword}} is {{mood}}' } },
            ],
        );

        await run(rule, 'A dragon appeared.', stCtx);

        expect(getTurnVar('label')).toBe('The dragon is fierce');
    });

    it('does not call executeSlashCommandsWithOptions when the trigger does not match', async () => {
        ACTION_REGISTRY.slashCmd = slashCmd;

        const executeSlash = vi.fn(async () => ({ pipe: null }));
        const stCtx = makeStCtx('A peaceful meadow.', {
            executeSlashCommandsWithOptions: executeSlash,
        });

        const rule = makeRule(
            [{ type: 'keyword', config: { mode: 'text', keywords: 'dragon' } }],
            [{ type: 'slashCmd', config: { command: '/trigger id=foo', outputVar: '' } }],
        );

        await run(rule, 'A peaceful meadow.', stCtx);

        expect(executeSlash).not.toHaveBeenCalled();
    });
});

// ============================================================================
// ST VARIABLES — additional coverage beyond e2e.test.js pathway 8
// ============================================================================

describe('pathway: ST variables — chat scope', () => {
    it('set-stvar (chat) → compose reads back via chatvar::', async () => {
        ACTION_REGISTRY.setStVar = setStVar;
        ACTION_REGISTRY.compose  = compose;

        const stCtx = makeStCtx('A dragon appeared.');
        const rule = makeRule(
            [{ type: 'keyword', config: { mode: 'text', keywords: 'dragon' } }],
            [
                { type: 'setStVar', config: { scope: 'chat', varName: 'beast', key: '', value: '{{keyword}}' } },
                { type: 'compose',  config: { outputVar: 'echo', template: '{{chatvar::beast}}' } },
            ],
        );

        await run(rule, 'A dragon appeared.', stCtx);

        expect(stVarStore.get('beast')).toBe('dragon');
        expect(getTurnVar('echo')).toBe('dragon');
    });

    it('overwrites an existing chat variable', async () => {
        ACTION_REGISTRY.setStVar = setStVar;
        ACTION_REGISTRY.compose  = compose;

        stVarStore.set('hp', '100');

        const stCtx = makeStCtx('A dragon appeared.');
        const rule = makeRule(
            [{ type: 'keyword', config: { mode: 'text', keywords: 'dragon' } }],
            [
                { type: 'setStVar', config: { scope: 'chat', varName: 'hp', key: '', value: '50' } },
                { type: 'compose',  config: { outputVar: 'status', template: '{{chatvar::hp}}' } },
            ],
        );

        await run(rule, 'A dragon appeared.', stCtx);

        expect(stVarStore.get('hp')).toBe('50');
        expect(getTurnVar('status')).toBe('50');
    });
});

describe('pathway: ST variables — global scope', () => {
    it('set-stvar (global) → compose reads back via globalvar::', async () => {
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

describe('pathway: ST variables — chained with slash-cmd', () => {
    it('slash-cmd pipe result flows into setStVar via {{outputVar}}', async () => {
        // The engine dep-tracker only sequences via vars; it cannot sequence chatvar:: reads
        // against setStVar writes. Test the supported half: slashCmd writes outputVar, setStVar
        // reads it from vars and persists it to the ST variable store.
        ACTION_REGISTRY.slashCmd = slashCmd;
        ACTION_REGISTRY.setStVar = setStVar;

        const executeSlash = vi.fn(async () => ({ pipe: 'fierce' }));
        const stCtx = makeStCtx('A dragon appeared.', {
            executeSlashCommandsWithOptions: executeSlash,
        });

        const rule = makeRule(
            [{ type: 'keyword', config: { mode: 'text', keywords: 'dragon' } }],
            [
                { type: 'slashCmd', config: { command: '/getvar key=mood', outputVar: 'moodVar' } },
                { type: 'setStVar', config: { scope: 'chat', varName: 'mood', key: '', value: '{{moodVar}}' } },
            ],
        );

        await run(rule, 'A dragon appeared.', stCtx);

        // slashCmd wrote 'fierce' to vars.moodVar; setStVar read it and persisted it
        expect(stVarStore.get('mood')).toBe('fierce');
    });
});
