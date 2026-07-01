/**
 * @file st-extensions/SillyTavern-Triggeryze/actions/compose.js
 * @stamp {"utc":"2026-07-01T00:00:00.000Z"}
 * @architectural-role Registry — compose variable action (template → named variable)
 * @description
 * Evaluates a template string and writes the result into a named turn variable.
 * Supports {{if condition}}...{{/if}} blocks and {{varName}} substitution.
 * The output variable is available to all subsequent actions in the same rule.
 *
 * @api-declaration
 * compose — action definition object for the ACTION_REGISTRY; preview(config, text) resolves
 *   the template against sample text and the current turn-var snapshot without writing anything
 *
 * @contract
 *   assertions:
 *     purity:          none — writes to vars map
 *     state_ownership: none
 *     external_io:     resolveLbTokens (lorebook read)
 */

import { name1, name2 } from '../../../../../script.js';
import { interpolate, resolveLbTokens } from './template.js';
import { esc } from './text.js';
import { renderVarLegend } from './var-legend.js';
import { trgDev, trgLog } from '../logger.js';
import { testDrawerHtml, attachTestDrawer } from '../triggers/test-drawer.js';
import { getTurnVarsSnapshot } from '../triggers/turn-vars.js';

// Resolves the template against the given message text — shared by execute() and preview()
// so the two can never drift: preview simply stops here instead of writing the result.
async function resolve(config, { matchedKeyword, highlighted, text, vars, messageId }) {
    const kwEsc      = (matchedKeyword ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const firstMatch = kwEsc ? new RegExp(kwEsc, 'i').exec(text) : null;
    const upTo       = firstMatch ? text.slice(0, firstMatch.index) : '';
    const resolvedTemplate = await resolveLbTokens(config.template ?? '', matchedKeyword, highlighted, vars, messageId);
    return interpolate(resolvedTemplate, {
        keyword: matchedKeyword ?? '',
        message: text,
        'up-to': upTo,
        char:    name2 ?? '',
        user:    name1 ?? '',
    }, vars ?? {});
}

export const compose = {
    label: 'compose variable',
    templateFields: cfg => [cfg.template],
    defaultConfig: { outputVar: '', template: '' },
    async execute(config, { matchedKeyword, messageId, stCtx, vars, debug, highlighted = '' }) {
        if (!config.outputVar || !vars) return;
        const text   = stCtx?.chat?.[messageId]?.mes ?? '';
        const result = await resolve(config, { matchedKeyword, highlighted, text, vars, messageId });
        trgDev(debug, `  compose "${config.outputVar}" =`, result);
        trgLog('compose result', { outputVar: config.outputVar, result: result.slice(0, 120) + (result.length > 120 ? `… (${result.length} chars)` : '') });
        vars[config.outputVar] = result;
    },
    async preview(config, text) {
        if (!config.outputVar) return { hint: 'Set a variable name to preview.' };
        const value = await resolve(config, {
            matchedKeyword: '', highlighted: '', text, messageId: null,
            vars: getTurnVarsSnapshot(),
        });
        return { output: `${config.outputVar} =\n${value}` };
    },
    renderConfig($el, config, onChange, ctx) {
        $el.html(`
<div class="trg-sc-wrap">
    <div class="trg-sc-row">
        <label class="trg-sc-lbl">name</label>
        <input type="text" class="trg-cfg trg-cv-name trg-outvar-field" placeholder="variable name" value="${esc(config.outputVar ?? '')}" style="flex:1" />
    </div>
    ${renderVarLegend(ctx?.priorActions, ctx?.crossRuleVars, ctx?.globalVars)}
    <textarea class="text_pole trg-cfg trg-cv-template" rows="3"
        placeholder="{{if keyword matches &quot;breath|hitch&quot;}}Forced Physical Reaction Cliché&#10;{{/if}}{{if keyword is &quot;stone&quot;}}Purple Prose Metaphor&#10;{{/if}}">${esc(config.template ?? '')}</textarea>
<div class="trg-kw-footer">
    <span class="trg-help-toggle" title="Variables and functions cheatsheet">?</span>
</div>
<div class="trg-help-text" style="display:none;">
    <b>{{varName}}</b> — insert variable &nbsp;&nbsp; <b>{{if condition}}…{{/if}}</b> — conditional block<br>
    Condition operators: <span class="trg-help-eg">matches "regex"</span> &nbsp; <span class="trg-help-eg">contains "text"</span> &nbsp; <span class="trg-help-eg">is "value"</span> &nbsp; <span class="trg-help-eg">in (a, b, c)</span> &nbsp; <span class="trg-help-eg">empty</span><br>
    Combinators: <span class="trg-help-eg">AND</span> &nbsp; <span class="trg-help-eg">OR</span> &nbsp; <span class="trg-help-eg">!</span> &nbsp; <span class="trg-help-eg">( )</span> — see the Template Language reference drawer for full docs.
</div>
${testDrawerHtml()}
</div>`);

        const read = () => ({
            ...config,
            outputVar: $el.find('.trg-cv-name').val().trim(),
            template:  $el.find('.trg-cv-template').val(),
        });
        const update = () => onChange(read());
        const refreshTestDrawer = attachTestDrawer($el, read, (cfg, text) => compose.preview(cfg, text));
        $el.find('.trg-cv-name, .trg-cv-template').on('input', () => { update(); refreshTestDrawer(); });
        $el.find('.trg-help-toggle').on('click', function () {
            $el.find('.trg-help-text').slideToggle(150);
            $(this).toggleClass('trg-help-open');
        });
        $el.on('click', '.trg-var-inject', function () {
            const token = $(this).data('token');
            const $ta   = $el.find('.trg-cv-template');
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
