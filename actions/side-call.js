/**
 * @file st-extensions/SillyTavern-Triggeryze/actions/side-call.js
 * @stamp {"utc":"2026-06-15T00:00:00.000Z"}
 * @architectural-role Registry — sideCall action (LLM call with text output modes)
 * @description
 * Fires a quiet LLM prompt and routes the result into the message via one of five
 * output modes: replaceKeyword, replaceParagraph, appendToMessage, insertMessage, silent.
 * Supports once/perMatch call modes and consumes prefetched promises from dispatch.js
 * when available, so results are often already settled by the time the stream ends.
 *
 * @api-declaration
 * sideCall — action definition object for the ACTION_REGISTRY
 *
 * @contract
 *   assertions:
 *     purity:          none — dispatches LLM calls, writes msg.mes, calls saveChat
 *     state_ownership: none
 *     external_io:     dispatch (via dispatch.js), updateMessageBlock, addOneMessage, eventSource, stCtx.saveChat
 */

import { eventSource, event_types, name1, name2, addOneMessage, updateMessageBlock } from '../../../../../script.js';
import { ConnectionManagerRequestService } from '../../../shared.js';
import { interpolate, resolveLbTokens, resolveHistoryTokens } from './template.js';
import { esc, runQueued, extractParagraph, collectUniqueParagraphs } from './text.js';
import { dispatch, getPrefetchedResults } from './dispatch.js';
import { renderVarLegend } from './var-legend.js';

