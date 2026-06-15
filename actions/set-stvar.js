/**
 * @file st-extensions/SillyTavern-Triggeryze/actions/set-stvar.js
 * @stamp {"utc":"2026-06-15T00:00:00.000Z"}
 * @architectural-role Registry — Set ST Variable action (write to ST chat or global variable store)
 * @description
 * Evaluates a template string and writes the result into an ST chat variable
 * (chat_metadata.variables) or global variable (extension_settings.variables.global).
 * ST variables persist across turns; chat variables are scoped to this chat file,
 * global variables are shared across all chats.
 *
 * @api-declaration
 * setStVar — action definition object for the ACTION_REGISTRY
 *
 * @contract
 *   assertions:
 *     purity:          none — writes to ST variable stores
 *     state_ownership: none (delegates to ST variables API)
 *     external_io:     setLocalVariable / setGlobalVariable (ST API), resolveLbTokens
 */

import { name1, name2 }                                                         from '../../../../../script.js';
import { setLocalVariable, setGlobalVariable }                                   from '../../../../../scripts/variables.js';
import { interpolate, resolveLbTokens }                                          from './template.js';
import { esc }                                                                   from './text.js';
import { renderVarLegend }                                                       from './var-legend.js';

export const setStVar = {
    label: 'Set ST variable',
    stage: 'postMessage',
    templateFields: cfg => [cfg.value],
    defaultConfig: { scope: 'chat', varName: '', value: '' },

    async execute(config, { matchedKeyword, messageId, stCtx, vars, debug, highlighted = '' }) {
        if (!config.varName) return;
        const msg        = stCtx?.chat?.[messageId];
        const text       = msg?.mes ?? '';
        const kwEsc      = (matchedKeyword ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const firstMatch = kwEsc ? new RegExp(kwEsc, 'i').exec(text) : null;
        const upTo       = firstMatch ? text.slice(0, firstMatch.index) : '';
        const resolved   = await resolveLbTokens(config.value ?? '', matchedKeyword, highlighted, vars);
        const value      = interpolate(resolved, {
            keyword: matchedKeyword ?? '',
            message: text,
            'up-to': upTo,
            char:    name2 ?? '',
            user:    name1 ?? '',
        }, vars);
        if (debug) console.log(`[TRG:dev]   setStVar ${config.scope}:${config.varName} =`, value);
        if (config.scope === 'global') {
            setGlobalVariable(config.varName, value);
        } else {
            setLocalVariable(config.varName, value);
        }
    },

    renderConfig($el, config, onChange, ctx) {
        $el.html(`
<div class="trg-sc-wrap">
    <div class="trg-sc-row">
        <label class="trg-sc-lbl">scope</label>
        <select class="trg-cfg trg-stv-scope">
            <option value="chat"   ${(config.scope ?? 'chat') !== 'global' ? 'selected' : ''}>chat — persists this conversation</option>
            <option value="global" ${config.scope === 'global'             ? 'selected' : ''}>global — persists across all chats</option>
        </select>
    </div>
    <div class="trg-sc-row">
        <label class="trg-sc-lbl">name</label>
        <input type="text" class="trg-cfg trg-stv-name" placeholder="variable name" value="${esc(config.varName ?? '')}" style="flex:1" />
    </div>
    ${renderVarLegend(ctx?.priorActions, ctx?.crossRuleVars)}
    <textarea class="text_pole trg-cfg trg-stv-value" rows="3"
        placeholder="value — supports {{variables}} and {{chatvar::existing}}">${esc(config.value ?? '')}</textarea>
</div>`);

        const update = () => onChange({
            ...config,
            scope:   $el.find('.trg-stv-scope').val(),
            varName: $el.find('.trg-stv-name').val().trim(),
            value:   $el.find('.trg-stv-value').val(),
        });
        $el.find('.trg-stv-scope, .trg-stv-name, .trg-stv-value').on('input change', update);
        $el.on('click', '.trg-var-inject', function () {
            const token = $(this).data('token');
            const $ta   = $el.find('.trg-stv-value');
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
