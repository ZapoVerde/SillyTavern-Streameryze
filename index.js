/**
 * @file st-extensions/SillyTavern-Streameryze/index.js
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
 *     state_ownership: [extension_settings.streameryze]
 *     external_io:     eventSource (event wiring only)
 */

import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings }                               from '../../../extensions.js';
import { TRIGGER_REGISTRY }                                 from './triggers.js';
import { ACTION_REGISTRY }                                  from './actions.js';
import { onGenerationStarted, onStreamToken, onMessageReceived } from './engine.js';
import { ensureBadge, reinjectAllBadges, removeAllBadges } from './badge.js';

const EXT_NAME = 'streameryze';

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
    extension_settings[EXT_NAME] ??= {};
    const s = extension_settings[EXT_NAME];
    for (const [k, v] of Object.entries(DEFAULTS)) {
        s[k] ??= structuredClone(v);
    }
    // Drop any rules that predate the trigger/action pipeline format
    s.rules = s.rules.filter(r => r.id && Array.isArray(r.triggers) && Array.isArray(r.actions));
}

function getSettings() { return extension_settings[EXT_NAME]; }

function makeId() { return Math.random().toString(36).slice(2, 9); }

// ---------------------------------------------------------------------------
// Settings panel — rule rendering
// ---------------------------------------------------------------------------

/**
 * Renders a single ingredient item (trigger or action) into a row element.
 * onConfigChange updates settings in-place without re-rendering the panel.
 * onDelete removes the item and re-renders.
 */
function renderIngredient(item, registry, onConfigChange, onDelete) {
    const def = registry[item.type];
    const label = def?.label ?? item.type;

    const $row = $(`
<div class="smz-ingredient">
    <span class="smz-ingredient-label">${label}</span>
    <div class="smz-ingredient-config"></div>
    <button class="smz-btn-icon smz-ingredient-delete" title="Remove">✕</button>
</div>`);

    if (def?.renderConfig) {
        def.renderConfig($row.find('.smz-ingredient-config'), item.config ?? {}, onConfigChange);
    }
    $row.find('.smz-ingredient-delete').on('click', onDelete);
    return $row;
}

/**
 * Renders an "add ingredient" button that shows a type picker on click.
 * onPick(type) is called with the chosen type key; it should update settings
 * and call renderRules() to rebuild the panel.
 */
