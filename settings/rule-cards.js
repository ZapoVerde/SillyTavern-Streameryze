/**
 * @file st-extensions/SillyTavern-Triggeryze/settings/rule-cards.js
 * @stamp {"utc":"2026-06-16T00:00:00.000Z"}
 * @architectural-role UI — ruleset and rule card rendering
 * @description
 * Renders the rule composer panel: ruleset group cards (collapsible, enable/disable),
 * rule cards (WHEN/DO sections, header controls), ingredient rows (trigger and action
 * config widgets), and clobber-conflict warnings. Accepts a save callback so this module
 * does not need to import profiles.js, keeping the dependency graph acyclic.
 *
 * @api-declaration
 * renderRules(save) — empties and rebuilds #trg_rules_list with all ruleset cards;
 *                     save is called by any handler that mutates settings without a full re-render
 *
 * @contract
 *   assertions:
 *     purity:          none — reads extension_settings, writes DOM
 *     state_ownership: [_expandedRulesets, _expandedRules, _expandedIngredients]
 *     external_io:     reinjectRuleBadges (engine), file download (downloadJson)
 */

import { getSettings, makeId }                                             from './storage.js';
import { exportRule, exportRuleset }                                       from './format.js';
import { TRIGGER_REGISTRY }                                                from '../triggers.js';
import { ACTION_REGISTRY, makeActionCtx }                                  from '../actions/index.js';
import { reinjectRuleBadges }                                              from '../engine.js';

function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

const _expandedRulesets    = new Set();
const _expandedRules       = new Set();
const _expandedIngredients = new Set();

// Active drag state — set in dragstart, cleared in dragend
let _dragging = null; // { ruleId, rulesetId } | null

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

function summarizeIngredient(item) {
    const cfg = item.config ?? {};
    if (item.type === 'keywordMatch') {
        const kws = (cfg.keywords ?? '').split(',').map(k => k.trim()).filter(Boolean);
        return kws.join(', ');
    }
    if (item.type === 'regex')        return cfg.pattern ? `/${cfg.pattern}/` : '';
    if (item.type === 'badgeTrigger') return cfg.label ?? '';
    if (item.type === 'inlineBadge') {
        const kws = (cfg.keywords ?? '').split(',').map(k => k.trim()).filter(Boolean);
        return kws.join(', ');
    }
    if (item.type === 'varMatch') {
        const _noVal = ['notEmpty', 'set', 'notSet'];
        const opSym  = { equals: '=', notEquals: '≠', contains: '∋', matches: '~', notEmpty: '≠ ""', set: 'set', notSet: '!set' }[cfg.operator] ?? cfg.operator ?? '=';
        const val    = _noVal.includes(cfg.operator) ? '' : (cfg.value ?? '');
        return cfg.varName ? `${cfg.varName} ${opSym}${val ? ' ' + val : ''}` : '';
    }
    if (item.type === 'sideCall') {
        const short = { replaceKeyword: 'replace kw', replaceParagraph: 'replace ¶', appendToMessage: 'append', insertMessage: 'insert', silent: 'silent' };
        const mode  = short[cfg.outputMode ?? 'replaceKeyword'] ?? cfg.outputMode ?? '';
        return cfg.outputVar ? `${mode} → ${cfg.outputVar}` : mode;
    }
    if (item.type === 'imageGen')  return cfg.model ? `${cfg.source ?? 'pollinations'} / ${cfg.model}` : (cfg.source ?? '');
    if (item.type === 'replace')   { const r = (cfg.replacement ?? '').trim(); return r.length > 32 ? r.slice(0, 32) + '…' : r; }
    if (item.type === 'slashCmd')  return (cfg.command ?? '').trim().slice(0, 36);
    if (item.type === 'update') {
        const t = cfg.target ?? 'lorebook';
        return cfg.title ? `${t}: ${cfg.title}` : t;
    }
    if (item.type === 'compose')   return cfg.outputVar ? `→ ${cfg.outputVar}` : '';
    return '';
}

