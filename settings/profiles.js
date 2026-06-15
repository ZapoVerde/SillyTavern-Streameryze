/**
 * @file st-extensions/SillyTavern-Triggeryze/settings/profiles.js
 * @stamp {"utc":"2026-06-15T00:00:00.000Z"}
 * @architectural-role UI — profile dropdown, dirty-state tracking, import/export handlers
 * @description
 * Owns the profile switcher UI: the dropdown, save/add/rename/delete/export/import buttons,
 * and the dirty-state asterisk. All handlers are wired in bindProfileHandlers; the caller
 * supplies an onRenderRules callback to avoid a circular dependency on rule-cards.js.
 *
 * @api-declaration
 * isProfileDirty()                    — true when active rules differ from saved profile snapshot
 * updateProfileDirtyIndicator()       — refreshes the dropdown option text with or without " *"
 * refreshProfileDropdown()            — rebuilds the dropdown options from current profiles
 * bindProfileHandlers(onRenderRules)  — wires all profile UI event handlers
 *
 * @contract
 *   assertions:
 *     purity:          none — reads/writes extension_settings and updates DOM
 *     state_ownership: none (profile state lives in extension_settings.triggeryze)
 *     external_io:     callPopup, saveSettingsDebounced, file input (import), Blob URL (export)
 */

import { saveSettingsDebounced, callPopup } from '../../../../../script.js';
import { extension_settings }               from '../../../../extensions.js';

const EXT_NAME    = 'triggeryze';
const getSettings = () => extension_settings[EXT_NAME];

function makeId() { return Math.random().toString(36).slice(2, 9); }
function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

export function isProfileDirty() {
    const s = getSettings();
    return JSON.stringify(s.rules) !== JSON.stringify(s.profiles[s.currentProfileName]?.rules ?? []);
}

export function updateProfileDirtyIndicator() {
    const s     = getSettings();
    const label = s.currentProfileName + (isProfileDirty() ? ' *' : '');
    const $sel  = $('#trg-profile-select');
    $sel.find(`option[value="${CSS.escape(s.currentProfileName)}"]`).text(label);
    $sel.val(s.currentProfileName);
}

export function refreshProfileDropdown() {
    const s    = getSettings();
    const $sel = $('#trg-profile-select').empty();
    for (const name of Object.keys(s.profiles)) {
        $sel.append($('<option>').val(name).text(name));
    }
    updateProfileDirtyIndicator();
}

export function bindProfileHandlers(onRenderRules) {
    $('#trg-profile-select').on('change', function () {
        const s       = getSettings();
        const newName = $(this).val();
        if (!s.profiles[newName]) return;
        s.currentProfileName = newName;
        s.rules              = structuredClone(s.profiles[newName].rules ?? []);
        saveSettingsDebounced();
        onRenderRules();
        updateProfileDirtyIndicator();
    });

    $('#trg-profile-save').on('click', function () {
        const s = getSettings();
        s.profiles[s.currentProfileName] = { rules: structuredClone(s.rules) };
        saveSettingsDebounced();
        updateProfileDirtyIndicator();
        toastr.success(`Profile "${s.currentProfileName}" saved.`);
    });

    $('#trg-profile-add').on('click', async function () {
        const rawName = await callPopup('<h3>New profile name</h3>', 'input', '');
        const name    = (rawName ?? '').trim();
        if (!name) return;
        const s = getSettings();
        if (s.profiles[name]) { toastr.warning(`Profile "${name}" already exists.`); return; }
        s.profiles[name]     = { rules: structuredClone(s.rules) };
        s.currentProfileName = name;
        saveSettingsDebounced();
        refreshProfileDropdown();
    });

    $('#trg-profile-rename').on('click', async function () {
        const s       = getSettings();
        const rawName = await callPopup('<h3>Rename profile</h3>', 'input', s.currentProfileName);
        const newName = (rawName ?? '').trim();
        if (!newName || newName === s.currentProfileName) return;
        if (s.profiles[newName]) { toastr.warning(`Profile "${newName}" already exists.`); return; }
        s.profiles[newName] = s.profiles[s.currentProfileName];
        delete s.profiles[s.currentProfileName];
        s.currentProfileName = newName;
        saveSettingsDebounced();
        refreshProfileDropdown();
    });

    $('#trg-profile-delete').on('click', async function () {
        const s = getSettings();
        if (Object.keys(s.profiles).length <= 1) { toastr.warning('Cannot delete the only profile.'); return; }
        const confirmed = await callPopup(
            `<h3>Delete profile "${s.currentProfileName}"?</h3>This cannot be undone.`, 'confirm');
        if (!confirmed) return;
        delete s.profiles[s.currentProfileName];
        s.currentProfileName = Object.keys(s.profiles)[0];
        s.rules              = structuredClone(s.profiles[s.currentProfileName].rules ?? []);
        saveSettingsDebounced();
        refreshProfileDropdown();
        onRenderRules();
    });

    $('#trg-profile-export').on('click', function () {
        const s    = getSettings();
        const name = s.currentProfileName;
        const safe = name.replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
        downloadJson(`triggeryze-${safe}.json`, { version: 1, type: 'profile', name, rules: structuredClone(s.rules) });
    });

    $('#trg-profile-import').on('click', function () {
        const $input = $('<input type="file" accept=".json" style="display:none">');
        $('body').append($input);
        $input.on('change', async function () {
            $input.remove();
            const file = this.files?.[0];
            if (!file) return;
            let data;
            try { data = JSON.parse(await file.text()); } catch {
                toastr.error('Could not parse JSON file.', 'Triggeryze'); return;
            }
            if (!data?.version || !data?.type) {
                toastr.error('Not a valid Triggeryze export file.', 'Triggeryze'); return;
            }
            const s = getSettings();
            if (data.type === 'profile') {
                if (!Array.isArray(data.rules)) { toastr.error('Profile has no rules array.', 'Triggeryze'); return; }
                let name = data.name ?? 'Imported';
                if (s.profiles[name]) name = `${name} (imported)`;
                if (s.profiles[name]) name = `${name} ${Date.now()}`;
                s.profiles[name]     = { rules: data.rules };
                s.currentProfileName = name;
                s.rules              = structuredClone(data.rules);
                saveSettingsDebounced();
                refreshProfileDropdown();
                onRenderRules();
                toastr.success(`Profile "${name}" imported.`);
            } else if (data.type === 'rule') {
                if (!data.rule || !Array.isArray(data.rule.triggers)) { toastr.error('Invalid rule data.', 'Triggeryze'); return; }
                const rule = structuredClone(data.rule);
                rule.id    = makeId();
                s.rules.push(rule);
                saveSettingsDebounced();
                onRenderRules();
                toastr.success(`Rule "${rule.name || 'Untitled'}" imported.`);
            } else {
                toastr.error(`Unknown export type: "${data.type}".`, 'Triggeryze');
            }
        });
        $input.trigger('click');
    });
}
