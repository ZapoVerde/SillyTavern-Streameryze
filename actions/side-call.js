/**
 * @file st-extensions/SillyTavern-Triggeryze/actions/side-call.js
 * @stamp {"utc":"2026-07-01T00:00:00.000Z"}
 * @architectural-role Registry — sideCall action (LLM call with text output modes)
 * @description
 * Fires a quiet LLM prompt and routes the result into the message via one of five
 * output modes: replaceKeyword, replaceParagraph, appendToMessage, insertMessage, silent.
 * Supports once/perMatch call modes and consumes prefetched promises from dispatch.js
 * when available, so results are often already settled by the time the stream ends.
 *
 * @api-declaration
 * sideCall — action definition object for the ACTION_REGISTRY; preview(config, text) resolves
 *   and shows the prompt that would be sent — it never calls dispatch(), since an LLM call is
 *   neither free nor idempotent
 *
 * @contract
 *   assertions:
 *     purity:          none — dispatches LLM calls, writes msg.mes, calls saveChat
 *     state_ownership: none
 *     external_io:     dispatch (via dispatch.js), stCtx.saveChat; text mutations delegated to text-ops
 */

import { name1, name2 } from '../../../../../script.js';
import { ConnectionManagerRequestService } from '../../../shared.js';
import { interpolate, resolveLbTokens, resolveHistoryTokens } from './template.js';
import { esc, runQueued, extractParagraph, collectUniqueParagraphs } from './text.js';
import { makeSave, applyReplaceKeyword, applyAppend, applyInsertMessage } from './text-ops.js';
import { dispatch, getPrefetchedResults } from './dispatch.js';
import { trgError, trgDev } from '../logger.js';
import { renderVarLegend } from './var-legend.js';
import { testDrawerHtml, attachTestDrawer } from '../triggers/test-drawer.js';
import { getTurnVarsSnapshot } from '../triggers/turn-vars.js';

const _OUTPUT_MODE_HINTS = {
    replaceKeyword:   'Replaces every occurrence of the keyword in the current message with the LLM response.',
    replaceParagraph: 'Replaces the paragraph(s) containing a keyword match with the LLM response.',
    appendToMessage:  'Appends the LLM response after the current message text.',
    insertMessage:    'Creates a new AI chat bubble immediately after this one. No second LLM call — the response is posted directly as a separate message.',
    silent:           'Runs the LLM call but discards the output. Use with "save as" to capture the result into a variable.',
};

// Resolves the {{lb}}/{{ps}}/{{history}} tokens in the prompt template — shared by execute()
// and preview(). The final {{keyword}}/{{message}}/{{paragraph}}/{{up-to}} interpolation happens
// per call site since execute() needs a different paragraph/up-to per matched instance.
async function resolvePromptTemplate(config, { matchedKeyword, highlighted, vars, messageId, chat }) {
    return resolveHistoryTokens(
        await resolveLbTokens(config.prompt ?? '', matchedKeyword, highlighted, vars, messageId),
        chat, messageId, vars ?? {},
    );
}

