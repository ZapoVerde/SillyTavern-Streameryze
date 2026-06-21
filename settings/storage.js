/**
 * @file st-extensions/SillyTavern-Triggeryze/settings/storage.js
 * @stamp {"utc":"2026-06-16T00:00:00.000Z"}
 * @architectural-role IO — settings initialisation, migration, and read accessors
 * @description
 * Owns the canonical settings object in extension_settings.triggeryze. Handles
 * one-time key migration (streameryze → triggeryze), flat-rules-to-profile migration,
 * rules-to-rulesets migration, and lbWrite → update action type migration. All other
 * modules read settings via getSettings(); none write the root object directly.
 *
 * The live settings object stores rules grouped into rulesets. The engine never sees
 * rulesets directly — it calls getEnabledRules(s) to receive a flat, pre-filtered list.
 *
 * @api-declaration
 * loadSettings()       — idempotent init; call once at extension load time
 * getSettings()        — returns the live extension_settings.triggeryze object
 * getEnabledRules(s)   — flattens enabled rulesets to an enabled-rule array for the engine
 * makeId()             — generates a short random ID for new rulesets and rules
 *
 * @contract
 *   assertions:
 *     purity:          none — reads/writes extension_settings; calls saveSettingsDebounced on migration
 *     state_ownership: [extension_settings.triggeryze]
 *     external_io:     saveSettingsDebounced
 */

import { saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings }    from '../../../../extensions.js';

const EXT_NAME = 'triggeryze';

const DEFAULTS = {
    enabled:     true,
    verbose:     false,
    nonStreaming: false,
    showBadges:  true,
    rulesets:    [],
};

export function makeId() { return Math.random().toString(36).slice(2, 9); }

export function getSettings() { return extension_settings[EXT_NAME]; }

/** Returns a flat array of enabled rules across all enabled rulesets. Used by the engine only. */
export function getEnabledRules(s) {
    return (s.rulesets ?? [])
        .filter(rs => rs.enabled !== false)
        .flatMap(rs => (rs.rules ?? [])
            .filter(r => r.enabled !== false)
            .map(r => ({ ...r, _rulesetId: rs.id }))
        );
}

export function loadSettings() {
    if (extension_settings['streameryze'] && !extension_settings['triggeryze']) {
        extension_settings['triggeryze'] = extension_settings['streameryze'];
        delete extension_settings['streameryze'];
    }
    extension_settings[EXT_NAME] ??= {};
    const s = extension_settings[EXT_NAME];
    for (const [k, v] of Object.entries(DEFAULTS)) {
        s[k] ??= structuredClone(v);
    }

    // Migrate flat rules array → single Default ruleset
    if (Array.isArray(s.rules) && !s.rulesets?.length) {
        const validRules = s.rules.filter(r => r.id && Array.isArray(r.triggers) && Array.isArray(r.actions));
        s.rulesets = [{ id: makeId(), name: 'Default', enabled: true, rules: validRules }];
        delete s.rules;
        saveSettingsDebounced();
    }

    // Validate rulesets: each must have an id and a rules array
    s.rulesets = (s.rulesets ?? []).filter(rs => rs.id && Array.isArray(rs.rules));
    for (const rs of s.rulesets) {
        rs.rules = rs.rules.filter(r => r.id && Array.isArray(r.triggers) && Array.isArray(r.actions));
    }

    if (!s.profiles) {
        s.profiles           = { Default: { rulesets: structuredClone(s.rulesets) } };
        s.currentProfileName = 'Default';
    }
    if (!s.profiles[s.currentProfileName]) {
        s.currentProfileName = Object.keys(s.profiles)[0];
    }

    // Migrate profiles that still use a flat rules array
    for (const profile of Object.values(s.profiles)) {
        if (Array.isArray(profile.rules) && !profile.rulesets?.length) {
            const validRules = profile.rules.filter(r => r.id && Array.isArray(r.triggers) && Array.isArray(r.actions));
            profile.rulesets = [{ id: makeId(), name: 'Default', enabled: true, rules: validRules }];
            delete profile.rules;
        }
    }

    _migrateSettings(s);
}

function _migrateSettings(s) {
    let migrated = 0;
    const migrateRules = (rules) => {
        for (const rule of (rules ?? [])) {
            if (rule.triggerLogic !== undefined && rule.when === undefined) {
                rule.when = rule.triggerLogic;
                delete rule.triggerLogic;
                migrated++;
            }
            for (const trigger of (rule.triggers ?? [])) {
                if (trigger.type === 'keywordMatch') {
                    trigger.type   = 'keyword';
                    trigger.config = { mode: 'text', ...(trigger.config ?? {}) };
                    migrated++;
                }
                if (trigger.type === 'lbKeyword') {
                    trigger.type   = 'keyword';
                    trigger.config = { mode: 'lorebook' };
                    migrated++;
                }
                if (trigger.type === 'regex') {
                    trigger.type   = 'keyword';
                    trigger.config = { mode: 'regex', ...(trigger.config ?? {}) };
                    migrated++;
                }
                if (trigger.type === 'keyword' && trigger.config?.mode === 'regex') {
                    trigger.config.mode     = 'text';
                    trigger.config.useRegex = true;
                    migrated++;
                }
                if (trigger.type === 'varMatch' && trigger.config?.operator === 'matches') {
                    trigger.config.operator = 'equals';
                    trigger.config.useRegex = true;
                    migrated++;
                }
                if (trigger.type === 'chatComplete') {
                    trigger.type   = 'event';
                    trigger.config = { event: 'MESSAGE_RECEIVED' };
                    migrated++;
                }
            }
            for (const action of (rule.actions ?? [])) {
                if (action.type === 'lbWrite') {
                    action.type   = 'update';
                    action.config = { target: 'lorebook', ...(action.config ?? {}) };
                    migrated++;
                }
                if (action.type === 'stopContinue') {
                    action.type   = 'stop';
                    action.config = { andContinue: true };
                    migrated++;
                }
            }
        }
    };
    for (const rs of (s.rulesets ?? [])) migrateRules(rs.rules);
    for (const profile of Object.values(s.profiles ?? {})) {
        for (const rs of (profile.rulesets ?? [])) migrateRules(rs.rules);
    }
    if (migrated > 0) {
        console.log(`[TRG] migrated ${migrated} setting(s) to current format`);
        saveSettingsDebounced();
    }
}
