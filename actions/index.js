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

import { stop } from './stop.js';
import { replace }            from './replace.js';
import { sideCall }           from './side-call.js';
import { compose }            from './compose.js';
import { slashCmd }           from './slash-cmd.js';
import { update }             from './update.js';
import { imageGen }           from './image-gen.js';
import { loadImage }          from './load-image.js';
import { setStVar }           from './set-stvar.js';
import { domEvent }           from './domEvent.js';
import { toast }              from './toast.js';
import { preset }             from './preset.js';

export const ACTION_REGISTRY = {
    stop,
    replace,
    sideCall,
    compose,
    slashCmd,
    update,
    imageGen,
    loadImage,
    setStVar,
    domEvent,
    toast,
    preset,
};

/**
 * Builds the ctx object passed to renderConfig.
 * Enriches priorActions with the human-readable label from ACTION_REGISTRY so that
 * renderVarLegend can display it without importing ACTION_REGISTRY directly.
 *
 * crossRuleVars: non-$ outputVars from other rules in the same ruleset (ruleset-scoped vars).
 * globalVars:    $-prefixed outputVars from any other rule (accessible across all rulesets).
 */
export function makeActionCtx(rule, actionIdx, allRules = []) {
    const rulesetId     = rule?._rulesetId;
    const priorVarNames = new Set(
        (rule?.actions ?? []).slice(0, actionIdx).map(a => a.config?.outputVar).filter(Boolean)
    );
    const otherRules = allRules.filter(r => r.id !== rule?.id);
    return {
        priorActions: (rule?.actions ?? []).slice(0, actionIdx).map(a => ({
            ...a,
            label: ACTION_REGISTRY[a.type]?.label ?? a.type,
        })),
        crossRuleVars: otherRules
            .filter(r => r._rulesetId === rulesetId)
            .flatMap(r => (r.actions ?? [])
                .filter(a => a.config?.outputVar && !a.config.outputVar.startsWith('$') && !priorVarNames.has(a.config.outputVar))
                .map(a => ({ n: a.config.outputVar, h: `from rule: ${r.name || r.id}` }))
            ),
        globalVars: otherRules
            .flatMap(r => (r.actions ?? [])
                .filter(a => a.config?.outputVar?.startsWith('$') && !priorVarNames.has(a.config.outputVar))
                .map(a => ({ n: a.config.outputVar, h: `global · ${r.name || r.id}` }))
            ),
    };
}

export { isDispatchActive, clearPrefetchCache, getPrefetchedResults, prefetchSideCall } from './dispatch.js';
export { interpolate, getTemplateTier, resolveLbTokens }                                from './template.js';