function renderIngredient(item, registry, onConfigChange, onDelete, ctx = null, ingredientKey = null) {
    const def         = registry[item.type];
    const label       = def?.label ?? item.type;
    const summary     = summarizeIngredient(item);
    const isCollapsed = ingredientKey ? !_expandedIngredients.has(ingredientKey) : false;

    const $card = $(`<div class="trg-ingredient${isCollapsed ? ' trg-ingredient-collapsed' : ''}">`);

    const $hdr = $(`
<div class="trg-ingredient-hdr">
    <button class="trg-btn-icon trg-ingredient-collapse" title="Toggle"><i class="fa-solid fa-chevron-down"></i></button>
    <span class="trg-ingredient-title">${label}</span>
    <span class="trg-ingredient-summary">${summary}</span>
    <button class="trg-btn-icon trg-ingredient-delete" title="Remove">✕</button>
</div>`);

    const $body   = $('<div class="trg-ingredient-body">');
    const $config = $('<div class="trg-ingredient-config">');
    if (def?.renderConfig) {
        def.renderConfig($config, item.config ?? {}, onConfigChange, ctx);
    }
    $body.append($config);
    $card.append($hdr, $body);

    $hdr.find('.trg-ingredient-collapse').on('click', () => {
        $card.toggleClass('trg-ingredient-collapsed');
        if (ingredientKey) {
            if ($card.hasClass('trg-ingredient-collapsed')) _expandedIngredients.delete(ingredientKey);
            else _expandedIngredients.add(ingredientKey);
        }
    });
    $hdr.find('.trg-ingredient-delete').on('click', onDelete);
    return $card;
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

function renderRuleCard(rule, ruleIdx, rsRules, allRules, save, rulesetId) {
    const s       = getSettings();
    const rebuild = () => { save(); renderRules(save); };

    const $card = $(`<div class="trg-rule-card${_expandedRules.has(rule.id) ? '' : ' trg-collapsed'}" data-rule-id="${rule.id}">`);

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
    <span class="trg-drag-handle" title="Drag to reorder">⠿</span>
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
        downloadJson(`triggeryze-${label}.json`, exportRule(structuredClone(rule)));
    });
    $hdr.find('.trg-rule-dev').on('click', function () { rule.devMode = !rule.devMode; $(this).toggleClass('trg-dev-on'); save(); });
    $hdr.find('.trg-rule-clone').on('click', () => {
        const clone = structuredClone(rule);
        clone.id   = makeId();
        clone.name = (clone.name || `Rule ${ruleIdx + 1}`) + ' (copy)';
        rsRules.splice(ruleIdx + 1, 0, clone);
        rebuild();
    });
    $hdr.find('.trg-rule-delete').on('click', () => { rsRules.splice(ruleIdx, 1); rebuild(); });
    $hdr.find('.trg-rule-collapse').on('click', () => {
        $card.toggleClass('trg-collapsed');
        if ($card.hasClass('trg-collapsed')) _expandedRules.delete(rule.id);
        else _expandedRules.add(rule.id);
    });
    $card.append($hdr);

    // ── Drag-and-drop ────────────────────────────────────────────────────────
    // Only become draggable while the mouse is down on the handle
    $card.on('mousedown', '.trg-drag-handle', () => $card.attr('draggable', 'true'));
    $card.on('mouseup',   '.trg-drag-handle', () => $card.removeAttr('draggable'));

    $card.on('dragstart', e => {
        if (!$card.attr('draggable')) { e.preventDefault(); return; }
        _dragging = { ruleId: rule.id, rulesetId };
        e.originalEvent.dataTransfer.effectAllowed = 'move';
        e.originalEvent.dataTransfer.setData('text/plain', JSON.stringify(_dragging));
        setTimeout(() => $card.addClass('trg-drag-source'), 0);
    });

    $card.on('dragend', () => {
        _dragging = null;
        $card.removeAttr('draggable').removeClass('trg-drag-source trg-drag-above trg-drag-below');
    });

    $card.on('dragover', e => {
        if (!_dragging) return;
        e.preventDefault();
        e.originalEvent.dataTransfer.dropEffect = 'move';
        const rect   = $card[0].getBoundingClientRect();
        const isAbove = e.originalEvent.clientY < rect.top + rect.height / 2;
        $card.toggleClass('trg-drag-above', isAbove).toggleClass('trg-drag-below', !isAbove);
    });

    $card.on('dragleave', e => {
        if (!$card[0].contains(e.originalEvent.relatedTarget)) {
            $card.removeClass('trg-drag-above trg-drag-below');
        }
    });

    $card.on('drop', e => {
        e.preventDefault();
        e.stopPropagation();
        $card.removeClass('trg-drag-above trg-drag-below');

        const raw = e.originalEvent.dataTransfer.getData('text/plain');
        if (!raw) return;
        let src;
        try { src = JSON.parse(raw); } catch { return; }
        if (!src.ruleId) return;

        const rect    = $card[0].getBoundingClientRect();
        const isAbove = e.originalEvent.clientY < rect.top + rect.height / 2;

        const s     = getSettings();
        const srcRs = s.rulesets.find(rs => rs.id === src.rulesetId);
        if (!srcRs) return;
        const srcIdx = srcRs.rules.findIndex(r => r.id === src.ruleId);
        if (srcIdx === -1) return;
        const [moved] = srcRs.rules.splice(srcIdx, 1);

        const dstRs = s.rulesets.find(rs => rs.id === rulesetId);
        if (!dstRs) { srcRs.rules.splice(srcIdx, 0, moved); return; }

        const dstIdx = dstRs.rules.findIndex(r => r.id === rule.id);
        const insertAt = dstIdx === -1 ? dstRs.rules.length
            : (isAbove ? dstIdx : dstIdx + 1);
        // If same ruleset and moving downward, the splice above shifted indices
        dstRs.rules.splice(insertAt, 0, moved);
        rebuild();
    });

    // ── Body ─────────────────────────────────────────────────────────────────
    const $body = $('<div class="trg-rule-body">');

    const $when    = $('<div class="trg-section">');
    const $whenHdr = $(`
<div class="trg-section-label">
    WHEN <select class="trg-logic-select">
        <option value="any" ${rule.when !== 'all' ? 'selected' : ''}>any</option>
        <option value="all" ${rule.when === 'all' ? 'selected' : ''}>all</option>
    </select> of:
</div>`);
    $whenHdr.find('.trg-logic-select').on('change', function () { rule.when = this.value; rebuild(); });
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
            () => { rule.triggers.splice(tidx, 1); rebuild(); },
            null,
            `${rule.id}:t:${tidx}`
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
            makeActionCtx(rule, aidx, allRules),
            `${rule.id}:a:${aidx}`
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

