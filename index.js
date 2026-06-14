/**
 * @file st-extensions/SillyTavern-Triggeryze/index.js
 * @stamp {"utc":"2026-06-13T00:00:00.000Z"}
 * @architectural-role Feature Entry Point
 * @description
 * Extension entry point. Owns settings initialisation, event wiring,
 * and the settings panel UI.
 *
 * The settings panel is a rule composer: users build rules from trigger
 * ingredients (WHEN) and action ingredients (DO). Each ingredient type
 * is defined in the trigger and action registries — this file reads those
 * registries to populate the UI and never hard-codes a specific trigger
 * or action type.
 *
 * Rule shape:
 *   {
 *     id:           string,           — stable unique ID (dedup key)
 *     enabled:      boolean,
 *     triggerLogic: 'any' | 'all',    — OR / AND
 *     triggers:     [{ type, config }],
 *     actions:      [{ type, config }],
 *   }
 *
 * @api-declaration
 * Entry points: GENERATION_STARTED, STREAM_TOKEN_RECEIVED, MESSAGE_RECEIVED
 * Settings:     loadSettings(), getSettings()
 *
 * @contract
 *   assertions:
 *     purity:          owns settings and DOM panel; no rule evaluation logic
 *     state_ownership: [extension_settings.triggeryze]
 *     external_io:     eventSource (event wiring only)
 */

import { eventSource, event_types, saveSettingsDebounced, callPopup } from '../../../../script.js';
import { extension_settings }                               from '../../../extensions.js';
import { TRIGGER_REGISTRY }                                 from './triggers.js';
import { ACTION_REGISTRY }                                  from './actions.js';
import { onGenerationStarted, onStreamToken, onMessageReceived, fireRuleManually, reinjectRuleBadges } from './engine.js';
import { ensureBadge, setBadge, reinjectAllBadges, removeAllBadges } from './badge.js';

const EXT_NAME = 'triggeryze';

const DEFAULTS = {
    enabled: true,
    verbose: false,
    nonStreaming: false,
    showBadges: true,
    rules: [],
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function loadSettings() {
    // One-time migration: streameryze settings key → triggeryze
    if (extension_settings['streameryze'] && !extension_settings['triggeryze']) {
        extension_settings['triggeryze'] = extension_settings['streameryze'];
        delete extension_settings['streameryze'];
    }
    extension_settings[EXT_NAME] ??= {};
    const s = extension_settings[EXT_NAME];
    for (const [k, v] of Object.entries(DEFAULTS)) {
        s[k] ??= structuredClone(v);
    }
    // Drop any rules that predate the trigger/action pipeline format
    s.rules = s.rules.filter(r => r.id && Array.isArray(r.triggers) && Array.isArray(r.actions));

    // One-time migration: flat rules → profile-based structure
    if (!s.profiles) {
        s.profiles           = { Default: { rules: structuredClone(s.rules) } };
        s.currentProfileName = 'Default';
    }
    // Guard: ensure the stored current profile still exists
    if (!s.profiles[s.currentProfileName]) {
        s.currentProfileName = Object.keys(s.profiles)[0];
    }
}

function getSettings() { return extension_settings[EXT_NAME]; }

// ---------------------------------------------------------------------------
// Profile management
// ---------------------------------------------------------------------------

function isProfileDirty() {
    const s = getSettings();
    return JSON.stringify(s.rules) !== JSON.stringify(s.profiles[s.currentProfileName]?.rules ?? []);
}

function updateProfileDirtyIndicator() {
    const s     = getSettings();
    const label = s.currentProfileName + (isProfileDirty() ? ' *' : '');
    const $sel  = $('#trg-profile-select');
    $sel.find(`option[value="${CSS.escape(s.currentProfileName)}"]`).text(label);
    $sel.val(s.currentProfileName);
}

function refreshProfileDropdown() {
    const s    = getSettings();
    const $sel = $('#trg-profile-select').empty();
    for (const name of Object.keys(s.profiles)) {
        $sel.append($('<option>').val(name).text(name));
    }
    updateProfileDirtyIndicator();
}

function bindProfileHandlers() {
    $('#trg-profile-select').on('change', function () {
        const s       = getSettings();
        const newName = $(this).val();
        if (!s.profiles[newName]) return;
        s.currentProfileName = newName;
        s.rules              = structuredClone(s.profiles[newName].rules ?? []);
        saveSettingsDebounced();
        renderRules();
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
        renderRules();
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
                renderRules();
                toastr.success(`Profile "${name}" imported.`);
            } else if (data.type === 'rule') {
                if (!data.rule || !Array.isArray(data.rule.triggers)) { toastr.error('Invalid rule data.', 'Triggeryze'); return; }
                const rule = structuredClone(data.rule);
                rule.id    = makeId();
                s.rules.push(rule);
                saveSettingsDebounced();
                renderRules();
                toastr.success(`Rule "${rule.name || 'Untitled'}" imported.`);
            } else {
                toastr.error(`Unknown export type: "${data.type}".`, 'Triggeryze');
            }
        });
        $input.trigger('click');
    });
}

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

