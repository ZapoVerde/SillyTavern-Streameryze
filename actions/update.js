/**
 * @file st-extensions/SillyTavern-Triggeryze/actions/update.js
 * @stamp {"utc":"2026-07-01T00:00:00.000Z"}
 * @architectural-role Registry — update action (lorebook entry write or message text mutation)
 * @description
 * Dual-target action: writes or updates a lorebook entry (create if absent, update content
 * and merge keys if present), or mutates message text via replaceKeyword / replaceParagraph /
 * prependToMessage / appendToMessage / replaceMessage / insertMessage modes. Both targets
 * support {{variable}} interpolation.
 *
 * @api-declaration
 * update — action definition object for the ACTION_REGISTRY; preview(config, text) resolves the
 *   lorebook or value fields against sample text and reports create-vs-update for the lorebook
 *   target, without writing the lorebook or mutating any message
 *
 * @contract
 *   assertions:
 *     purity:          none — writes lorebooks, writes msg.mes, calls saveChat
 *     state_ownership: none
 *     external_io:     lbGetLorebook, lbSaveLorebook, clearWiCache, stCtx.saveChat; text mutations delegated to text-ops
 */

import { name1, name2 } from '../../../../../script.js';
import { interpolate, resolveLbTokens } from './template.js';
import { esc, extractParagraph } from './text.js';
import { makeSave, applyReplaceKeyword, applyReplaceParagraph, applyPrepend, applyAppend, applyReplaceMessage, applyInsertMessage } from './text-ops.js';
import { renderVarLegend } from './var-legend.js';
import { clearWiCache, getLbNames } from '../triggers/lb-query.js';
import { trgError, trgDev } from '../logger.js';
import { lbGetLorebook, lbSaveLorebook } from '../lorebookApi.js';
import { testDrawerHtml, attachTestDrawer } from '../triggers/test-drawer.js';
import { getTurnVarsSnapshot } from '../triggers/turn-vars.js';

const _MODE_HINTS = {
    replaceKeyword:   'Replaces every occurrence of the keyword in the current message.',
    replaceParagraph: 'Replaces the paragraph(s) containing a keyword match.',
    prependToMessage: 'Inserts the value before the current message text.',
    appendToMessage:  'Appends the value after the current message text.',
    replaceMessage:   'Overwrites the entire current message with the value.',
    insertMessage:    'Creates a new AI chat bubble immediately after this one. No LLM call — the value is posted directly as a separate message.',
};

/** Builds a complete ST worldinfo entry object for a new lorebook entry. */
function makeLbEntry(uid, comment, keys, content) {
    return {
        uid, comment, content,
        key:              keys,
        keysecondary:     [],
        constant:         false,
        vectorized:       false,
        selective:        true,
        selectiveLogic:   0,
        addMemo:          true,
        order:            100,
        position:         0,
        disable:          false,
        ignoreBudget:     false,
        excludeRecursion: false,
        preventRecursion: false,
        probability:      100,
        useProbability:   true,
        depth:            4,
        group:            '',
        groupOverride:    false,
        groupWeight:      100,
        scanDepth:        null,
        caseSensitive:    null,
        matchWholeWords:  null,
        useGroupScoring:  null,
        automationId:     '',
        role:             0,
        sticky:           null,
        cooldown:         null,
        delay:            null,
        displayIndex:     uid,
        triggers:         [],
    };
}

