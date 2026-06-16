/**
 * @file triggers/condition.js
 * @stamp {"utc":"2026-06-16T00:00:00.000Z"}
 * @architectural-role Registry — condition trigger entry
 * @description
 * Trigger that evaluates a boolean expression against the current turn variable store.
 * Fires when the expression is truthy. Expression syntax is handled by evalCondition
 * and makeLookup in actions/condition.js.
 *
 * @api-declaration
 * conditionTrigger — trigger registry entry object
 *
 * @contract
 *   assertions:
 *     purity:          test() is read-only; renderConfig mutates DOM only
 *     state_ownership: none
 *     external_io:     none (reads turn vars via makeLookup/getTurnVarsSnapshot)
 */

import { evalCondition, makeLookup } from '../actions/condition.js';
import { getTurnVarsSnapshot }       from './turn-vars.js';

export const conditionTrigger = {
    label: 'condition',
    defaultConfig: { expression: '' },
    async test(_text, config) {
        if (!config.expression?.trim()) return null;
        return evalCondition(config.expression, makeLookup(getTurnVarsSnapshot())) ? 'true' : null;
    },
    renderConfig($el, config, onChange) {
        $el.html(`
<input type="text" class="text_pole trg-cfg trg-cond-expr"
    placeholder="chatvar::stats.hp &lt; 20 AND chatvar::gold &gt;= 100"
    value="${$('<span>').text(config.expression ?? '').html()}" />
<div class="trg-kw-footer" style="margin-top:4px">
    <small class="trg-hint" style="flex:1">
        Variables, <span class="trg-help-eg">chatvar::</span>/<span class="trg-help-eg">globalvar::</span> (with <span class="trg-help-eg">.key</span> or <span class="trg-help-eg">[key]</span>),
        operators: <span class="trg-help-eg">&lt; &gt; &lt;= &gt;= matches contains is empty in (…)</span>,
        boolean: <span class="trg-help-eg">AND OR !</span> and <span class="trg-help-eg">( )</span>
    </small>
    <span class="trg-cond-result" style="font-size:.78em;font-weight:600;padding:1px 7px;border-radius:8px;border:1px solid;opacity:.8"></span>
</div>`);

        const $expr   = $el.find('.trg-cond-expr');
        const $result = $el.find('.trg-cond-result');

        const preview = () => {
            const expr = $expr.val().trim();
            if (!expr) { $result.hide(); return; }
            const hit = evalCondition(expr, makeLookup(getTurnVarsSnapshot()));
            $result
                .text(hit ? 'true' : 'false')
                .css({
                    background:   hit ? 'rgba(50,180,80,.2)'   : 'rgba(180,50,50,.2)',
                    borderColor:  hit ? 'rgba(50,180,80,.5)'   : 'rgba(180,50,50,.5)',
                    color:        hit ? '#8f8'                  : '#f88',
                })
                .show();
        };

        $expr.on('input', function () {
            onChange({ ...config, expression: this.value });
            preview();
        });
        preview();
    },
};
