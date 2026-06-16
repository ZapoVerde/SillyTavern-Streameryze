/**
 * @file st-extensions/SillyTavern-Triggeryze/settings/profiles.js
 * @stamp {"utc":"2026-06-16T00:00:00.000Z"}
 * @architectural-role UI — profile dropdown, dirty-state tracking, import/export handlers
 * @description
 * Owns the profile switcher UI: the dropdown, save/add/rename/delete/export/import buttons,
 * and the dirty-state asterisk. All handlers are wired in bindProfileHandlers; the caller
 * supplies an onRenderRules callback to avoid a circular dependency on rule-cards.js.
 *
 * Import/export now uses the v2 boundary layer in format.js: JSONC comments are stripped,
 * shapes are detected structurally, type keys and config field names are translated,
 * and named warnings are emitted for unknown types or missing required fields.
 *
 * @api-declaration
 * isProfileDirty()                    — true when active rulesets differ from saved profile snapshot
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
import { getSettings, makeId }              from './storage.js';
import { parseAndImport, exportProfile, exportRuleset } from './format.js';

function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

function _showImportWarnings(warnings) {
    if (!warnings.length) return;
    const n = warnings.length;
    toastr.warning(`${n} warning${n > 1 ? 's' : ''} on import — see console for details`, 'Triggeryze');
    for (const w of warnings) console.warn('[triggeryze:import]', w);
}

export function isProfileDirty() {
    const s = getSettings();
    return JSON.stringify(s.rulesets) !== JSON.stringify(s.profiles[s.currentProfileName]?.rulesets ?? []);
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

function _applyImport({ shape, name, rulesets, rule, warnings }, onRenderRules) {
    if (!shape) {
        toastr.error(warnings[0] ?? 'Import failed.', 'Triggeryze');
        return false;
    }
    const s = getSettings();
    if (shape === 'profile') {
        if (!rulesets?.length) { toastr.error('Profile has no rulesets.', 'Triggeryze'); return false; }
        let pname = name ?? 'Imported';
        if (s.profiles[pname]) pname = `${pname} (imported)`;
        if (s.profiles[pname]) pname = `${pname} ${Date.now()}`;
        s.profiles[pname]    = { rulesets };
        s.currentProfileName = pname;
        s.rulesets           = structuredClone(rulesets);
        saveSettingsDebounced();
        refreshProfileDropdown();
        onRenderRules();
        toastr.success(`Profile "${pname}" imported.`);
        return true;
    }
    if (shape === 'ruleset') {
        const rs = rulesets?.[0];
        if (!rs) { toastr.error('Invalid ruleset.', 'Triggeryze'); return false; }
        s.rulesets.push(rs);
        saveSettingsDebounced();
        onRenderRules();
        toastr.success(`Ruleset "${rs.name || 'Untitled'}" imported.`);
        return true;
    }
    if (shape === 'rule') {
        if (!rule) { toastr.error('Invalid rule.', 'Triggeryze'); return false; }
        if (!s.rulesets.length) s.rulesets.push({ id: makeId(), name: 'Default', enabled: true, rules: [] });
        s.rulesets[s.rulesets.length - 1].rules.push(rule);
        saveSettingsDebounced();
        onRenderRules();
        toastr.success(`Rule "${rule.name || 'Untitled'}" imported.`);
        return true;
    }
    return false;
}

export function bindProfileHandlers(onRenderRules) {
    $('#trg-profile-select').on('change', function () {
        const s       = getSettings();
        const newName = $(this).val();
        if (!s.profiles[newName]) return;
        s.currentProfileName = newName;
        s.rulesets           = structuredClone(s.profiles[newName].rulesets ?? []);
        saveSettingsDebounced();
        onRenderRules();
        updateProfileDirtyIndicator();
    });

    $('#trg-profile-save').on('click', function () {
        const s = getSettings();
        s.profiles[s.currentProfileName] = { rulesets: structuredClone(s.rulesets) };
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
        s.profiles[name]     = { rulesets: structuredClone(s.rulesets) };
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
        s.rulesets           = structuredClone(s.profiles[s.currentProfileName].rulesets ?? []);
        saveSettingsDebounced();
        refreshProfileDropdown();
        onRenderRules();
    });

    $('#trg-profile-export').on('click', function () {
        const s    = getSettings();
        const name = s.currentProfileName;
        const safe = name.replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
        downloadJson(`triggeryze-${safe}.json`, exportProfile(name, s.rulesets));
    });

    $('#trg-profile-import').on('click', function () {
        const $input = $('<input type="file" accept=".json" style="display:none">');
        $('body').append($input);
        $input.on('change', async function () {
            $input.remove();
            const file = this.files?.[0];
            if (!file) return;
            const text = await file.text();
            const result = parseAndImport(text, makeId);
            _showImportWarnings(result.warnings);
            _applyImport(result, onRenderRules);
        });
        $input.trigger('click');
    });

    $('#trg-profile-paste').on('click', function () {
        const $modal = $(`
            <div class="trg-paste-modal">
                <div class="trg-paste-box">
                    <p style="font-weight:bold;margin-bottom:8px">Paste JSON to import</p>
                    <textarea class="trg-paste-input" placeholder="Paste a Triggeryze profile, ruleset, or rule JSON here..." spellcheck="false"></textarea>
                    <div class="trg-paste-actions">
                        <button class="menu_button trg-paste-cancel">Cancel</button>
                        <button class="menu_button trg-paste-confirm">Import</button>
                    </div>
                </div>
            </div>
        `);
        $('body').append($modal);
        $modal.find('.trg-paste-input').trigger('focus');

        const close = () => {
            $modal.remove();
            $(document).off('keydown.trg-paste');
        };

        $modal.on('click', e => { if (e.target === $modal[0]) close(); });
        $modal.find('.trg-paste-cancel').on('click', close);
        $(document).on('keydown.trg-paste', e => { if (e.key === 'Escape') close(); });

        $modal.find('.trg-paste-confirm').on('click', function () {
            const text = $modal.find('.trg-paste-input').val().trim();
            if (!text) return;
            const result = parseAndImport(text, makeId);
            _showImportWarnings(result.warnings);
            if (_applyImport(result, onRenderRules)) close();
        });
    });
}