export const sideCall = {
    label: 'call LLM',
    templateFields: cfg => [cfg.prompt],
    defaultConfig: { prompt: '', profileId: null, outputMode: 'replaceKeyword', callMode: 'once', outputVar: '' },

    async execute(config, { matchedKeyword, messageId, stCtx, ruleId, ruleName, actionIdx, isCurrentGeneration, vars, debug, highlighted = '' }) {
        const msg         = stCtx?.chat?.[messageId];
        const charName    = name2 ?? '';
        const userName    = name1 ?? '';
        const mode        = config.outputMode  ?? 'replaceKeyword';
        const callMode    = config.callMode    ?? 'once';
        const cacheKey    = `${ruleId}:${actionIdx}`;
        const kwEsc       = matchedKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const mkRe        = () => new RegExp(kwEsc, 'gi');
        const resolvedPrompt = await resolvePromptTemplate(config, { matchedKeyword, highlighted, vars, messageId, chat: stCtx?.chat });

        const mkPrompt = (paragraph = '', upTo = '') => interpolate(resolvedPrompt, {
            keyword:   matchedKeyword ?? '',
            message:   msg?.mes ?? '',
            paragraph,
            'up-to':   upTo,
            char:      charName,
            user:      userName,
        }, vars ?? {});

        if (!mkPrompt().trim()) return;

        const save = makeSave(isCurrentGeneration, messageId, msg, stCtx);

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
                } catch (err) { trgError(`sideCall replaceParagraph: dispatch failed (rule: ${ruleName})`, err); return; }
                if (!text || (isCurrentGeneration && !isCurrentGeneration())) return;
                msg.mes = msg.mes.slice(0, p.start) + text + msg.mes.slice(p.end);
            }
            try { await save(); } catch (err) { trgError(`sideCall replaceParagraph: render/save failed (rule: ${ruleName})`, err); }
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
            try { await save(); } catch (err) { trgError(`sideCall perMatch: render/save failed (rule: ${ruleName})`, err); }
            return;
        }

        // once: single LLM call, use prefetched promise if available.
        const firstMatch = mkRe().exec(msg?.mes ?? '');
        const upTo       = firstMatch ? (msg?.mes ?? '').slice(0, firstMatch.index) : '';
        const cached     = getPrefetchedResults(cacheKey);
        trgDev(debug && cached?.length, `  [${actionIdx}] sideCall using prefetch cache`);
        let text;
        try {
            text = cached?.length ? await cached[0] : await dispatch(mkPrompt('', upTo), config.profileId ?? null, debug);
        } catch (err) { trgError(`sideCall: dispatch failed (rule: ${ruleName})`, err); return; }
        trgDev(debug && cached?.length, `  [${actionIdx}] sideCall prefetch result:`, text);

        if (!text || (isCurrentGeneration && !isCurrentGeneration())) return;
        if (config.outputVar && vars) vars[config.outputVar] = text;
        if (mode === 'silent') return;

        if (mode === 'insertMessage') {
            try { await applyInsertMessage(stCtx, messageId, text, charName); }
            catch (err) { trgError(`sideCall insertMessage: failed (rule: ${ruleName})`, err); }
            return;
        }
        if (!msg) return;
        if (mode === 'replaceKeyword') {
            msg.mes = applyReplaceKeyword(msg.mes, mkRe, text);
            try { await save(); } catch (err) { trgError(`sideCall replaceKeyword: render/save failed (rule: ${ruleName})`, err); }
            return;
        }
        if (mode === 'appendToMessage') {
            msg.mes = applyAppend(msg.mes, text);
            try { await save(); } catch (err) { trgError(`sideCall appendToMessage: render/save failed (rule: ${ruleName})`, err); }
        }
    },

    async preview(config, text) {
        if (!config.prompt) return { hint: 'Set a prompt to preview.' };
        const vars = getTurnVarsSnapshot();
        const resolvedPrompt = await resolvePromptTemplate(config, {
            matchedKeyword: '', highlighted: '', vars, messageId: null, chat: [],
        });
        const prompt = interpolate(resolvedPrompt, {
            keyword: '', message: text, paragraph: '', 'up-to': '', char: name2 ?? '', user: name1 ?? '',
        }, vars);
        return { output: `Would send to LLM:\n${prompt}` };
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
            <option value="insertMessage"   ${s(config.outputMode, 'insertMessage'   )}>insert as new message</option>
            <option value="silent"          ${s(config.outputMode, 'silent'          )}>silent</option>
        </select>
    </div>
    <small class="trg-sc-mode-hint trg-hint" style="display:none"></small>
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
    ${renderVarLegend(ctx?.priorActions, ctx?.crossRuleVars, ctx?.globalVars)}
    <textarea class="text_pole trg-cfg trg-sc-prompt" rows="3"
        placeholder="Prompt — {{keyword}} {{up-to}} {{paragraph}} {{message}} {{history:[2]}} {{char}} {{user}}">${esc(config.prompt)}</textarea>
    ${testDrawerHtml()}
</div>`);

        const read = () => ({
            ...config,
            profileId:  $el.find('.trg-sc-profile').val() || null,
            outputMode: $el.find('.trg-sc-mode').val(),
            callMode:   $el.find('.trg-sc-callmode').val(),
            outputVar:  $el.find('.trg-sc-outvar').val().trim(),
            prompt:     $el.find('.trg-sc-prompt').val(),
        });
        const update = () => onChange(read());
        const refreshTestDrawer = attachTestDrawer($el, read, (cfg, text) => sideCall.preview(cfg, text));

        const $modeHint = $el.find('.trg-sc-mode-hint');
        const updateModeHint = mode => {
            const text = _OUTPUT_MODE_HINTS[mode] ?? '';
            $modeHint.text(text).toggle(!!text);
        };
        updateModeHint(config.outputMode ?? 'replaceKeyword');
        $el.find('.trg-sc-mode').on('change', function () { updateModeHint($(this).val()); });
        $el.find('.trg-sc-profile, .trg-sc-mode, .trg-sc-callmode').on('change', () => { update(); refreshTestDrawer(); });
        $el.find('.trg-sc-outvar').on('input', update);
        $el.find('.trg-sc-prompt').on('input', () => { update(); refreshTestDrawer(); });
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
