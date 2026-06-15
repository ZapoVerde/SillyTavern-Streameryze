/**
 * @file st-extensions/SillyTavern-Triggeryze/settings/storage.js
 * @stamp {"utc":"2026-06-15T00:00:00.000Z"}
 * @architectural-role IO — settings initialisation, migration, and read accessor
 * @description
 * Owns the canonical settings object in extension_settings.triggeryze. Handles
 * one-time key migration (streameryze → triggeryze), flat-to-profile migration,
 * and lbWrite → update action type migration. All other modules read settings
 * via getSettings(); none write the root object directly.
 *
 * @api-declaration
 * loadSettings()  — idempotent init; call once at extension load time
 * getSettings()   — returns the live extension_settings.triggeryze object
 * makeId()        — generates a short random ID for new rules
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
    enabled:      true,
    verbose:      false,
    nonStreaming:  false,
    showBadges:   true,
    rules:        [],
};

export function makeId() { return Math.random().toString(36).slice(2, 9); }

export function getSettings() { return extension_settings[EXT_NAME]; }

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
    s.rules = s.rules.filter(r => r.id && Array.isArray(r.triggers) && Array.isArray(r.actions));

    if (!s.profiles) {
        s.profiles           = { Default: { rules: structuredClone(s.rules) } };
        s.currentProfileName = 'Default';
    }
    if (!s.profiles[s.currentProfileName]) {
        s.currentProfileName = Object.keys(s.profiles)[0];
    }

    _migrateSettings(s);
}

function _migrateSettings(s) {
    let migrated = 0;
    const migrateRules = (rules) => {
        for (const rule of (rules ?? [])) {
            for (const action of (rule.actions ?? [])) {
                if (action.type === 'lbWrite') {
                    action.type   = 'update';
                    action.config = { target: 'lorebook', ...(action.config ?? {}) };
                    migrated++;
                }
            }
        }
    };
    migrateRules(s.rules);
    for (const profile of Object.values(s.profiles ?? {})) migrateRules(profile.rules);
    if (migrated > 0) {
        console.log(`[triggeryze] migrated ${migrated} lbWrite action(s) to update`);
        saveSettingsDebounced();
    }
}