export const sideCall = {
    label: 'call LLM',
    stage: 'postMessage',
    templateFields: cfg => [cfg.prompt],
    defaultConfig: { prompt: '', profileId: null, outputMode: 'replaceKeyword', callMode: 'once', outputVar: '' },

    async execute(config, { matchedKeyword, messageId, stCtx, ruleId, actionIdx, isCurrentGeneration, vars, debug, highlighted = '' }) {
        const msg         = stCtx?.chat?.[messageId];
        const charName    = name2 ?? '';
        const userName    = name1 ?? '';
        const mode        = config.outputMode  ?? 'replaceKeyword';
        const callMode    = config.callMode    ?? 'once';
        const cacheKey    = `${ruleId}:${actionIdx}`;
        const kwEsc       = matchedKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const mkRe        = () => new RegExp(kwEsc, 'gi');
        const resolvedPrompt = resolveHistoryTokens(
            await resolveLbTokens(config.prompt ?? '', matchedKeyword, highlighted, vars, messageId),
            stCtx?.chat, messageId, vars ?? {},
        );

        const mkPrompt = (paragraph = '', upTo = '') => interpolate(resolvedPrompt, {
            keyword:   matchedKeyword ?? '',
            message:   msg?.mes ?? '',
            paragraph,
            'up-to':   upTo,
            char:      charName,
            user:      userName,
        }, vars ?? {});

        if (!mkPrompt().trim()) return;

        const save = async () => {
            if (isCurrentGeneration && !isCurrentGeneration()) return;
            updateMessageBlock(messageId, msg);
            if (typeof stCtx.saveChat === 'function') await stCtx.saveChat();
            eventSource.emit(event_types.MESSAGE_UPDATED, messageId);
        };

        // replaceParagraph: replace the entire newline-bounded paragraph(s) containing the keyword.
        if (mode === 'replaceParagraph') {
            if (!msg) return;
            if (callMode === 'perMatch') {
                const paragraphs = collectUniqueParagraphs(msg.mes, mkRe());
                if (!paragraphs.length) return;
                const cached = getPrefetchedResults(cacheKey) ?? [];
                const n      = paragraphs.length;
                const nc     = Math.min(cached.length, n);
                const [pre, fresh] = await Promise.all([
                    Promise.all(cached.slice(0, nc)),
                    runQueued(paragraphs.slice(nc).map(p => () => dispatch(mkPrompt(p.text, msg.mes.slice(0, p.start)), config.profileId ?? null, debug))),
                ]);
                if (isCurrentGeneration && !isCurrentGeneration()) return;
                const results = [...pre, ...fresh];
                let built = msg.mes;
                for (let i = n - 1; i >= 0; i--) {
                    if (!results[i]) continue;
                    built = built.slice(0, paragraphs[i].start) + results[i] + built.slice(paragraphs[i].end);
                }
                msg.mes = built;
            } else {
                const firstMatch = mkRe().exec(msg.mes);
                if (!firstMatch) return;
                const p      = extractParagraph(msg.mes, firstMatch.index);
                const upTo   = msg.mes.slice(0, firstMatch.index);
                const cached = getPrefetchedResults(cacheKey);
                let text;
                try {
                    text = cached?.length ? await cached[0] : await dispatch(mkPrompt(p.text, upTo), config.profileId ?? null, debug);
                } catch (err) { console.error('[triggeryze] sideCall replaceParagraph: dispatch failed', err); return; }
                if (!text || (isCurrentGeneration && !isCurrentGeneration())) return;
                msg.mes = msg.mes.slice(0, p.start) + text + msg.mes.slice(p.end);
            }
            try { await save(); } catch (err) { console.error('[triggeryze] sideCall replaceParagraph: render/save failed', err); }
            return;
        }

        // perMatch + replaceKeyword: one call per keyword instance.
        if (callMode === 'perMatch' && mode === 'replaceKeyword') {
            if (!msg) return;
            const matches = [...msg.mes.matchAll(mkRe())];
            if (!matches.length) return;
            const cached = getPrefetchedResults(cacheKey) ?? [];
            const nc     = Math.min(cached.length, matches.length);
            const [pre, fresh] = await Promise.all([
                Promise.all(cached.slice(0, nc)),
                runQueued(matches.slice(nc).map(m => () => dispatch(mkPrompt('', msg.mes.slice(0, m.index)), config.profileId ?? null, debug))),
            ]);
            if (isCurrentGeneration && !isCurrentGeneration()) return;
            const results = [...pre, ...fresh];
            let built = msg.mes;
            for (let i = matches.length - 1; i >= 0; i--) {
                if (!results[i]) continue;
                const m = matches[i];
                built = built.slice(0, m.index) + results[i] + built.slice(m.index + m[0].length);
            }
            msg.mes = built;
            try { await save(); } catch (err) { console.error('[triggeryze] sideCall perMatch: render/save failed', err); }
            return;
        }

        // once: single LLM call, use prefetched promise if available.
        const firstMatch = mkRe().exec(msg?.mes ?? '');
        const upTo       = firstMatch ? (msg?.mes ?? '').slice(0, firstMatch.index) : '';
        const cached     = getPrefetchedResults(cacheKey);
        if (debug && cached?.length) console.log(`[TRG:dev]   [${actionIdx}] sideCall using prefetch cache`);
        let text;
        try {
            text = cached?.length ? await cached[0] : await dispatch(mkPrompt('', upTo), config.profileId ?? null, debug);
        } catch (err) { console.error('[triggeryze] sideCall: dispatch failed', err); return; }
        if (debug && cached?.length) console.log(`[TRG:dev]   [${actionIdx}] sideCall prefetch result:`, text);

        if (!text || (isCurrentGeneration && !isCurrentGeneration())) return;
        if (config.outputVar && vars) vars[config.outputVar] = text;
        if (mode === 'silent') return;

        if (mode === 'replaceKeyword') {
            if (!msg) return;
            msg.mes = msg.mes.replace(mkRe(), text);
            try { await save(); } catch (err) { console.error('[triggeryze] sideCall replaceKeyword: render/save failed', err); }
            return;
        }
        if (mode === 'appendToMessage') {
            if (!msg) return;
            msg.mes = msg.mes + '\n\n' + text;
            try { await save(); } catch (err) { console.error('[triggeryze] sideCall appendToMessage: render/save failed', err); }
            return;
        }
        if (mode === 'insertMessage') {
            const newMsg = {
                name: charName, is_user: false, is_system: false,
                send_date: new Date().toLocaleString(),
                mes: text, extra: {}, swipe_id: 0, swipes: [text],
            };
            stCtx.chat.splice(messageId + 1, 0, newMsg);
            try {
                addOneMessage(newMsg, { insertAfter: messageId, scroll: true });
                if (typeof stCtx.saveChat === 'function') await stCtx.saveChat();
            } catch (err) { console.error('[triggeryze] sideCall insertMessage: failed', err); }
        }
    },

    renderConfig($el, config, onChange, ctx) {
        let profileOpts = `<option value="">main ST chat LLM (default)</option>`;
        try {
            for (const p of ConnectionManagerRequestService.getSupportedProfiles()) {
                const sel = config.profileId === p.id ? ' selected' : '';
                profileOpts += `<option value="${esc(p.id)}"${sel}>${esc(p.name)}</option>`;
            }
        } catch { /* Connection Manager not available */ }

        const s = (val, want) => val === want ? ' selected' : '';

        $el.html(`
<div class="trg-sc-wrap">
    <div class="trg-sc-row">
        <label class="trg-sc-lbl">connection</label>
        <select class="trg-cfg trg-sc-profile">${profileOpts}</select>
    </div>
    <div class="trg-sc-row">
        <label class="trg-sc-lbl">output</label>
        <select class="trg-cfg trg-sc-mode">
            <option value="replaceKeyword"  ${s(config.outputMode, 'replaceKeyword'  )}>replace keyword</option>
            <option value="replaceParagraph"${s(config.outputMode, 'replaceParagraph')}>replace paragraph</option>
            <option value="appendToMessage" ${s(config.outputMode, 'appendToMessage' )}>append to message</option>
            <option value="insertMessage"   ${s(config.outputMode, 'insertMessage'   )}>insert as message</option>
            <option value="silent"          ${s(config.outputMode, 'silent'          )}>silent</option>
        </select>
    </div>
    <div class="trg-sc-row">
        <label class="trg-sc-lbl">calls</label>
        <select class="trg-cfg trg-sc-callmode">
            <option value="once"    ${s(config.callMode, 'once'    )}>once — same result for all instances</option>
            <option value="perMatch"${s(config.callMode, 'perMatch')}>per match — independent call per instance</option>
        </select>
    </div>
    <div class="trg-sc-row">
        <label class="trg-sc-lbl">save as</label>
        <input type="text" class="trg-cfg trg-sc-outvar trg-outvar-field" placeholder="variable name (optional)" value="${esc(config.outputVar ?? '')}" style="flex:1" />
    </div>
    ${renderVarLegend(ctx?.priorActions, ctx?.crossRuleVars)}
    <textarea class="text_pole trg-cfg trg-sc-prompt" rows="3"
        placeholder="Prompt — {{keyword}} {{up-to}} {{paragraph}} {{message}} {{history:[2]}} {{char}} {{user}}">${esc(config.prompt)}</textarea>
</div>`);

        const update = () => onChange({
            ...config,
            profileId:  $el.find('.trg-sc-profile').val() || null,
            outputMode: $el.find('.trg-sc-mode').val(),
            callMode:   $el.find('.trg-sc-callmode').val(),
            outputVar:  $el.find('.trg-sc-outvar').val().trim(),
            prompt:     $el.find('.trg-sc-prompt').val(),
        });

        $el.find('.trg-sc-profile, .trg-sc-mode, .trg-sc-callmode').on('change', update);
        $el.find('.trg-sc-outvar').on('input', update);
        $el.find('.trg-sc-prompt').on('input', update);
        $el.on('click', '.trg-var-inject', function () {
            const token = $(this).data('token');
            const $ta   = $el.find('.trg-sc-prompt');
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
