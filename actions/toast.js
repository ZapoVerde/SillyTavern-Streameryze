/**
 * @file st-extensions/SillyTavern-Triggeryze/actions/toast.js
 * @stamp {"utc":"2026-06-19T00:00:00.000Z"}
 * @architectural-role Registry — toast action (ST toastr notification)
 * @description
 * Pops a toastr notification with a user-configured message, level, and optional title.
 * Both message and title support {{variable}} interpolation. Thin wrapper over the global
 * toastr library that ST already loads; owns no notification logic of its own.
 *
 * @api-declaration
 * toast — action definition object for the ACTION_REGISTRY
 *
 * @contract
 *   assertions:
 *     purity:          none — calls window.toastr
 *     state_ownership: none
 *     external_io:     window.toastr
 */

import { name1, name2 }             from '../../../../../script.js';
import { interpolate, resolveLbTokens } from './template.js';
import { esc }                       from './text.js';
import { renderVarLegend }           from './var-legend.js';
import { trgDev }                    from '../logger.js';

const LEVELS = ['info', 'success', 'warning', 'error'];

export const toast = {
    label: 'toast',
    stage: ['stream', 'postMessage'],
    templateFields: cfg => [cfg.message, cfg.title],
    defaultConfig: { message: '', title: '', level: 'info', tapToDismiss: false, copyOnClick: false },

    async execute(config, { matchedKeyword, messageId, stCtx, vars, debug, highlighted = '' }) {
        if (!config.message) return;
        const text  = stCtx?.chat?.[messageId]?.mes ?? '';
        const level = LEVELS.includes(config.level) ? config.level : 'info';

        const [resolvedMsg, resolvedTitle] = await Promise.all([
            resolveLbTokens(config.message ?? '', matchedKeyword, highlighted, vars, messageId),
            resolveLbTokens(config.title   ?? '', matchedKeyword, highlighted, vars, messageId),
        ]);

        const ctx = { keyword: matchedKeyword ?? '', message: text, char: name2 ?? '', user: name1 ?? '' };
        const msg   = interpolate(resolvedMsg,   ctx, vars);
        const title = interpolate(resolvedTitle, ctx, vars);

        trgDev(debug, `  toast [${level}]:`, msg, title || '(no title)');

        const opts = {};
        if (config.tapToDismiss) opts.tapToDismiss = true;
        if (config.copyOnClick)  opts.onclick = () => navigator.clipboard?.writeText?.(msg);

        window.toastr?.[level]?.(msg, title || undefined, Object.keys(opts).length ? opts : undefined);
    },

    renderConfig($el, config, onChange, ctx) {
        $el.html(`
<div class="trg-sc-wrap">
    <div class="trg-sc-row">
        <label class="trg-sc-lbl">level</label>
        <select class="trg-cfg trg-toast-level">
            ${LEVELS.map(l => `<option value="${l}" ${config.level === l ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
    </div>
    <div class="trg-sc-row" style="margin-top:4px">
        <label class="trg-sc-lbl">title</label>
        <input type="text" class="trg-cfg trg-toast-title text_pole" placeholder="optional — supports {{variables}}" value="${esc(config.title ?? '')}" style="flex:1" />
    </div>
    ${renderVarLegend(ctx?.priorActions, ctx?.crossRuleVars, ctx?.globalVars)}
    <input type="text" class="trg-cfg trg-toast-message text_pole" placeholder="message — supports {{variables}}" value="${esc(config.message ?? '')}" style="margin-top:4px" />
    <label class="trg-check-row" style="margin-top:6px">
        <input type="checkbox" class="trg-toast-tap" ${config.tapToDismiss ? 'checked' : ''} />
        click to dismiss
    </label>
    <label class="trg-check-row">
        <input type="checkbox" class="trg-toast-copy" ${config.copyOnClick ? 'checked' : ''} />
        click to copy message
    </label>
</div>`);

        const update = () => onChange({
            ...config,
            level:        $el.find('.trg-toast-level').val(),
            title:        $el.find('.trg-toast-title').val(),
            message:      $el.find('.trg-toast-message').val(),
            tapToDismiss: $el.find('.trg-toast-tap').prop('checked'),
            copyOnClick:  $el.find('.trg-toast-copy').prop('checked'),
        });
        $el.find('.trg-toast-level, .trg-toast-title, .trg-toast-message').on('input change', update);
        $el.find('.trg-toast-tap, .trg-toast-copy').on('change', update);

        $el.on('click', '.trg-var-inject', function () {
            const token = $(this).data('token');
            const $inp  = $el.find('.trg-toast-message');
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
