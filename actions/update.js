/**
 * @file st-extensions/SillyTavern-Triggeryze/actions/update.js
 * @stamp {"utc":"2026-06-15T00:00:00.000Z"}
 * @architectural-role Registry — update action (lorebook entry write or message text mutation)
 * @description
 * Dual-target action: writes or updates a lorebook entry (create if absent, update content
 * and merge keys if present), or mutates message text via replaceKeyword / replaceParagraph /
 * appendToMessage / insertMessage modes. Both targets support {{variable}} interpolation.
 *
 * @api-declaration
 * update — action definition object for the ACTION_REGISTRY
 *
 * @contract
 *   assertions:
 *     purity:          none — writes lorebooks, writes msg.mes, calls saveChat
 *     state_ownership: none
 *     external_io:     lbGetLorebook, lbSaveLorebook, clearWiCache, updateMessageBlock, addOneMessage, eventSource, stCtx.saveChat
 */

import { eventSource, event_types, name1, name2, addOneMessage, updateMessageBlock } from '../../../../../script.js';
import { interpolate, resolveLbTokens } from './template.js';
import { esc, extractParagraph, collectUniqueParagraphs } from './text.js';
import { renderVarLegend } from './var-legend.js';
import { clearWiCache } from '../triggers/lb-query.js';
import { lbGetLorebook, lbSaveLorebook } from '../lorebookApi.js';

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