const _collapsedRules = new Set();

// ---------------------------------------------------------------------------
// Settings panel — rule rendering
// ---------------------------------------------------------------------------

/**
 * Renders a single ingredient item (trigger or action) into a row element.
 * onConfigChange updates settings in-place without re-rendering the panel.
 * onDelete removes the item and re-renders.
 */
function renderIngredient(item, registry, onConfigChange, onDelete, ctx = null) {
    const def = registry[item.type];
    const label = def?.label ?? item.type;

    const $row = $(`
<div class="trg-ingredient">
    <span class="trg-ingredient-label">${label}</span>
    <div class="trg-ingredient-config"></div>
    <button class="trg-btn-icon trg-ingredient-delete" title="Remove">✕</button>
</div>`);

    if (def?.renderConfig) {
        def.renderConfig($row.find('.trg-ingredient-config'), item.config ?? {}, onConfigChange, ctx);
    }
    $row.find('.trg-ingredient-delete').on('click', onDelete);
    return $row;
}

/**
 * Renders an "add ingredient" button that shows a type picker on click.
 * onPick(type) is called with the chosen type key; it should update settings
 * and call renderRules() to rebuild the panel.
 */
function renderAddButton(label, registry, onPick) {
    const $wrap = $('<span class="trg-add-wrap">');
    const $btn  = $(`<button class="trg-add-btn">${label}</button>`);
    $btn.on('click', () => {
        if ($wrap.find('.trg-picker').length) return; // already open
        const $picker = $('<select class="trg-picker"><option value="">— type —</option></select>');
        Object.entries(registry).forEach(([type, def]) => {
            $picker.append(`<option value="${type}">${def.label}</option>`);
        });
        $picker.on('change', function () {
            if (!this.value) return;
            $picker.remove();
            onPick(this.value);
        });
        $picker.on('blur', () => setTimeout(() => $picker.remove(), 150));
        $wrap.append($picker);
        $picker.trigger('focus');
    });
    $wrap.append($btn);
    return $wrap;
}

