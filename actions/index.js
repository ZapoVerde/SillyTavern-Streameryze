/**
 * @file st-extensions/SillyTavern-Triggeryze/actions/index.js
 * @stamp {"utc":"2026-06-15T00:00:00.000Z"}
 * @architectural-role Registry — ACTION_REGISTRY assembler and public re-export surface
 * @description
 * Assembles ACTION_REGISTRY from individual action modules and re-exports all public
 * symbols consumed by engine.js and the extension entry point. Contains no action
 * logic of its own.
 *
 * Also exports makeActionCtx, which enriches priorActions with labels so that
 * renderVarLegend (var-legend.js) can display human-readable names without importing
 * ACTION_REGISTRY itself.
 *
 * @api-declaration
 * ACTION_REGISTRY                          — map of type key → action definition
 * makeActionCtx(rule, actionIdx)           — builds the ctx object passed to renderConfig
 * isDispatchActive()                       — re-exported from dispatch.js
 * clearPrefetchCache()                     — re-exported from dispatch.js
 * getPrefetchedResults(key)                — re-exported from dispatch.js
 * prefetchSideCall(...)                    — re-exported from dispatch.js
 * interpolate(template, vars, ruleVars)    — re-exported from template.js
 * getTemplateTier(strings)                 — re-exported from template.js
 * resolveLbTokens(...)                     — re-exported from template.js
 *
 * @contract
 *   assertions:
 *     purity:          none — delegates all IO to imported modules
 *     state_ownership: none
 *     external_io:     none directly; all IO is in imported modules
 */

import { stop, stopContinue } from './stop.js';
import { replace }            from './replace.js';
import { sideCall }           from './side-call.js';
import { compose }            from './compose.js';
import { slashCmd }           from './slash-cmd.js';
import { update }             from './update.js';
import { imageGen }           from './image-gen.js';

export const ACTION_REGISTRY = {
    stop,
    stopContinue,
    replace,
    sideCall,
    compose,
    slashCmd,
    update,
    imageGen,
};

/**
 * Builds the ctx object passed to renderConfig.
 * Enriches priorActions with the human-readable label from ACTION_REGISTRY so that
 * renderVarLegend can display it without importing ACTION_REGISTRY directly.
 */
export function makeActionCtx(rule, actionIdx) {
    return {
        priorActions: (rule?.actions ?? []).slice(0, actionIdx).map(a => ({
            ...a,
            label: ACTION_REGISTRY[a.type]?.label ?? a.type,
        })),
    };
}

export { isDispatchActive, clearPrefetchCache, getPrefetchedResults, prefetchSideCall } from './dispatch.js';
export { interpolate, getTemplateTier, resolveLbTokens }                                from './template.js';