export const update = {
    label: 'update',
    stage: 'postMessage',
    templateFields: cfg => cfg?.target === 'text'
        ? [cfg.value]
        : [cfg?.lorebook, cfg?.title, cfg?.keys, cfg?.content],
    defaultConfig: { target: 'lorebook', lorebook: '', title: '', keys: '', content: '', outputVar: '', mode: 'replaceKeyword', value: '' },

    async execute(config, { matchedKeyword, messageId, stCtx, vars, debug, highlighted = '', isCurrentGeneration }) {
        const target = config.target ?? 'lorebook';

        // ── Lorebook target ───────────────────────────────────────────────
        if (target === 'lorebook') {
            const msg  = stCtx?.chat?.[messageId];
            const text = msg?.mes ?? '';
            const kwEsc      = (matchedKeyword ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const firstMatch = kwEsc ? new RegExp(kwEsc, 'i').exec(text) : null;
            const upTo       = firstMatch ? text.slice(0, firstMatch.index) : '';
            const paragraph  = firstMatch ? extractParagraph(text, firstMatch.index).text : '';
            const interp = (t) => interpolate(t, {
                keyword: matchedKeyword ?? '', message: text,
                'up-to': upTo, paragraph, char: name2 ?? '', user: name1 ?? '',
            }, vars);

            const [rLorebook, rTitle, rKeys, rContent] = await Promise.all([
                resolveLbTokens(config.lorebook ?? '', matchedKeyword, highlighted, vars, messageId),
                resolveLbTokens(config.title    ?? '', matchedKeyword, highlighted, vars, messageId),
                resolveLbTokens(config.keys     ?? '', matchedKeyword, highlighted, vars, messageId),
                resolveLbTokens(config.content  ?? '', matchedKeyword, highlighted, vars, messageId),
            ]);

            const lorebook = interp(rLorebook).trim();
            const title    = interp(rTitle).trim();
            const keys     = interp(rKeys).split(',').map(k => k.trim()).filter(Boolean);
            const content  = interp(rContent);

            if (!lorebook || !title) {
                console.error('[triggeryze] update (lorebook): lorebook and title are required');
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
                if (debug) console.log(`[TRG:dev]   update: updated "${title}" in "${lorebook}"`);
            } else {
                const uid = Object.keys(entries).length
                    ? Math.max(...Object.keys(entries).map(Number)) + 1
                    : 0;
                entries[String(uid)] = makeLbEntry(uid, title, keys, content);
                if (debug) console.log(`[TRG:dev]   update: created "${title}" in "${lorebook}" (uid ${uid})`);
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

        const kwEsc      = (matchedKeyword ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const mkRe       = () => new RegExp(kwEsc, 'gi');
        const firstMatch = kwEsc ? mkRe().exec(msg.mes) : null;
        const upTo       = firstMatch ? msg.mes.slice(0, firstMatch.index) : '';
        const paragraph  = firstMatch ? extractParagraph(msg.mes, firstMatch.index).text : '';

        const resolvedValue = await resolveLbTokens(config.value ?? '', matchedKeyword, highlighted, vars, messageId);
        const value = interpolate(resolvedValue, {
            keyword:   matchedKeyword ?? '',
            message:   msg.mes,
            'up-to':   upTo,
            paragraph,
            char:      name2 ?? '',
            user:      name1 ?? '',
        }, vars ?? {});

        const save = async () => {
            if (isCurrentGeneration && !isCurrentGeneration()) return;
            updateMessageBlock(messageId, msg);
            if (typeof stCtx.saveChat === 'function') await stCtx.saveChat();
            eventSource.emit(event_types.MESSAGE_UPDATED, messageId);
        };

        const mode = config.mode ?? 'replaceKeyword';

        if (mode === 'replaceKeyword') {
            msg.mes = msg.mes.replace(mkRe(), value);
            try { await save(); } catch (err) { console.error('[triggeryze] update text replaceKeyword: save failed', err); }
        } else if (mode === 'replaceParagraph') {
            const paragraphs = collectUniqueParagraphs(msg.mes, mkRe());
            if (!paragraphs.length) return;
            let built = msg.mes;
            for (let i = paragraphs.length - 1; i >= 0; i--)
                built = built.slice(0, paragraphs[i].start) + value + built.slice(paragraphs[i].end);
            msg.mes = built;
            try { await save(); } catch (err) { console.error('[triggeryze] update text replaceParagraph: save failed', err); }
        } else if (mode === 'appendToMessage') {
            msg.mes = msg.mes + '\n\n' + value;
            try { await save(); } catch (err) { console.error('[triggeryze] update text appendToMessage: save failed', err); }
        } else if (mode === 'insertMessage') {
            const newMsg = {
                name: name2 ?? '', is_user: false, is_system: false,
                send_date: new Date().toLocaleString(),
                mes: value, extra: {}, swipe_id: 0, swipes: [value],
            };
            stCtx.chat.splice(messageId + 1, 0, newMsg);
            try {
                addOneMessage(newMsg, { insertAfter: messageId, scroll: true });
                if (typeof stCtx.saveChat === 'function') await stCtx.saveChat();
            } catch (err) { console.error('[triggeryze] update text insertMessage: failed', err); }
        }
    },

    renderConfig($el, config, onChange, ctx) {
        const target = config.target ?? 'lorebook';
        const s = (val, want) => val === want ? ' selected' : '';

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
            <input type="text" class="text_pole trg-cfg trg-up-lorebook" placeholder="lorebook name" value="${esc(config.lorebook ?? '')}" style="flex:1" />
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
        ${renderVarLegend(ctx?.priorActions, ctx?.crossRuleVars)}
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
                <option value="appendToMessage"  ${s(config.mode, 'appendToMessage' )}>append to message</option>
                <option value="insertMessage"    ${s(config.mode, 'insertMessage'   )}>insert as message</option>
            </select>
        </div>
        ${renderVarLegend(ctx?.priorActions, ctx?.crossRuleVars)}
        <textarea class="text_pole trg-cfg trg-up-value" rows="3"
            placeholder="Value — {{keyword}} {{highlighted}} {{paragraph}} {{message}} {{myVar}}">${esc(config.value ?? '')}</textarea>
    </div>
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

        $el.find('.trg-up-target').on('change', function () {
            const t = $(this).val();
            $el.find('.trg-up-lorebook-fields').toggle(t === 'lorebook');
            $el.find('.trg-up-text-fields').toggle(t === 'text');
            onChange(readConfig());
        });

        $el.find('.trg-up-lorebook, .trg-up-title, .trg-up-keys, .trg-up-content, .trg-up-outvar').on('input', () => onChange(readConfig()));
        $el.find('.trg-up-mode').on('change', () => onChange(readConfig()));
        $el.find('.trg-up-value').on('input', () => onChange(readConfig()));

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