/** Renders a full rule card. Structural changes trigger renderRules(); config edits do not. */
function renderRuleCard(rule, ruleIdx) {
    const s = getSettings();

    const save = () => { saveSettingsDebounced(); updateProfileDirtyIndicator(); };
    const rebuild = () => { save(); renderRules(); };

    const $card = $(`<div class="trg-rule-card${_collapsedRules.has(rule.id) ? ' trg-collapsed' : ''}" data-rule-id="${rule.id}">`);

    // ── Header ──────────────────────────────────────────────────────────────
    const triggerSummary = (() => {
        const t = rule.triggers?.[0];
        if (!t) return '';
        if (t.type === 'keywordMatch') {
            const kws = (t.config?.keywords ?? '').split(',').map(k => k.trim()).filter(Boolean);
            return kws.length ? kws[0] : '';
        }
        if (t.type === 'lbKeyword') return 'lorebook kw';
        if (t.type === 'regex')     return t.config?.pattern ? `/${t.config.pattern}/` : 'regex';
        return TRIGGER_REGISTRY[t.type]?.label ?? t.type;
    })();
    const actionSummary = (() => {
        const a = rule.actions?.[0];
        if (!a) return '';
        return ACTION_REGISTRY[a.type]?.label ?? a.type;
    })();
    const summary = [triggerSummary, actionSummary].filter(Boolean).join(' → ');

    const $hdr = $(`
<div class="trg-rule-header">
    <input type="checkbox" class="trg-rule-toggle" ${rule.enabled ? 'checked' : ''} title="Enable" />
    <input type="text" class="trg-rule-name" placeholder="Rule ${ruleIdx + 1}" />
    <span class="trg-rule-summary">${summary}</span>
    <button class="trg-btn-icon trg-rule-dev${rule.devMode ? ' trg-dev-on' : ''}" title="Dev mode — logs full rule execution to console">DEV</button>
    <button class="trg-btn-icon trg-rule-export" title="Export rule as JSON"><i class="fa-solid fa-file-export"></i></button>
    <button class="trg-btn-icon trg-rule-collapse" title="Collapse"><i class="fa-solid fa-chevron-down"></i></button>
    <button class="trg-btn-icon trg-rule-delete" title="Delete rule">✕</button>
</div>`);
    $hdr.find('.trg-rule-name').val(rule.name || '');
    $hdr.find('.trg-rule-toggle').on('change', function () { rule.enabled = this.checked; rebuild(); });
    $hdr.find('.trg-rule-name').on('input', function () { rule.name = this.value; save(); });
    $hdr.find('.trg-rule-export').on('click', () => {
        const label = (rule.name || `rule-${ruleIdx + 1}`).replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
        downloadJson(`triggeryze-${label}.json`, { version: 1, type: 'rule', rule: structuredClone(rule) });
    });
    $hdr.find('.trg-rule-dev').on('click', function () { rule.devMode = !rule.devMode; $(this).toggleClass('trg-dev-on'); save(); });
    $hdr.find('.trg-rule-delete').on('click', () => { s.rules.splice(ruleIdx, 1); rebuild(); });
    $hdr.find('.trg-rule-collapse').on('click', () => {
        $card.toggleClass('trg-collapsed');
        if ($card.hasClass('trg-collapsed')) _collapsedRules.add(rule.id);
        else _collapsedRules.delete(rule.id);
    });
    $card.append($hdr);

    // ── Body (collapsible) ───────────────────────────────────────────────────
    const $body = $('<div class="trg-rule-body">');

    // ── WHEN section ────────────────────────────────────────────────────────
    const $when = $('<div class="trg-section">');
    const $whenHdr = $(`
<div class="trg-section-label">
    WHEN <select class="trg-logic-select">
        <option value="any" ${rule.triggerLogic !== 'all' ? 'selected' : ''}>any</option>
        <option value="all" ${rule.triggerLogic === 'all' ? 'selected' : ''}>all</option>
    </select> of:
</div>`);
    $whenHdr.find('.trg-logic-select').on('change', function () { rule.triggerLogic = this.value; rebuild(); });
    $when.append($whenHdr);

    const $triggers = $('<div class="trg-ingredient-list">');
    (rule.triggers ?? []).forEach((trigger, tidx) => {
        const $row = renderIngredient(
            trigger,
            TRIGGER_REGISTRY,
            (newConfig) => { rule.triggers[tidx].config = newConfig; save(); },  // config-only, no rebuild
            () => { rule.triggers.splice(tidx, 1); rebuild(); }
        );
        $triggers.append($row);
    });
    $when.append($triggers);
    $when.append(renderAddButton('+ trigger', TRIGGER_REGISTRY, (type) => {
        rule.triggers.push({ type, config: structuredClone(TRIGGER_REGISTRY[type].defaultConfig) });
        rebuild();
    }));
    $body.append($when);

    // ── DO section ──────────────────────────────────────────────────────────
    const $do = $('<div class="trg-section">');
    $do.append('<div class="trg-section-label">DO:</div>');

    const $actions = $('<div class="trg-ingredient-list">');
    (rule.actions ?? []).forEach((action, aidx) => {
        const $row = renderIngredient(
            action,
            ACTION_REGISTRY,
            (newConfig) => { rule.actions[aidx].config = newConfig; save(); },   // config-only, no rebuild
            () => { rule.actions.splice(aidx, 1); rebuild(); },
            { priorActions: rule.actions.slice(0, aidx) }
        );
        // Refresh all legends when a Save-as name is committed (blur, not every keystroke).
        $row.on('focusout', '.trg-outvar-field', () => rebuild());
        $actions.append($row);
    });
    $do.append($actions);
    // imageGen may only appear once per rule — hide it from the picker once added
    const hasImageGen = rule.actions.some(a => a.type === 'imageGen');
    const addableActions = hasImageGen
        ? Object.fromEntries(Object.entries(ACTION_REGISTRY).filter(([k]) => k !== 'imageGen'))
        : ACTION_REGISTRY;
    $do.append(renderAddButton('+ action', addableActions, (type) => {
        rule.actions.push({ type, config: structuredClone(ACTION_REGISTRY[type].defaultConfig) });
        rebuild();
    }));
    $body.append($do);
    $card.append($body);

    return $card;
}