// Resolves the lorebook target's fields against the given text — shared by execute() and preview().
async function resolveLorebook(config, { matchedKeyword, highlighted, text, vars, messageId }) {
    const kwEsc      = (matchedKeyword ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const firstMatch = kwEsc ? new RegExp(kwEsc, 'i').exec(text) : null;
    const upTo       = firstMatch ? text.slice(0, firstMatch.index) : '';
    const paragraph  = firstMatch ? extractParagraph(text, firstMatch.index).text : '';
    const interp = (t) => interpolate(t, {
        keyword: matchedKeyword ?? '', message: text,
        'up-to': upTo, paragraph, char: name2 ?? '', user: name1 ?? '',
    }, vars ?? {});

    const [rLorebook, rTitle, rKeys, rContent] = await Promise.all([
        resolveLbTokens(config.lorebook ?? '', matchedKeyword, highlighted, vars, messageId),
        resolveLbTokens(config.title    ?? '', matchedKeyword, highlighted, vars, messageId),
        resolveLbTokens(config.keys     ?? '', matchedKeyword, highlighted, vars, messageId),
        resolveLbTokens(config.content  ?? '', matchedKeyword, highlighted, vars, messageId),
    ]);

    return {
        lorebook: interp(rLorebook).trim(),
        title:    interp(rTitle).trim(),
        keys:     interp(rKeys).split(',').map(k => k.trim()).filter(Boolean),
        content:  interp(rContent),
    };
}

// Resolves the text target's value against the given text — shared by execute() and preview().
async function resolveText(config, { matchedKeyword, highlighted, text, vars, messageId }) {
    const kwEsc      = (matchedKeyword ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const mkRe       = () => new RegExp(kwEsc, 'gi');
    const firstMatch = kwEsc ? mkRe().exec(text) : null;
    const upTo       = firstMatch ? text.slice(0, firstMatch.index) : '';
    const paragraph  = firstMatch ? extractParagraph(text, firstMatch.index).text : '';

    const resolvedValue = await resolveLbTokens(config.value ?? '', matchedKeyword, highlighted, vars, messageId);
    const value = interpolate(resolvedValue, {
        keyword:   matchedKeyword ?? '',
        message:   text,
        'up-to':   upTo,
        paragraph,
        char:      name2 ?? '',
        user:      name1 ?? '',
    }, vars ?? {});

    return { mode: config.mode ?? 'replaceKeyword', value, mkRe };
}

export const update = {
    label: 'update',
    templateFields: cfg => cfg?.target === 'text'
        ? [cfg.value]
        : [cfg?.lorebook, cfg?.title, cfg?.keys, cfg?.content],
    defaultConfig: { target: 'lorebook', lorebook: '', title: '', keys: '', content: '', outputVar: '', mode: 'replaceKeyword', value: '' },

    async execute(config, { matchedKeyword, messageId, stCtx, vars, debug, highlighted = '', isCurrentGeneration, ruleName }) {
        const target = config.target ?? 'lorebook';

        // ── Lorebook target ───────────────────────────────────────────────
        if (target === 'lorebook') {
            const text = stCtx?.chat?.[messageId]?.mes ?? '';
            const { lorebook, title, keys, content } = await resolveLorebook(config, { matchedKeyword, highlighted, text, vars, messageId });

            if (!lorebook || !title) {
                trgError(`update (lorebook): lorebook and title are required (rule: ${ruleName})`);
                return;
            }

            const lbData  = await lbGetLorebook(lorebook);
            const entries = lbData.entries ?? {};
            const existingUid = Object.keys(entries).find(
                uid => (entries[uid].comment ?? '').toLowerCase() === title.toLowerCase()
            );

            if (existingUid !== undefined) {
                entries[existingUid].content = content;
                if (keys.length) {
                    const seen = new Set((entries[existingUid].key ?? []).map(k => k.toLowerCase()));
                    for (const k of keys) {
                        if (!seen.has(k.toLowerCase())) entries[existingUid].key.push(k);
                    }
                }
                trgDev(debug, `  update: updated "${title}" in "${lorebook}"`);
            } else {
                const uid = Object.keys(entries).length
                    ? Math.max(...Object.keys(entries).map(Number)) + 1
                    : 0;
                entries[String(uid)] = makeLbEntry(uid, title, keys, content);
                trgDev(debug, `  update: created "${title}" in "${lorebook}" (uid ${uid})`);
            }

            lbData.entries = entries;
            await lbSaveLorebook(lorebook, lbData);
            clearWiCache();
            if (config.outputVar && vars) vars[config.outputVar] = title;
            return;
        }

        // ── Text target ───────────────────────────────────────────────────
        const msg = stCtx?.chat?.[messageId];
        if (!msg) return;

        const { mode, value, mkRe } = await resolveText(config, { matchedKeyword, highlighted, text: msg.mes, vars, messageId });
        const save = makeSave(isCurrentGeneration, messageId, msg, stCtx);

        if (mode === 'replaceKeyword') {
            const updated = applyReplaceKeyword(msg.mes, mkRe, value);
            if (updated === msg.mes) return;
            msg.mes = updated;
            try { await save(); } catch (err) { trgError(`update text replaceKeyword: save failed (rule: ${ruleName})`, err); }
        } else if (mode === 'replaceParagraph') {
            const built = applyReplaceParagraph(msg.mes, mkRe, value);
            if (built === null) return;
            msg.mes = built;
            try { await save(); } catch (err) { trgError(`update text replaceParagraph: save failed (rule: ${ruleName})`, err); }
        } else if (mode === 'prependToMessage') {
            msg.mes = applyPrepend(msg.mes, value);
            try { await save(); } catch (err) { trgError(`update text prependToMessage: save failed (rule: ${ruleName})`, err); }
        } else if (mode === 'appendToMessage') {
            msg.mes = applyAppend(msg.mes, value);
            try { await save(); } catch (err) { trgError(`update text appendToMessage: save failed (rule: ${ruleName})`, err); }
        } else if (mode === 'replaceMessage') {
            msg.mes = applyReplaceMessage(msg.mes, value);
            try { await save(); } catch (err) { trgError(`update text replaceMessage: save failed (rule: ${ruleName})`, err); }
        } else if (mode === 'insertMessage') {
            try { await applyInsertMessage(stCtx, messageId, value, name2 ?? ''); }
            catch (err) { trgError(`update text insertMessage: failed (rule: ${ruleName})`, err); }
        }
    },

    async preview(config, text) {
        const target = config.target ?? 'lorebook';
        const previewCtx = { matchedKeyword: '', highlighted: '', text, vars: getTurnVarsSnapshot(), messageId: null };

        if (target === 'lorebook') {
            const { lorebook, title, keys, content } = await resolveLorebook(config, previewCtx);
            if (!lorebook || !title) return { hint: 'Lorebook and title are required.' };

            const lbData  = await lbGetLorebook(lorebook).catch(() => null);
            const entries = lbData?.entries ?? {};
            const exists  = Object.values(entries).some(e => (e.comment ?? '').toLowerCase() === title.toLowerCase());
            const keysNote = keys.length ? ` (keys: ${keys.join(', ')})` : '';
            return { output: `Would ${exists ? 'update' : 'create'} "${title}" in "${lorebook}"${keysNote}:\n${content}` };
        }

        const { mode, value } = await resolveText(config, previewCtx);
        return { output: `Would ${mode}:\n${value}` };
    },

    renderConfig($el, config, onChange, ctx) {
        const target = config.target ?? 'lorebook';
        const s = (val, want) => val === want ? ' selected' : '';
        const listId = 'trg-lb-names-' + Math.random().toString(36).slice(2, 8);
        const lbOptions = getLbNames().map(n => `<option value="${esc(n)}"></option>`).join('');

        $el.html(`
<div class="trg-sc-wrap">
    <div class="trg-sc-row">
        <label class="trg-sc-lbl">target</label>
        <select class="trg-cfg trg-up-target">
            <option value="lorebook" ${s(target, 'lorebook')}>lorebook entry</option>
            <option value="text"     ${s(target, 'text'    )}>message text</option>
        </select>
    </div>
    <div class="trg-up-lorebook-fields" ${target !== 'lorebook' ? 'style="display:none"' : ''}>
        <div class="trg-sc-row">
            <label class="trg-sc-lbl">lorebook</label>
            <input type="text" class="text_pole trg-cfg trg-up-lorebook" list="${listId}" placeholder="lorebook name" value="${esc(config.lorebook ?? '')}" style="flex:1" />
            <datalist id="${listId}">${lbOptions}</datalist>
        </div>
        <div class="trg-sc-row">
            <label class="trg-sc-lbl">title</label>
            <input type="text" class="text_pole trg-cfg trg-up-title" placeholder="entry title — {{keyword}}, {{myVar}}, ..." value="${esc(config.title ?? '')}" style="flex:1" />
        </div>
        <div class="trg-sc-row">
            <label class="trg-sc-lbl">keys</label>
            <input type="text" class="text_pole trg-cfg trg-up-keys" placeholder="comma-separated trigger keys (optional)" value="${esc(config.keys ?? '')}" style="flex:1" />
        </div>
        <div class="trg-sc-row">
            <label class="trg-sc-lbl">save as</label>
            <input type="text" class="trg-cfg trg-up-outvar trg-outvar-field" placeholder="variable name (optional)" value="${esc(config.outputVar ?? '')}" style="flex:1" />
        </div>
        ${renderVarLegend(ctx?.priorActions, ctx?.crossRuleVars, ctx?.globalVars)}
        <textarea class="text_pole trg-cfg trg-up-content" rows="5"
            placeholder="Entry content — {{keyword}} {{message}} {{myVar}} {{getLBcontent [Entry Name]}}">${esc(config.content ?? '')}</textarea>
        <small class="trg-hint">Updates the entry if the title exists; creates it otherwise. Keys are merged on update, not replaced.</small>
    </div>
    <div class="trg-up-text-fields" ${target !== 'text' ? 'style="display:none"' : ''}>
        <div class="trg-sc-row">
            <label class="trg-sc-lbl">mode</label>
            <select class="trg-cfg trg-up-mode">
                <option value="replaceKeyword"   ${s(config.mode, 'replaceKeyword'  )}>replace keyword</option>
                <option value="replaceParagraph" ${s(config.mode, 'replaceParagraph')}>replace paragraph</option>
                <option value="prependToMessage" ${s(config.mode, 'prependToMessage')}>prepend to message</option>
                <option value="appendToMessage"  ${s(config.mode, 'appendToMessage' )}>append to message</option>
                <option value="replaceMessage"   ${s(config.mode, 'replaceMessage'  )}>replace message</option>
                <option value="insertMessage"    ${s(config.mode, 'insertMessage'   )}>insert as new message</option>
            </select>
        </div>
        <small class="trg-up-mode-hint trg-hint" style="display:none"></small>
        ${renderVarLegend(ctx?.priorActions, ctx?.crossRuleVars, ctx?.globalVars)}
        <textarea class="text_pole trg-cfg trg-up-value" rows="3"
            placeholder="Value — {{keyword}} {{highlighted}} {{paragraph}} {{message}} {{myVar}}">${esc(config.value ?? '')}</textarea>
    </div>
    ${testDrawerHtml()}
</div>`);

        const readConfig = () => ({
            target:    $el.find('.trg-up-target').val() ?? 'lorebook',
            lorebook:  $el.find('.trg-up-lorebook').val().trim(),
            title:     $el.find('.trg-up-title').val(),
            keys:      $el.find('.trg-up-keys').val(),
            content:   $el.find('.trg-up-content').val(),
            outputVar: $el.find('.trg-up-outvar').val().trim(),
            mode:      $el.find('.trg-up-mode').val() ?? 'replaceKeyword',
            value:     $el.find('.trg-up-value').val(),
        });

        const refreshTestDrawer = attachTestDrawer($el, readConfig, (cfg, text) => update.preview(cfg, text));

        $el.find('.trg-up-target').on('change', function () {
            const t = $(this).val();
            $el.find('.trg-up-lorebook-fields').toggle(t === 'lorebook');
            $el.find('.trg-up-text-fields').toggle(t === 'text');
            onChange(readConfig());
            refreshTestDrawer();
        });

        $el.find('.trg-up-lorebook, .trg-up-title, .trg-up-keys, .trg-up-content, .trg-up-outvar').on('input', () => { onChange(readConfig()); refreshTestDrawer(); });
        const $modeHint = $el.find('.trg-up-mode-hint');
        const updateModeHint = mode => {
            const text = _MODE_HINTS[mode] ?? '';
            $modeHint.text(text).toggle(!!text);
        };
        updateModeHint(config.mode ?? 'replaceKeyword');
        $el.find('.trg-up-mode').on('change', function () { updateModeHint($(this).val()); onChange(readConfig()); refreshTestDrawer(); });
        $el.find('.trg-up-value').on('input', () => { onChange(readConfig()); refreshTestDrawer(); });

        $el.on('click', '.trg-var-inject', function () {
            const token = $(this).data('token');
            const $ta   = $el.find('.trg-up-content:visible, .trg-up-value:visible').first();
            const el    = $ta[0];
            if (!el) return;
            const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? s;
            el.value = el.value.slice(0, s) + token + el.value.slice(e);
            el.selectionStart = el.selectionEnd = s + token.length;
            $ta.trigger('input');
            el.focus();
        });
    },
};