function renderAddButton(label, registry, onPick) {
    const $wrap = $('<span class="smz-add-wrap">');
    const $btn  = $(`<button class="smz-add-btn">${label}</button>`);
    $btn.on('click', () => {
        if ($wrap.find('.smz-picker').length) return; // already open
        const $picker = $('<select class="smz-picker"><option value="">— type —</option></select>');
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

    const save = () => saveSettingsDebounced();
    const rebuild = () => { save(); renderRules(); };

    const $card = $(`<div class="smz-rule-card" data-rule-id="${rule.id}">`);

    // ── Header ──────────────────────────────────────────────────────────────
    const $hdr = $(`
<div class="smz-rule-header">
    <input type="checkbox" class="smz-rule-toggle" ${rule.enabled ? 'checked' : ''} title="Enable" />
    <span class="smz-rule-num">Rule ${ruleIdx + 1}</span>
    <button class="smz-btn-icon smz-rule-delete" title="Delete rule">✕</button>
</div>`);
    $hdr.find('.smz-rule-toggle').on('change', function () { rule.enabled = this.checked; rebuild(); });
    $hdr.find('.smz-rule-delete').on('click', () => { s.rules.splice(ruleIdx, 1); rebuild(); });
    $card.append($hdr);

    // ── WHEN section ────────────────────────────────────────────────────────
    const $when = $('<div class="smz-section">');
    const $whenHdr = $(`
<div class="smz-section-label">
    WHEN <select class="smz-logic-select">
        <option value="any" ${rule.triggerLogic !== 'all' ? 'selected' : ''}>any</option>
        <option value="all" ${rule.triggerLogic === 'all' ? 'selected' : ''}>all</option>
    </select> of:
</div>`);
    $whenHdr.find('.smz-logic-select').on('change', function () { rule.triggerLogic = this.value; rebuild(); });
    $when.append($whenHdr);

    const $triggers = $('<div class="smz-ingredient-list">');
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
    $card.append($when);

    // ── DO section ──────────────────────────────────────────────────────────
    const $do = $('<div class="smz-section">');
    $do.append('<div class="smz-section-label">DO:</div>');

    const $actions = $('<div class="smz-ingredient-list">');
    (rule.actions ?? []).forEach((action, aidx) => {
        const $row = renderIngredient(
            action,
            ACTION_REGISTRY,
            (newConfig) => { rule.actions[aidx].config = newConfig; save(); },   // config-only, no rebuild
            () => { rule.actions.splice(aidx, 1); rebuild(); }
        );
        $actions.append($row);
    });
    $do.append($actions);
    $do.append(renderAddButton('+ action', ACTION_REGISTRY, (type) => {
        rule.actions.push({ type, config: structuredClone(ACTION_REGISTRY[type].defaultConfig) });
        rebuild();
    }));
    $card.append($do);

    return $card;
}

function renderRules() {
    const rules = getSettings().rules ?? [];
    const $list = $('#smz_rules_list').empty();
    if (!rules.length) {
        $list.append('<p class="smz-empty">No rules yet. Add one below.</p>');
        return;
    }
    rules.forEach((rule, i) => $list.append(renderRuleCard(rule, i)));
}

// ---------------------------------------------------------------------------
// Settings panel — shell
// ---------------------------------------------------------------------------

async function addSettingsPanel() {
    $('#extensions_settings2').append(`
<div id="streameryze_settings">
<div class="inline-drawer">
<div class="inline-drawer-toggle inline-drawer-header">
    <b>Streameryze</b>
    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
</div>
<div class="inline-drawer-content">
    <label class="checkbox_label">
        <input type="checkbox" id="smz_enabled" />
        <span>Enable</span>
    </label>
    <label class="checkbox_label">
        <input type="checkbox" id="smz_verbose" />
        <span>Verbose logging</span>
    </label>
    <label class="checkbox_label">
        <input type="checkbox" id="smz_nonstreaming" />
        <span>Run on non-streaming responses</span>
    </label>
    <label class="checkbox_label">
        <input type="checkbox" id="smz_showbadges" />
        <span>Show status badges on messages</span>
    </label>
    <hr />
    <div id="smz_rules_list"></div>
    <button id="smz_add_rule" class="menu_button"><i class="fa-solid fa-plus"></i> Add rule</button>
    <style>
        .smz-rule-card       { border:1px solid rgba(255,255,255,.1); border-radius:6px; padding:8px; margin-bottom:10px; }
        .smz-rule-header     { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
        .smz-rule-num        { flex:1; font-weight:bold; font-size:.9em; opacity:.7; }
        .smz-section         { margin-bottom:8px; padding-left:4px; }
        .smz-section-label   { font-size:.8em; opacity:.6; text-transform:uppercase; letter-spacing:.05em; margin-bottom:4px; display:flex; align-items:center; gap:6px; }
        .smz-ingredient-list { display:flex; flex-direction:column; gap:4px; margin-bottom:6px; }
        .smz-ingredient      { display:flex; align-items:center; gap:6px; flex-wrap:wrap; background:rgba(255,255,255,.04); border-radius:4px; padding:4px 6px; }
        .smz-ingredient-label{ font-size:.85em; min-width:100px; opacity:.9; }
        .smz-ingredient-config{ flex:1; min-width:0; }
        .smz-ingredient-config .smz-cfg { width:100%; }
        .smz-ingredient-config .smz-hint{ opacity:.55; font-size:.8em; }
        .smz-add-wrap        { display:inline-flex; align-items:center; gap:4px; }
        .smz-add-btn         { background:transparent; border:1px solid var(--border-color-light, #444); border-radius:4px; font-size:.85em; padding:3px 10px; white-space:nowrap; cursor:pointer; transition:border-color .15s; }
        .smz-add-btn:hover   { border-color:var(--SmartThemeQuoteColor, #aaa); }
        .smz-picker          { font-size:.85em; }
        .smz-btn-icon        { background:none; border:none; cursor:pointer; opacity:.5; padding:0 4px; font-size:.9em; }
        .smz-btn-icon:hover  { opacity:1; }
        .smz-logic-select    { font-size:.8em; padding:1px 4px; }
        .smz-empty           { opacity:.5; font-style:italic; }
        .smz-sc-wrap         { display:flex; flex-direction:column; gap:4px; width:100%; }
        .smz-sc-row          { display:flex; align-items:center; gap:6px; }
        .smz-sc-lbl          { font-size:.8em; opacity:.6; min-width:72px; text-align:right; flex-shrink:0; }
        .smz-sc-hint-inline  { font-size:.78em; opacity:.5; }
        .smz-sc-prompt       { width:100%; }
        /* ── Status badge ─────────────────────────────────────────── */
        @keyframes smz-pulse { 0%,100%{background:rgba(200,55,55,.45);border-color:rgba(200,55,55,.7)} 50%{background:rgba(200,55,55,.1);border-color:rgba(200,55,55,.3)} }
        .smz-badge           { display:inline-flex; align-items:center; gap:4px; font-size:.72em; padding:2px 7px; border-radius:10px; border:1px solid var(--SmartThemeBorderColor,#444); white-space:nowrap; user-select:none; margin-top:3px; opacity:.85; transition:background .2s, border-color .2s, color .2s; }
        .smz-badge-unchanged { background:rgba(128,128,128,.1); color:var(--SmartThemeBodyColor,#ccc); opacity:.5; }
        .smz-badge-thinking  { animation:smz-pulse .7s ease-in-out infinite; color:#f99; }
        .smz-badge-modified  { background:rgba(50,180,80,.25); border-color:rgba(50,180,80,.5); color:#8f8; }
        .smz-check-row       { display:inline-flex; align-items:center; gap:5px; font-size:.8em; opacity:.65; cursor:pointer; }
        .smz-check-row input { width:auto !important; cursor:pointer; }
        .smz-kw-preview      { font-size:.78em; opacity:.7; margin-top:4px; line-height:1.7; padding:4px 7px; border-left:2px solid rgba(255,255,255,.15); }
        .smz-kw-preview em   { font-style:normal; opacity:.9; }
        .smz-prev-kw         { font-family:monospace; background:rgba(255,255,255,.08); border-radius:3px; padding:0 4px; }
        .smz-prev-re         { opacity:.45; font-family:monospace; font-size:.9em; }
        .smz-kw-footer       { display:flex; align-items:center; gap:8px; margin-top:3px; }
        .smz-help-toggle     { font-size:.75em; opacity:.45; cursor:pointer; border:1px solid currentColor; border-radius:50%; padding:0 4px; line-height:1.6; transition:opacity .15s; }
        .smz-help-toggle:hover, .smz-help-open { opacity:.9 !important; }
        .smz-help-text       { font-size:.78em; opacity:.65; margin-top:5px; line-height:1.6; padding:5px 7px; border-left:2px solid rgba(255,255,255,.12); }
        .smz-help-eg         { font-family:monospace; background:rgba(255,255,255,.08); border-radius:3px; padding:0 4px; }
        /* ── Pending-keyword highlight (sideCall in flight) ──────── */
        .smz-pending-kw      { background:rgba(255,200,50,.18); border-radius:2px; padding:0 1px; outline:1px solid rgba(255,200,50,.35); }
    </style>
</div>
</div>
</div>`);

    const s = getSettings();
    $('#smz_enabled').prop('checked', s.enabled);
    $('#smz_verbose').prop('checked', s.verbose);
    $('#smz_nonstreaming').prop('checked', s.nonStreaming);
    $('#smz_showbadges').prop('checked', s.showBadges);

    $('#smz_enabled').on('change', function () { getSettings().enabled = this.checked; saveSettingsDebounced(); });
    $('#smz_verbose').on('change', function () { getSettings().verbose = this.checked; saveSettingsDebounced(); });
    $('#smz_nonstreaming').on('change', function () { getSettings().nonStreaming = this.checked; saveSettingsDebounced(); });
    $('#smz_showbadges').on('change', function () {
        getSettings().showBadges = this.checked;
        saveSettingsDebounced();
        if (this.checked) reinjectAllBadges(); else removeAllBadges();
    });
    $('#smz_add_rule').on('click', () => {
        getSettings().rules.push({ id: makeId(), enabled: true, triggerLogic: 'any', triggers: [], actions: [] });
        saveSettingsDebounced();
        renderRules();
    });

    renderRules();
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

loadSettings();
eventSource.on(event_types.GENERATION_STARTED,          onGenerationStarted);
eventSource.on(event_types.STREAM_TOKEN_RECEIVED,        onStreamToken);
eventSource.on(event_types.MESSAGE_RECEIVED,             onMessageReceived);
eventSource.on(event_types.CHAT_CHANGED,                 reinjectAllBadges);
eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED,   (messageId) => ensureBadge(messageId));
addSettingsPanel();
