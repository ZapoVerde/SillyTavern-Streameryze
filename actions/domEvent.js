/**
 * @file st-extensions/SillyTavern-Triggeryze/actions/domEvent.js
 * @stamp {"utc":"2026-06-18T12:00:00.000Z"}
 * @architectural-role Registry — domEvent action entry
 * @description
 * Dispatches a DOM CustomEvent with a configurable name and JSON payload.
 * All payload fields support {{varName}} interpolation so callers can inject
 * turn variables (e.g. {{dom_event_uuid}}) into outgoing events.
 *
 * Primary use: fire plz:request-rmbg or plz:request-gen-rmbg to trigger
 * Personalyze image processing from a Triggeryze rule.
 *
 * @api-declaration
 * domEvent — action definition object for the ACTION_REGISTRY
 *
 * @contract
 *   assertions:
 *     purity:          none — dispatches DOM events
 *     state_ownership: none
 *     external_io:     [document.dispatchEvent]
 */

import { interpolate } from './template.js';
import { esc } from './text.js';
import { renderVarLegend } from './var-legend.js';

export const domEvent = {
    label: 'dispatch DOM event',
    stage: 'postMessage',
    templateFields: cfg => [cfg.payload],
    defaultConfig: { eventName: 'plz:request-rmbg', payload: '{}' },

    async execute(config, { vars }) {
        const eventName = config.eventName?.trim();
        if (!eventName) return;

        const rawPayload = interpolate(config.payload ?? '{}', {}, vars ?? {});
        let detail;
        try {
            detail = JSON.parse(rawPayload);
        } catch {
            detail = { raw: rawPayload };
        }

        document.dispatchEvent(new CustomEvent(eventName, { detail }));
    },

    renderConfig($el, config, onChange, ctx) {
        $el.html(`
<div style="display:flex;flex-direction:column;gap:6px">
    <div style="display:flex;gap:6px;align-items:center">
        <label style="white-space:nowrap;font-size:.85em">event name</label>
        <input type="text" class="trg-dom-act-name text_pole"
            placeholder="e.g. plz:request-rmbg"
            value="${esc(config.eventName ?? '')}"
            style="flex:1;font-size:.85em" />
    </div>
    ${renderVarLegend(ctx?.priorActions, ctx?.crossRuleVars, ctx?.globalVars)}
    <textarea class="trg-dom-act-payload text_pole" rows="4"
        placeholder='{"image":"personalyze/{{keyword}}.png","dir":"exports","uuid":"{{dom_event_uuid}}"}'
        >${esc(config.payload ?? '{}')}</textarea>
    <small class="trg-hint">JSON payload — supports <code>{{varName}}</code> interpolation. Dispatched to <code>document</code>.</small>
</div>`);

        $el.on('click', '.trg-var-inject', function () {
            const token = $(this).data('token');
            const $ta   = $el.find('.trg-dom-act-payload');
            const el    = $ta[0];
            if (!el) return;
            const s = el.selectionStart ?? el.value.length;
            const e = el.selectionEnd   ?? s;
            el.value = el.value.slice(0, s) + token + el.value.slice(e);
            el.selectionStart = el.selectionEnd = s + token.length;
            $ta.trigger('input');
            el.focus();
        });

        const update = () => onChange({
            ...config,
            eventName: $el.find('.trg-dom-act-name').val().trim(),
            payload:   $el.find('.trg-dom-act-payload').val(),
        });
        $el.find('.trg-dom-act-name, .trg-dom-act-payload').on('input', update);
    },
};