function renderRulesetCard(ruleset, rsIdx, allRules, save) {
    const s       = getSettings();
    const rebuild = () => { save(); renderRules(save); };
    const isExpanded = _expandedRulesets.has(ruleset.id);

    const $card = $(`<div class="trg-ruleset-card" data-ruleset-id="${ruleset.id}">`);

    const $hdr = $(`
<div class="trg-ruleset-header">
    <button class="trg-btn-icon trg-rs-collapse" title="Collapse"><i class="fa-solid fa-chevron-${isExpanded ? 'down' : 'right'}"></i></button>
    <input type="checkbox" class="trg-rs-toggle" ${ruleset.enabled !== false ? 'checked' : ''} title="Enable ruleset" />
    <input type="text" class="trg-rs-name" placeholder="Group ${rsIdx + 1}" value="${(ruleset.name ?? '').replace(/"/g, '&quot;')}" />
    <button class="trg-btn-icon trg-rs-export" title="Export ruleset as JSON"><i class="fa-solid fa-file-export"></i></button>
    <button class="trg-btn-icon trg-rs-delete" title="Delete ruleset">✕</button>
</div>`);

    $hdr.find('.trg-rs-toggle').on('change', function () { ruleset.enabled = this.checked; rebuild(); });
    $hdr.find('.trg-rs-name').on('input', function () { ruleset.name = this.value; save(); });
    $hdr.find('.trg-rs-export').on('click', () => {
        const label = (ruleset.name || `group-${rsIdx + 1}`).replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
        downloadJson(`triggeryze-${label}.json`, exportRuleset(structuredClone(ruleset)));
    });
    $hdr.find('.trg-rs-delete').on('click', () => {
        if (s.rulesets.length === 1) {
            toastr.warning('Cannot delete the last ruleset.', 'Triggeryze');
            return;
        }
        s.rulesets.splice(rsIdx, 1);
        rebuild();
    });
    $hdr.find('.trg-rs-collapse').on('click', () => {
        const nowExpanded = _expandedRulesets.has(ruleset.id);
        if (nowExpanded) _expandedRulesets.delete(ruleset.id);
        else             _expandedRulesets.add(ruleset.id);
        rebuild();
    });
    $card.append($hdr);

    if (isExpanded) {
        const $body = $('<div class="trg-ruleset-body">');
        (ruleset.rules ?? []).forEach((rule, ruleIdx) => {
            $body.append(renderRuleCard(rule, ruleIdx, ruleset.rules, allRules, save, ruleset.id));
        });

        // Drop into empty space within this body (appends to end of ruleset)
        $body.on('dragover', e => {
            if (!_dragging || $(e.target).closest('.trg-rule-card').length) return;
            e.preventDefault();
            e.originalEvent.dataTransfer.dropEffect = 'move';
            $body.addClass('trg-drag-target');
        });
        $body.on('dragleave', e => {
            if (!$body[0].contains(e.originalEvent.relatedTarget)) {
                $body.removeClass('trg-drag-target');
            }
        });
        $body.on('drop', e => {
            if ($(e.target).closest('.trg-rule-card').length) return; // card handler took it
            e.preventDefault();
            e.stopPropagation();
            $body.removeClass('trg-drag-target');

            const raw = e.originalEvent.dataTransfer.getData('text/plain');
            if (!raw) return;
            let src;
            try { src = JSON.parse(raw); } catch { return; }
            if (!src.ruleId) return;

            const s     = getSettings();
            const srcRs = s.rulesets.find(rs => rs.id === src.rulesetId);
            if (!srcRs) return;
            const srcIdx = srcRs.rules.findIndex(r => r.id === src.ruleId);
            if (srcIdx === -1) return;
            const [moved] = srcRs.rules.splice(srcIdx, 1);

            const dstRs = s.rulesets.find(rs => rs.id === ruleset.id);
            if (!dstRs) { srcRs.rules.splice(srcIdx, 0, moved); return; }
            dstRs.rules.push(moved);
            rebuild();
        });
        const $addRule = $('<button class="trg-add-btn trg-rs-add-rule">+ rule</button>');
        $addRule.on('click', () => {
            ruleset.rules.push({ id: makeId(), enabled: true, when: 'any', triggers: [], actions: [] });
            rebuild();
        });
        $body.append($addRule);
        $card.append($body);
    }

    return $card;
}

export function renderRules(save) {
    const s        = getSettings();
    const rulesets = s.rulesets ?? [];
    const allRules = rulesets.flatMap(rs => rs.rules ?? []);
    const $list    = $('#trg_rules_list').empty();

    if (!rulesets.length) {
        $list.append('<p class="trg-empty">No groups yet. Add one below.</p>');
        return;
    }
    rulesets.forEach((rs, i) => $list.append(renderRulesetCard(rs, i, allRules, save)));
}