function renderRules() {
    const rules = getSettings().rules ?? [];
    const $list = $('#trg_rules_list').empty();
    if (!rules.length) {
        $list.append('<p class="trg-empty">No rules yet. Add one below.</p>');
        return;
    }
    rules.forEach((rule, i) => $list.append(renderRuleCard(rule, i)));
}

// ---------------------------------------------------------------------------
// Settings panel — shell
// ---------------------------------------------------------------------------

async function addSettingsPanel() {
    $('#extensions_settings2').append(`
<div id="triggeryze_settings">
<div class="inline-drawer">
<div class="inline-drawer-toggle inline-drawer-header">
    <b>Triggeryze</b>
    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
</div>
<div class="inline-drawer-content">
    <label class="checkbox_label">
        <input type="checkbox" id="trg_enabled" />
        <span>Enable</span>
    </label>
    <label class="checkbox_label">
        <input type="checkbox" id="trg_verbose" />
        <span>Verbose logging</span>
    </label>
    <label class="checkbox_label">
        <input type="checkbox" id="trg_nonstreaming" />
        <span>Run on non-streaming responses</span>
    </label>
    <label class="checkbox_label">
        <input type="checkbox" id="trg_showbadges" />
        <span>Show status badges on messages</span>
    </label>
    <hr />
    <div class="trg-profile-bar">
        <select id="trg-profile-select" class="trg-profile-select"></select>
        <button id="trg-profile-save"   class="trg-btn-icon" title="Save rules to this profile"><i class="fa-solid fa-floppy-disk"></i></button>
        <button id="trg-profile-add"    class="trg-btn-icon" title="Save as new profile"><i class="fa-solid fa-plus"></i></button>
        <button id="trg-profile-rename" class="trg-btn-icon" title="Rename profile"><i class="fa-solid fa-pencil"></i></button>
        <button id="trg-profile-delete" class="trg-btn-icon" title="Delete profile"><i class="fa-solid fa-trash"></i></button>
        <span class="trg-profile-sep"></span>
        <button id="trg-profile-export" class="trg-btn-icon" title="Export current profile as JSON"><i class="fa-solid fa-file-export"></i></button>
        <button id="trg-profile-import" class="trg-btn-icon" title="Import profile or rule from JSON"><i class="fa-solid fa-file-import"></i></button>
    </div>
    <div id="trg_rules_list"></div>
    <button id="trg_add_rule" class="menu_button"><i class="fa-solid fa-plus"></i> Add rule</button>
    <div class="inline-drawer trg-ref-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
        <b>Template Language</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
        <div class="trg-ref-body">

        <div class="trg-ref-section">Variables — insert with <span class="trg-help-eg">{{name}}</span></div>
        <table class="trg-ref-table">
            <tr><td><span class="trg-help-eg">{{keyword}}</span></td><td>word or phrase that matched the trigger</td></tr>
            <tr><td><span class="trg-help-eg">{{up-to}}</span></td><td>all text before the keyword</td></tr>
            <tr><td><span class="trg-help-eg">{{paragraph}}</span></td><td>paragraph containing the keyword</td></tr>
            <tr><td><span class="trg-help-eg">{{message}}</span></td><td>full message text</td></tr>
            <tr><td><span class="trg-help-eg">{{history}}</span></td><td>recent chat history</td></tr>
            <tr><td><span class="trg-help-eg">{{char}}</span></td><td>character name</td></tr>
            <tr><td><span class="trg-help-eg">{{user}}</span></td><td>user name</td></tr>
            <tr><td><span class="trg-help-eg">{{myVar}}</span></td><td>any variable set by a prior <i>compose variable</i> action in this rule</td></tr>
        </table>

        <div class="trg-ref-section">Lorebook lookup — <span class="trg-help-eg">{{getLBcontent ...}}</span></div>
        <p>Embeds a lorebook entry by title. Resolved before variable substitution.</p>
        <table class="trg-ref-table">
            <tr><td><span class="trg-help-eg">{{getLBcontent keyword}}</span></td><td>entry whose title matches the trigger keyword</td></tr>
            <tr><td><span class="trg-help-eg">{{getLBcontent [Entry Name]}}</span></td><td>literal entry title — brackets required for names with spaces</td></tr>
            <tr><td><span class="trg-help-eg">{{getLBcontent LB:[Entry Name]}}</span></td><td>same, scoped to a specific lorebook</td></tr>
        </table>
        <p style="opacity:.6;font-size:.9em">Output: <span class="trg-help-eg">Title:\n(keys)\ncontent</span> — on miss, logs to console and inserts nothing.</p>

        <div class="trg-ref-section">Conditional blocks</div>
        <div class="trg-help-eg trg-ref-block">{{if condition}}body{{/if}}</div>
        <p>Condition uses bare variable names — no <span class="trg-help-eg">{{}}</span> around them. Body may contain <span class="trg-help-eg">{{variable}}</span> substitutions. Blocks can be stacked but not nested.</p>

        <div class="trg-ref-section">Condition operators</div>
        <table class="trg-ref-table">
            <tr><td><span class="trg-help-eg">name matches "pattern"</span></td><td>regex test, case-insensitive. <span class="trg-help-eg">|</span> for alternation.</td></tr>
            <tr><td><span class="trg-help-eg">name contains "text"</span></td><td>substring — true if value includes text anywhere</td></tr>
            <tr><td><span class="trg-help-eg">name is "value"</span></td><td>exact whole-word match</td></tr>
            <tr><td><span class="trg-help-eg">name in (a, b, c)</span></td><td>true if value equals any item in the list</td></tr>
            <tr><td><span class="trg-help-eg">name empty</span></td><td>true if variable is empty or unset</td></tr>
        </table>

        <div class="trg-ref-section">Boolean combinators — precedence: <span class="trg-help-eg">!</span> &gt; <span class="trg-help-eg">AND</span> &gt; <span class="trg-help-eg">OR</span></div>
        <table class="trg-ref-table">
            <tr><td><span class="trg-help-eg">A AND B</span></td><td>true only when both conditions are true</td></tr>
            <tr><td><span class="trg-help-eg">A OR B</span></td><td>true when either condition is true</td></tr>
            <tr><td><span class="trg-help-eg">!A</span></td><td>inverts the condition</td></tr>
            <tr><td><span class="trg-help-eg">( )</span></td><td>grouping — overrides default precedence</td></tr>
        </table>

        <div class="trg-ref-section">Examples</div>
        <table class="trg-ref-table trg-ref-examples">
            <tr><td><span class="trg-help-eg">{{if keyword matches "breath|hitch"}}Forced Physical Reaction Cliché{{/if}}</span></td></tr>
            <tr><td><span class="trg-help-eg">{{if keyword is "stone"}}Purple Prose Metaphor{{/if}}</span></td></tr>
            <tr><td><span class="trg-help-eg">{{if keyword matches "breath" OR keyword matches "claiming"}}label{{/if}}</span></td></tr>
            <tr><td><span class="trg-help-eg">{{if keyword matches "breath" AND message contains "shaky"}}label{{/if}}</span></td></tr>
            <tr><td><span class="trg-help-eg">{{if !(keyword empty)}}Matched: {{keyword}}{{/if}}</span></td></tr>
        </table>

        </div>
    </div>
    </div>
    <style>
        .trg-profile-bar     { display:flex; align-items:center; gap:4px; margin-bottom:10px; }
        .trg-profile-select  { flex:1; font-size:.85em; }
        .trg-rule-card       { border:1px solid rgba(255,255,255,.1); border-radius:6px; padding:8px; margin-bottom:10px; }
        .trg-rule-header     { display:flex; align-items:center; gap:8px; margin-bottom:6px; cursor:default; }
        .trg-rule-name       { background:transparent; border:none; border-bottom:1px solid transparent; font-weight:bold; font-size:.9em; opacity:.7; padding:0 2px; min-width:50px; max-width:160px; color:inherit; cursor:text; }
        .trg-rule-name:hover { border-bottom-color:rgba(255,255,255,.2); opacity:.9; }
        .trg-rule-name:focus { border-bottom-color:var(--SmartThemeBodyColor,#aaa); outline:none; background:rgba(255,255,255,.05); opacity:1; }
        .trg-rule-summary    { flex:1; font-size:.78em; opacity:.45; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-style:italic; }
        .trg-profile-sep     { width:1px; height:16px; background:rgba(255,255,255,.15); flex-shrink:0; margin:0 2px; align-self:center; }
        .trg-rule-collapse i { transition:transform .18s; display:inline-block; }
        .trg-collapsed .trg-rule-collapse i { transform:rotate(-90deg); }
        .trg-collapsed .trg-rule-body { display:none; }
        .trg-collapsed .trg-rule-header { margin-bottom:0; }
        .trg-section         { margin-bottom:8px; padding-left:4px; }
        .trg-section-label   { font-size:.8em; opacity:.6; text-transform:uppercase; letter-spacing:.05em; margin-bottom:4px; display:flex; align-items:center; gap:6px; }
        .trg-ingredient-list { display:flex; flex-direction:column; gap:4px; margin-bottom:6px; }
        .trg-ingredient      { display:flex; align-items:center; gap:6px; flex-wrap:wrap; background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.1); border-radius:4px; padding:4px 6px; }
        .trg-ingredient-label{ font-size:.85em; min-width:100px; opacity:.9; }
        .trg-ingredient-config{ flex:1; min-width:0; }
        .trg-ingredient-config .trg-cfg { width:100%; }
        .trg-ingredient-config .trg-hint{ opacity:.55; font-size:.8em; }
        .trg-add-wrap        { display:inline-flex; align-items:center; gap:4px; }
        .trg-add-btn         { background:transparent; border:1px solid var(--border-color-light, #444); border-radius:4px; font-size:.85em; padding:3px 10px; white-space:nowrap; cursor:pointer; transition:border-color .15s; }
        .trg-add-btn:hover   { border-color:var(--SmartThemeQuoteColor, #aaa); }
        .trg-picker          { font-size:.85em; }
        .trg-btn-icon        { background:none; border:none; cursor:pointer; opacity:.5; padding:0 4px; font-size:.9em; }
        .trg-btn-icon:hover  { opacity:1; }
        .trg-rule-dev        { font-size:.7em; font-weight:700; letter-spacing:.05em; }
        .trg-rule-dev.trg-dev-on { opacity:1; color:#f0a500; }
        .trg-logic-select    { font-size:.8em; padding:1px 4px; }
        .trg-empty           { opacity:.5; font-style:italic; }
        .trg-sc-wrap         { display:flex; flex-direction:column; gap:4px; width:100%; }
        .trg-sc-row          { display:flex; align-items:center; gap:6px; }
        .trg-sc-lbl          { font-size:.8em; opacity:.6; min-width:72px; text-align:right; flex-shrink:0; }
        .trg-sc-hint-inline  { font-size:.78em; opacity:.5; }
        .trg-sc-prompt       { width:100%; }
        /* ── Dark-theme fix for inputs that lack text_pole ───────── */
        .trg-ingredient-config input[type="text"]:not(.text_pole),
        .trg-ingredient-config input[type="number"] {
            background: var(--SmartThemeBlurTintColor, rgba(0,0,0,.3));
            color: var(--SmartThemeBodyColor, #ccc);
            border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,.15));
            border-radius: 4px;
            padding: 2px 6px;
            box-sizing: border-box;
        }
        /* ── Status badge ─────────────────────────────────────────── */
        @keyframes trg-pulse { 0%,100%{background:rgba(200,55,55,.45);border-color:rgba(200,55,55,.7)} 50%{background:rgba(200,55,55,.1);border-color:rgba(200,55,55,.3)} }
        .trg-badge           { display:inline-flex; align-items:center; gap:4px; font-size:.72em; padding:2px 7px; border-radius:10px; border:1px solid var(--SmartThemeBorderColor,#444); white-space:nowrap; user-select:none; margin-top:3px; opacity:.85; transition:background .2s, border-color .2s, color .2s; cursor:pointer; }
        .trg-badge:hover     { opacity:1; }
        .trg-badge-unchanged { background:rgba(128,128,128,.1); color:var(--SmartThemeBodyColor,#ccc); opacity:.5; }
        .trg-badge-thinking  { animation:trg-pulse .7s ease-in-out infinite; color:#f99; }
        .trg-badge-modified  { background:rgba(50,180,80,.25); border-color:rgba(50,180,80,.5); color:#8f8; }
        .trg-rule-badge      { display:inline-flex; align-items:center; font-size:.72em; padding:2px 9px; border-radius:10px; border:1px solid; white-space:nowrap; user-select:none; margin-top:3px; margin-left:4px; opacity:.8; cursor:pointer; transition:opacity .15s, transform .1s; background:none; }
        .trg-rule-badge:hover  { opacity:1; transform:translateY(-1px); }
        .trg-rule-badge:active { transform:translateY(0); }
        .trg-check-row       { display:inline-flex; align-items:center; gap:5px; font-size:.8em; opacity:.65; cursor:pointer; }
        .trg-check-row input { width:auto !important; cursor:pointer; }
        .trg-hint-warn       { color:rgba(255,190,80,.85); border-left-color:rgba(255,190,80,.4) !important; }
        .trg-kw-preview      { font-size:.78em; opacity:.7; margin-top:4px; line-height:1.7; padding:4px 7px; border-left:2px solid rgba(255,255,255,.15); }
        .trg-kw-preview em   { font-style:normal; opacity:.9; }
        .trg-prev-kw         { font-family:monospace; background:rgba(255,255,255,.08); border-radius:3px; padding:0 4px; }
        .trg-prev-re         { opacity:.45; font-family:monospace; font-size:.9em; }
        .trg-var-preview     { font-size:.82em; opacity:.8; margin-top:3px; }
        .trg-prev-unset      { opacity:.45; font-style:italic; }
        .trg-kw-footer       { display:flex; align-items:center; gap:8px; margin-top:3px; }
        .trg-help-toggle     { font-size:.75em; opacity:.45; cursor:pointer; border:1px solid currentColor; border-radius:50%; padding:0 4px; line-height:1.6; transition:opacity .15s; }
        .trg-help-toggle:hover, .trg-help-open { opacity:.9 !important; }
        .trg-help-text       { font-size:.78em; opacity:.65; margin-top:5px; line-height:1.6; padding:5px 7px; border-left:2px solid rgba(255,255,255,.12); }
        .trg-help-eg         { font-family:monospace; background:rgba(255,255,255,.08); border-radius:3px; padding:0 4px; }
        /* ── Variable legend (click-to-inject chips) ────────────── */
        .trg-var-legend      { display:flex; flex-wrap:wrap; gap:3px; margin-bottom:5px; align-items:center; }
        .trg-var-chip        { font-family:monospace; font-size:.73em; padding:1px 6px; border-radius:10px; cursor:pointer; user-select:none; border:1px solid; transition:opacity .12s, transform .1s; white-space:nowrap; }
        .trg-var-chip:hover  { transform:translateY(-1px); opacity:1 !important; }
        .trg-var-chip:active { transform:translateY(0); }
        .trg-var-chip-sys    { background:rgba(128,128,128,.12); border-color:rgba(128,128,128,.28); opacity:.6; }
        .trg-var-chip-lb     { background:rgba(50,160,200,.1); border-color:rgba(50,160,200,.35); color:#6bc; opacity:.65; }
        .trg-var-chip-rule   { background:rgba(220,160,50,.15); border-color:rgba(220,160,50,.5); color:#d4a830; }
        .trg-var-legend-sep  { width:1px; height:14px; background:rgba(255,255,255,.15); flex-shrink:0; margin:0 2px; align-self:center; }
        /* ── Pending-keyword highlight (sideCall in flight) ──────── */
        .trg-pending-kw      { background:rgba(255,200,50,.18); border-radius:2px; padding:0 1px; outline:1px solid rgba(255,200,50,.35); }
        /* ── Template language reference drawer ─────────────────── */
        .trg-ref-drawer      { margin-top:10px; }
        .trg-ref-body        { font-size:.8em; line-height:1.7; padding:2px 0 6px; }
        .trg-ref-section     { font-weight:bold; opacity:.7; margin:10px 0 3px; font-size:.85em; text-transform:uppercase; letter-spacing:.04em; }
        .trg-ref-section:first-child { margin-top:2px; }
        .trg-ref-table       { border-collapse:collapse; width:100%; margin-bottom:2px; }
        .trg-ref-table td    { padding:1px 10px 1px 0; vertical-align:top; }
        .trg-ref-block       { display:block; margin:3px 0; }
        .trg-ref-examples td { padding:2px 0; }
        /* ── imageGen action ─────────────────────────────────────── */
        .trg-ig-wrap         { display:flex; flex-direction:column; gap:4px; width:100%; }
        .trg-ig-footer       { display:flex; align-items:center; gap:8px; margin-top:2px; }
        .trg-ig-test         { font-size:.8em; padding:2px 10px; flex-shrink:0; }
        .trg-ig-test-status  { font-size:.8em; opacity:.8; }
    </style>
</div>
</div>
</div>`);

    const s = getSettings();
    $('#trg_enabled').prop('checked', s.enabled);
    $('#trg_verbose').prop('checked', s.verbose);
    $('#trg_nonstreaming').prop('checked', s.nonStreaming);
    $('#trg_showbadges').prop('checked', s.showBadges);

    $('#trg_enabled').on('change', function () { getSettings().enabled = this.checked; saveSettingsDebounced(); });
    $('#trg_verbose').on('change', function () { getSettings().verbose = this.checked; saveSettingsDebounced(); });
    $('#trg_nonstreaming').on('change', function () { getSettings().nonStreaming = this.checked; saveSettingsDebounced(); });
    $('#trg_showbadges').on('change', function () {
        getSettings().showBadges = this.checked;
        saveSettingsDebounced();
        if (this.checked) reinjectAllBadges(); else removeAllBadges();
    });
    $('#trg_add_rule').on('click', () => {
        getSettings().rules.push({ id: makeId(), enabled: true, triggerLogic: 'any', triggers: [], actions: [] });
        saveSettingsDebounced();
        renderRules();
    });

    refreshProfileDropdown();
    bindProfileHandlers();
    renderRules();
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

loadSettings();
eventSource.on(event_types.GENERATION_STARTED,          onGenerationStarted);
eventSource.on(event_types.STREAM_TOKEN_RECEIVED,        onStreamToken);
eventSource.on(event_types.MESSAGE_RECEIVED,             onMessageReceived);
eventSource.on(event_types.CHAT_CHANGED,               () => { reinjectAllBadges(); reinjectRuleBadges(); });
eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED,   (messageId) => { ensureBadge(messageId); reinjectRuleBadges(messageId); });

$(document).on('click', '.trg-badge', async function () {
    const messageId = parseInt($(this).closest('.mes').attr('mesid'), 10);
    if (isNaN(messageId)) return;
    setBadge(messageId, 'unchanged');
    await onMessageReceived(messageId);
});

$(document).on('click', '.trg-rule-badge', async function () {
    const ruleId    = $(this).data('rule-id');
    const messageId = parseInt($(this).data('mesid'), 10);
    if (!ruleId || isNaN(messageId)) return;
    await fireRuleManually(ruleId, messageId);
});
addSettingsPanel();
