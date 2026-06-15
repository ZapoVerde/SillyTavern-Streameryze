/**
 * @file st-extensions/SillyTavern-Triggeryze/actions/stop.js
 * @stamp {"utc":"2026-06-15T00:00:00.000Z"}
 * @architectural-role Registry — stop and stop+continue stream actions
 * @description
 * Two stream-stage actions that halt generation. stop halts and does nothing else.
 * stopContinue halts then re-triggers generation after a short delay, allowing
 * any newly activated lorebook entries to participate in the resumed reply.
 *
 * @api-declaration
 * stop        — action definition object for the ACTION_REGISTRY
 * stopContinue — action definition object for the ACTION_REGISTRY
 *
 * @contract
 *   assertions:
 *     purity:          none — both actions call stCtx.stopGeneration() and/or window.SillyTavern
 *     state_ownership: none
 *     external_io:     stCtx.stopGeneration(), eventSource, window.SillyTavern
 */

import { eventSource, event_types } from '../../../../script.js';

export const stop = {
    label: 'stop',
    stage: 'stream',
    templateFields: () => [],
    defaultConfig: {},
    async execute(config, { stCtx }) {
        stCtx?.stopGeneration?.();
    },
    renderConfig($el) {
        $el.html('<small class="trg-hint">Halts generation. The matched text stays in the partial message.</small>');
    },
};

export const stopContinue = {
    label: 'stop + continue',
    stage: 'stream',
    templateFields: () => [],
    defaultConfig: {},
    async execute(config, { stCtx }) {
        stCtx?.stopGeneration?.();
        // GENERATION_STOPPED fires synchronously inside stopGeneration().
        // The 500ms delay lets the async stream teardown finish before resuming.
        eventSource.once(event_types.GENERATION_STOPPED, () => {
            setTimeout(() => window.SillyTavern?.getContext?.()?.generate?.('continue'), 500);
        });
    },
    renderConfig($el) {
        $el.html('<small class="trg-hint">Stops and resumes — newly triggered lorebook entries will be active in the continued reply.</small>');
    },
};
