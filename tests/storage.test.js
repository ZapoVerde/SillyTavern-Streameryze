import { vi, describe, it, expect, beforeEach } from 'vitest';

// The vitest.config.js alias routes any */extensions.js import to tests/__mocks__/extensions.js,
// so this gives us the same object that storage.js mutates.
import { extension_settings } from '../../../../extensions.js';

vi.mock('../../../../../script.js', () => ({
    saveSettingsDebounced: vi.fn(),
}));

import { getEnabledRules, loadSettings, makeId } from '../settings/storage.js';

beforeEach(() => {
    // Reset the shared extension_settings object between tests
    for (const k of Object.keys(extension_settings)) delete extension_settings[k];
    vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// makeId
// ---------------------------------------------------------------------------

describe('makeId', () => {
    it('returns a non-empty string', () => {
        expect(typeof makeId()).toBe('string');
        expect(makeId().length).toBeGreaterThan(0);
    });

    it('returns different values on successive calls', () => {
        expect(makeId()).not.toBe(makeId());
    });
});

// ---------------------------------------------------------------------------
// getEnabledRules
// ---------------------------------------------------------------------------

describe('getEnabledRules', () => {
    it('returns empty array when rulesets is absent', () => {
        expect(getEnabledRules({})).toEqual([]);
    });

    it('returns empty array when rulesets is empty', () => {
        expect(getEnabledRules({ rulesets: [] })).toEqual([]);
    });

    it('spreads _rulesetId onto each rule', () => {
        const s = {
            rulesets: [{ id: 'rs1', rules: [{ id: 'r1', enabled: true, triggers: [], actions: [] }] }],
        };
        const rules = getEnabledRules(s);
        expect(rules[0]._rulesetId).toBe('rs1');
    });

    it('flattens rules from multiple rulesets', () => {
        const s = {
            rulesets: [
                { id: 'rs1', rules: [{ id: 'r1' }, { id: 'r2' }] },
                { id: 'rs2', rules: [{ id: 'r3' }] },
            ],
        };
        expect(getEnabledRules(s)).toHaveLength(3);
    });

    it('filters out disabled rulesets', () => {
        const s = {
            rulesets: [
                { id: 'rs1', enabled: true,  rules: [{ id: 'r1' }] },
                { id: 'rs2', enabled: false, rules: [{ id: 'r2' }] },
            ],
        };
        const rules = getEnabledRules(s);
        expect(rules).toHaveLength(1);
        expect(rules[0].id).toBe('r1');
    });

    it('filters out disabled rules within an enabled ruleset', () => {
        const s = {
            rulesets: [{
                id: 'rs1',
                rules: [
                    { id: 'r1', enabled: true  },
                    { id: 'r2', enabled: false },
                ],
            }],
        };
        const rules = getEnabledRules(s);
        expect(rules).toHaveLength(1);
        expect(rules[0].id).toBe('r1');
    });

    it('includes rules whose enabled field is absent (undefined = enabled)', () => {
        const s = {
            rulesets: [{ id: 'rs1', rules: [{ id: 'r1' }] }],
        };
        expect(getEnabledRules(s)).toHaveLength(1);
    });

    it('each rule carries the correct _rulesetId for its parent ruleset', () => {
        const s = {
            rulesets: [
                { id: 'rs1', rules: [{ id: 'r1' }] },
                { id: 'rs2', rules: [{ id: 'r2' }] },
            ],
        };
        const rules = getEnabledRules(s);
        expect(rules.find(r => r.id === 'r1')._rulesetId).toBe('rs1');
        expect(rules.find(r => r.id === 'r2')._rulesetId).toBe('rs2');
    });

    it('does not mutate the original rule objects in settings', () => {
        const orig = { id: 'r1' };
        const s    = { rulesets: [{ id: 'rs1', rules: [orig] }] };
        getEnabledRules(s);
        expect(orig._rulesetId).toBeUndefined();
    });

    it('handles rulesets with empty rules array', () => {
        const s = { rulesets: [{ id: 'rs1', rules: [] }] };
        expect(getEnabledRules(s)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// loadSettings — defaults
// ---------------------------------------------------------------------------

describe('loadSettings — defaults', () => {
    it('creates the triggeryze key if absent', () => {
        loadSettings();
        expect(extension_settings['triggeryze']).toBeDefined();
    });

    it('initialises rulesets to an empty array when absent', () => {
        loadSettings();
        expect(extension_settings['triggeryze'].rulesets).toEqual([]);
    });

    it('sets enabled: true by default', () => {
        loadSettings();
        expect(extension_settings['triggeryze'].enabled).toBe(true);
    });

    it('does not overwrite existing settings values', () => {
        extension_settings['triggeryze'] = { enabled: false, rulesets: [], profiles: { Default: { rulesets: [] } }, currentProfileName: 'Default' };
        loadSettings();
        expect(extension_settings['triggeryze'].enabled).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// loadSettings — streameryze → triggeryze rename
// ---------------------------------------------------------------------------

describe('loadSettings — streameryze rename', () => {
    it('moves streameryze settings to triggeryze', () => {
        extension_settings['streameryze'] = { rulesets: [], enabled: true };
        loadSettings();
        expect(extension_settings['triggeryze']).toBeDefined();
        expect(extension_settings['streameryze']).toBeUndefined();
    });

    it('does not rename when triggeryze already exists', () => {
        extension_settings['streameryze'] = { rulesets: [] };
        extension_settings['triggeryze']  = { rulesets: [{ id: 'existing', rules: [] }], profiles: { Default: { rulesets: [] } }, currentProfileName: 'Default' };
        loadSettings();
        expect(extension_settings['triggeryze'].rulesets[0].id).toBe('existing');
    });
});

// ---------------------------------------------------------------------------
// loadSettings — flat rules → rulesets migration
// ---------------------------------------------------------------------------

describe('loadSettings — flat rules migration', () => {
    it('wraps a flat rules array into a Default ruleset', () => {
        extension_settings['triggeryze'] = {
            rules: [{ id: 'r1', triggers: [], actions: [] }],
        };
        loadSettings();
        const s = extension_settings['triggeryze'];
        expect(s.rules).toBeUndefined();
        expect(s.rulesets).toHaveLength(1);
        expect(s.rulesets[0].name).toBe('Default');
        expect(s.rulesets[0].rules[0].id).toBe('r1');
    });

    it('skips invalid rules (missing id or non-array triggers/actions) during migration', () => {
        extension_settings['triggeryze'] = {
            rules: [
                { id: 'good', triggers: [], actions: [] },
                { triggers: [], actions: [] },         // missing id
                { id: 'bad', triggers: 'nope' },       // non-array triggers
            ],
        };
        loadSettings();
        const rs = extension_settings['triggeryze'].rulesets[0];
        expect(rs.rules).toHaveLength(1);
        expect(rs.rules[0].id).toBe('good');
    });

    it('does not migrate when rulesets already exist', () => {
        extension_settings['triggeryze'] = {
            rules:    [{ id: 'old', triggers: [], actions: [] }],
            rulesets: [{ id: 'rs1', rules: [] }],
            profiles: { Default: { rulesets: [] } },
            currentProfileName: 'Default',
        };
        loadSettings();
        const s = extension_settings['triggeryze'];
        expect(s.rulesets).toHaveLength(1);
        expect(s.rulesets[0].id).toBe('rs1');
    });
});

// ---------------------------------------------------------------------------
// loadSettings — _migrateSettings trigger type renames
// ---------------------------------------------------------------------------

describe('loadSettings — trigger type migrations', () => {
    function settingsWithTrigger(trigger) {
        return {
            rulesets: [{ id: 'rs1', rules: [{ id: 'r1', triggers: [trigger], actions: [] }] }],
            profiles: { Default: { rulesets: [] } },
            currentProfileName: 'Default',
        };
    }

    it('renames keywordMatch trigger to keyword', () => {
        extension_settings['triggeryze'] = settingsWithTrigger({ type: 'keywordMatch', config: {} });
        loadSettings();
        const t = extension_settings['triggeryze'].rulesets[0].rules[0].triggers[0];
        expect(t.type).toBe('keyword');
        expect(t.config.mode).toBe('text');
    });

    it('renames lbKeyword trigger to keyword with lorebook mode', () => {
        extension_settings['triggeryze'] = settingsWithTrigger({ type: 'lbKeyword' });
        loadSettings();
        const t = extension_settings['triggeryze'].rulesets[0].rules[0].triggers[0];
        expect(t.type).toBe('keyword');
        expect(t.config.mode).toBe('lorebook');
    });

    it('renames regex trigger to keyword', () => {
        extension_settings['triggeryze'] = settingsWithTrigger({ type: 'regex', config: { pattern: '\\d+' } });
        loadSettings();
        const t = extension_settings['triggeryze'].rulesets[0].rules[0].triggers[0];
        expect(t.type).toBe('keyword');
    });

    it('converts keyword{mode:regex} to {mode:text, useRegex:true}', () => {
        extension_settings['triggeryze'] = settingsWithTrigger({ type: 'keyword', config: { mode: 'regex', pattern: '\\d+' } });
        loadSettings();
        const t = extension_settings['triggeryze'].rulesets[0].rules[0].triggers[0];
        expect(t.config.mode).toBe('text');
        expect(t.config.useRegex).toBe(true);
    });

    it('converts varMatch{operator:matches} to useRegex:true', () => {
        extension_settings['triggeryze'] = settingsWithTrigger({ type: 'varMatch', config: { operator: 'matches', value: '\\d+' } });
        loadSettings();
        const t = extension_settings['triggeryze'].rulesets[0].rules[0].triggers[0];
        expect(t.config.operator).toBe('equals');
        expect(t.config.useRegex).toBe(true);
    });

    it('renames chatComplete trigger to event', () => {
        extension_settings['triggeryze'] = settingsWithTrigger({ type: 'chatComplete' });
        loadSettings();
        const t = extension_settings['triggeryze'].rulesets[0].rules[0].triggers[0];
        expect(t.type).toBe('event');
        expect(t.config.event).toBe('MESSAGE_RECEIVED');
    });

    it('renames triggerLogic to when', () => {
        extension_settings['triggeryze'] = {
            rulesets: [{ id: 'rs1', rules: [{ id: 'r1', triggerLogic: 'all', triggers: [], actions: [] }] }],
            profiles: { Default: { rulesets: [] } },
            currentProfileName: 'Default',
        };
        loadSettings();
        const r = extension_settings['triggeryze'].rulesets[0].rules[0];
        expect(r.when).toBe('all');
        expect(r.triggerLogic).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// loadSettings — _migrateSettings action type renames
// ---------------------------------------------------------------------------

describe('loadSettings — action type migrations', () => {
    function settingsWithAction(action) {
        return {
            rulesets: [{ id: 'rs1', rules: [{ id: 'r1', triggers: [], actions: [action] }] }],
            profiles: { Default: { rulesets: [] } },
            currentProfileName: 'Default',
        };
    }

    it('renames lbWrite action to update', () => {
        extension_settings['triggeryze'] = settingsWithAction({ type: 'lbWrite', config: {} });
        loadSettings();
        const a = extension_settings['triggeryze'].rulesets[0].rules[0].actions[0];
        expect(a.type).toBe('update');
        expect(a.config.target).toBe('lorebook');
    });

    it('renames stopContinue action to stop', () => {
        extension_settings['triggeryze'] = settingsWithAction({ type: 'stopContinue' });
        loadSettings();
        const a = extension_settings['triggeryze'].rulesets[0].rules[0].actions[0];
        expect(a.type).toBe('stop');
        expect(a.config.andContinue).toBe(true);
    });
});
