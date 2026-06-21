/**
 * @file st-extensions/SillyTavern-Triggeryze/actions/replace.js
 * @stamp {"utc":"2026-06-15T00:00:00.000Z"}
 * @architectural-role Registry — replace action (keyword substitution in committed message)
 * @description
 * Replaces every instance of the matched keyword in the committed message with
 * a user-defined replacement string. Replacement may include {{variable}} tokens.
 * Persists the change through ST's normal save-and-notify pipeline.
 *
 * @api-declaration
 * replace — action definition object for the ACTION_REGISTRY
 *
 * @contract
 *   assertions:
 *     purity:          none — writes to msg.mes, calls updateMessageBlock and saveChat
 *     state_ownership: none
 *     external_io:     eventSource, updateMessageBlock, stCtx.saveChat
 */

import { eventSource, event_types, updateMessageBlock } from '../../../../../script.js';
import { interpolate, resolveLbTokens } from './template.js';
import { esc } from './text.js';
import { renderVarLegend } from './var-legend.js';
import { trgError } from '../logger.js';

export const replace = {
    label: 'replace',
    stage: 'postMessage',
    templateFields: cfg => [cfg.replacement],
    defaultConfig: { replacement: '' },
    async execute(config, { matchedKeyword, messageId, stCtx, vars, highlighted = '' }) {
        const msg = stCtx?.chat?.[messageId];
        if (!msg) return;
        const re                  = new RegExp(matchedKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        const resolvedReplacement = await resolveLbTokens(config.replacement ?? '', matchedKeyword, highlighted, vars, messageId);
        const replacement         = interpolate(resolvedReplacement, { keyword: matchedKeyword }, vars ?? {});
        const updated             = msg.mes.replace(re, replacement);
        if (updated === msg.mes) return;
        msg.mes = updated;
        try {
            updateMessageBlock(messageId, msg);
            if (typeof stCtx.saveChat === 'function') await stCtx.saveChat();
            eventSource.emit(event_types.MESSAGE_UPDATED, messageId);
        } catch (err) {
            trgError('replace: render/save failed', err);
        }
    },
    renderConfig($el, config, onChange, ctx) {
        $el.html(`${renderVarLegend(ctx?.priorActions, ctx?.crossRuleVars, ctx?.globalVars)}
<input type="text" class="text_pole trg-cfg trg-replace-input" placeholder="replacement — blank to delete. Use {{varName}} to inject a step result." value="${esc(config.replacement)}" />`);
        $el.find('.trg-replace-input').on('input', function () { onChange({ ...config, replacement: this.value }); });
        $el.on('click', '.trg-var-inject', function () {
            const token = $(this).data('token');
            const $inp  = $el.find('.trg-replace-input');
            const el    = $inp[0];
            if (!el) return;
            const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? s;
            el.value = el.value.slice(0, s) + token + el.value.slice(e);
            el.selectionStart = el.selectionEnd = s + token.length;
            $inp.trigger('input');
            el.focus();
        });
    },
};
