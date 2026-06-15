/**
 * @file st-extensions/SillyTavern-Triggeryze/index.js
 * @stamp {"utc":"2026-06-15T00:00:00.000Z"}
 * @architectural-role Orchestrator — extension entry point, settings load/migrate, event wiring
 * @description
 * Owns settings initialisation, migration, and the settings panel shell. The settings panel
 * is a rule composer: users build rules from trigger ingredients (WHEN) and action ingredients
 * (DO). Rule rendering is delegated to settings/rule-cards.js; profile management to
 * settings/profiles.js.
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
 * loadSettings()  — initialises and migrates extension_settings.triggeryze
 * getSettings()   — returns the live settings object
 *
 * @contract
 *   assertions:
 *     purity:          none — owns settings state and wires DOM events
 *     state_ownership: [extension_settings.triggeryze]
 *     external_io:     eventSource (event wiring only)
 */

import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings }                                          from '../../../extensions.js';
import { onGenerationStarted, onStreamToken, onMessageReceived, fireRuleManually, reinjectRuleBadges } from './engine.js';
import { ensureBadge, setBadge, reinjectAllBadges, removeAllBadges }   from './badge.js';
import { refreshProfileDropdown, bindProfileHandlers, updateProfileDirtyIndicator } from './settings/profiles.js';
import { renderRules }                                                  from './settings/rule-cards.js';

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

function makeId() { return Math.random().toString(36).slice(2, 9); }

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
    if (!s.profiles[s.currentProfileName]) {
        s.currentProfileName = Object.keys(s.profiles)[0];
    }

    migrateSettings(s);
}

function migrateSettings(s) {
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
    for (const profile of Object.values(s.profiles ?? {})) {
        migrateRules(profile.rules);
    }
    if (migrated > 0) {
        console.log(`[triggeryze] migrated ${migrated} lbWrite action(s) to update`);
        saveSettingsDebounced();
    }
}

export function getSettings() { return extension_settings[EXT_NAME]; }

// ---------------------------------------------------------------------------
// Settings panel
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
</div>
</div>
</div>`);

    const s    = getSettings();
    const save = () => { saveSettingsDebounced(); updateProfileDirtyIndicator(); };

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
        save();
        renderRules(save);
    });

    refreshProfileDropdown();
    bindProfileHandlers(() => renderRules(save));
    renderRules(save);
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

// mousedown fires before focus shifts to the button, preserving the selection
let _badgeHighlight = '';
$(document).on('mousedown touchstart', '.trg-rule-badge', function () {
    _badgeHighlight = window.getSelection()?.toString().trim() ?? '';
});
$(document).on('click', '.trg-rule-badge', async function () {
    const ruleId      = $(this).data('rule-id');
    const messageId   = parseInt($(this).data('mesid'), 10);
    const highlighted = _badgeHighlight;
    _badgeHighlight   = '';
    if (!ruleId || isNaN(messageId)) return;
    await fireRuleManually(ruleId, messageId, highlighted);
});
addSettingsPanel();
