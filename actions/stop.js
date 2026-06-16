/**
 * @file st-extensions/SillyTavern-Triggeryze/actions/stop.js
 * @stamp {"utc":"2026-06-16T00:00:00.000Z"}
 * @architectural-role Registry — stop stream action
 * @description
 * Stream-stage action that halts generation. When andContinue is enabled,
 * resumes generation after stopping so that any newly activated lorebook
 * entries participate in the continued reply.
 *
 * @api-declaration
 * stop — action definition object for the ACTION_REGISTRY
 *
 * @contract
 *   assertions:
 *     purity:          none — calls stCtx.stopGeneration() and/or window.SillyTavern
 *     state_ownership: none
 *     external_io:     stCtx.stopGeneration(), eventSource, window.SillyTavern
 */

import { eventSource, event_types } from '../../../../../script.js';

export const stop = {
    label: 'stop',
    stage: 'stream',
    templateFields: () => [],
    defaultConfig: { andContinue: false },
    async execute(config, { stCtx }) {
        stCtx?.stopGeneration?.();
        if (config.andContinue) {
            // GENERATION_STOPPED fires synchronously inside stopGeneration().
            // The 500ms delay lets the async stream teardown finish before resuming.
            eventSource.once(event_types.GENERATION_STOPPED, () => {
                setTimeout(() => window.SillyTavern?.getContext?.()?.generate?.('continue'), 500);
            });
        }
    },
    renderConfig($el, config, onChange) {
        $el.html(`
<small class="trg-hint">Halts generation. The matched text stays in the partial message.</small>
<label class="trg-check-row" style="margin-top:4px">
    <input type="checkbox" ${config.andContinue ? 'checked' : ''} />
    continue after stop
</label>
<small class="trg-hint" style="margin-top:2px">When checked, resumes generation after stopping so newly triggered lorebook entries are active in the continued reply.</small>`);
        $el.find('input[type="checkbox"]').on('change', function () {
            onChange({ ...config, andContinue: this.checked });
        });
    },
};
