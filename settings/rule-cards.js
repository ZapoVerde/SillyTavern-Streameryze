/**
 * @file st-extensions/SillyTavern-Triggeryze/settings/rule-cards.js
 * @stamp {"utc":"2026-06-15T00:00:00.000Z"}
 * @architectural-role UI — rule card rendering and rule list assembly
 * @description
 * Renders the rule composer panel: each rule card (WHEN/DO sections, header controls),
 * ingredient rows (trigger and action config widgets), the add-ingredient picker, and
 * the clobber-conflict warning. Accepts a save callback so this module does not need
 * to import profiles.js, keeping the dependency graph acyclic.
 *
 * @api-declaration
 * renderRules(save) — empties and rebuilds the #trg_rules_list element; save is called by
 *                     any handler that mutates settings without doing a full re-render
 *
 * @contract
 *   assertions:
 *     purity:          none — reads extension_settings, writes DOM
 *     state_ownership: [_collapsedRules]
 *     external_io:     reinjectRuleBadges (engine), file download (downloadJson)
 */

import { extension_settings }                                          from '../../../../extensions.js';
import { TRIGGER_REGISTRY }                                            from '../triggers.js';
import { ACTION_REGISTRY, makeActionCtx }                              from '../actions/index.js';
import { reinjectRuleBadges }                                          from '../engine.js';

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

const _collapsedRules = new Set();

function detectClobbers(rule) {
    const warnings = [];
    const postActions = (rule.actions ?? []).filter(a => {
        const stage = ACTION_REGISTRY[a.type]?.stage;
        if (!stage) return false;
        return Array.isArray(stage) ? stage.includes('postMessage') : stage === 'postMessage';
    });

    const textSlots = new Map();
    for (const a of postActions) {
        if (a.type === 'sideCall' && (a.config?.outputMode ?? 'replaceKeyword') !== 'silent') {
            const mode = a.config?.outputMode ?? 'replaceKeyword';
            textSlots.set(mode, (textSlots.get(mode) ?? []).concat('call LLM'));
        }
        if (a.type === 'update' && (a.config?.target ?? 'lorebook') === 'text') {
            const mode = a.config?.mode ?? 'replaceKeyword';
            textSlots.set(mode, (textSlots.get(mode) ?? []).concat('update'));
        }
    }
    const modeLabels = { replaceKeyword: 'replace keyword', replaceParagraph: 'replace paragraph', appendToMessage: 'append to message', insertMessage: 'insert as message' };
    for (const [mode, writers] of textSlots) {
        if (writers.length > 1) {
            warnings.push(`Two actions write to the same location (${modeLabels[mode] ?? mode}). The last to run wins. This may be intentional.`);
        }
    }

    const lbSlots = new Map();
    for (const a of postActions) {
        if (a.type === 'update' && (a.config?.target ?? 'lorebook') === 'lorebook') {
            const title = (a.config?.title ?? '').trim().toLowerCase();
            if (title) lbSlots.set(title, (lbSlots.get(title) ?? 0) + 1);
        }
    }
    for (const [title, count] of lbSlots) {
        if (count > 1) {
            warnings.push(`Two actions update the same lorebook entry ("${title}"). The last to run wins. This may be intentional.`);
        }
    }

    return warnings;
}

function renderIngredient(item, registry, onConfigChange, onDelete, ctx = null) {
    const def   = registry[item.type];
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

function renderAddButton(label, registry, onPick) {
    const $wrap = $('<span class="trg-add-wrap">');
    const $btn  = $(`<button class="trg-add-btn">${label}</button>`);
    $btn.on('click', () => {
        if ($wrap.find('.trg-picker').length) return;
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

function renderRuleCard(rule, ruleIdx, save) {
    const s       = getSettings();
    const rebuild = () => { save(); renderRules(save); };

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
    <button class="trg-btn-icon trg-rule-clone" title="Clone rule"><i class="fa-solid fa-copy"></i></button>
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
    $hdr.find('.trg-rule-clone').on('click', () => {
        const clone = structuredClone(rule);
        clone.id   = makeId();
        clone.name = (clone.name || `Rule ${ruleIdx + 1}`) + ' (copy)';
        s.rules.splice(ruleIdx + 1, 0, clone);
        rebuild();
    });
    $hdr.find('.trg-rule-delete').on('click', () => { s.rules.splice(ruleIdx, 1); rebuild(); });
    $hdr.find('.trg-rule-collapse').on('click', () => {
        $card.toggleClass('trg-collapsed');
        if ($card.hasClass('trg-collapsed')) _collapsedRules.add(rule.id);
        else _collapsedRules.delete(rule.id);
    });
    $card.append($hdr);

    // ── Body ─────────────────────────────────────────────────────────────────
    const $body = $('<div class="trg-rule-body">');

    const $when    = $('<div class="trg-section">');
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
            (newConfig) => {
                rule.triggers[tidx].config = newConfig;
                save();
                if (trigger.type === 'badgeTrigger') reinjectRuleBadges();
            },
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

    const $do = $('<div class="trg-section">');
    $do.append('<div class="trg-section-label">DO:</div>');

    const $actions = $('<div class="trg-ingredient-list">');
    (rule.actions ?? []).forEach((action, aidx) => {
        const $row = renderIngredient(
            action,
            ACTION_REGISTRY,
            (newConfig) => { rule.actions[aidx].config = newConfig; save(); },
            () => { rule.actions.splice(aidx, 1); rebuild(); },
            makeActionCtx(rule, aidx)
        );
        $row.on('focusout', '.trg-outvar-field', () => rebuild());
        $actions.append($row);
    });
    $do.append($actions);
    const hasImageGen    = rule.actions.some(a => a.type === 'imageGen');
    const addableActions = hasImageGen
        ? Object.fromEntries(Object.entries(ACTION_REGISTRY).filter(([k]) => k !== 'imageGen'))
        : ACTION_REGISTRY;
    $do.append(renderAddButton('+ action', addableActions, (type) => {
        rule.actions.push({ type, config: structuredClone(ACTION_REGISTRY[type].defaultConfig) });
        rebuild();
    }));
    $body.append($do);

    const clobbers = detectClobbers(rule);
    if (clobbers.length) {
        const $warn = $('<div class="trg-clobber-warn">');
        for (const msg of clobbers) {
            $warn.append($(`<div><span class="trg-clobber-icon">&#9888;</span> ${msg}</div>`));
        }
        $body.append($warn);
    }

    $card.append($body);
    return $card;
}

export function renderRules(save) {
    const rules = getSettings().rules ?? [];
    const $list = $('#trg_rules_list').empty();
    if (!rules.length) {
        $list.append('<p class="trg-empty">No rules yet. Add one below.</p>');
        return;
    }
    rules.forEach((rule, i) => $list.append(renderRuleCard(rule, i, save)));
}
