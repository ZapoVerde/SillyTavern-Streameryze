/**
 * @file st-extensions/SillyTavern-Triggeryze/engine/evaluate.js
 * @stamp {"utc":"2026-06-15T00:00:00.000Z"}
 * @architectural-role Engine — stateless trigger and rule evaluation utilities
 * @description
 * Pure evaluation helpers used throughout the rule loop. Trigger testing, AND/OR
 * combinator logic, stage membership, and template variable dependency resolution.
 * No state, no IO of its own — all side effects belong in callers.
 *
 * @api-declaration
 * evaluateTriggers(rule, text)        — tests all rule triggers; returns matched keyword or null
 * stageMatches(defStage, queryStage)  — true if a registry stage value covers the queried stage
 * ruleHasStage(rule, stage)           — true if any action in the rule fires at the given stage
 * getVarDeps(config, knownVars)       — returns config template vars that are in knownVars
 *
 * @contract
 *   assertions:
 *     purity:          impure — trigger.test is async and may call ST world-info APIs
 *     state_ownership: none
 *     external_io:     TRIGGER_REGISTRY.test (may read lorebook via ST APIs)
 */

import { TRIGGER_REGISTRY } from '../triggers.js';
import { ACTION_REGISTRY }  from '../actions/index.js';

async function runTrigger(trigger, text) {
    const def = TRIGGER_REGISTRY[trigger.type];
    if (!def) return null;
    try { return await def.test(text, trigger.config ?? {}); }
    catch (err) { console.warn('[triggeryze] trigger', trigger.type, 'threw', err); return null; }
}

export async function evaluateTriggers(rule, text) {
    if (!rule.triggers?.length) return null;

    if (rule.triggerLogic === 'all') {
        const results = await Promise.all(rule.triggers.map(t => runTrigger(t, text)));
        return results.every(r => r !== null) ? (results.find(r => r !== null) ?? null) : null;
    }

    for (const trigger of rule.triggers) {
        const matched = await runTrigger(trigger, text);
        if (matched !== null) return matched;
    }
    return null;
}

export function stageMatches(defStage, queryStage) {
    return Array.isArray(defStage) ? defStage.includes(queryStage) : defStage === queryStage;
}

export function ruleHasStage(rule, stage) {
    return rule.actions?.some(a => stageMatches(ACTION_REGISTRY[a.type]?.stage, stage));
}

export function getVarDeps(config, knownVars) {
    if (!knownVars.size) return [];
    const text = Object.values(config ?? {}).filter(v => typeof v === 'string').join(' ');
    return [...text.matchAll(/\{\{([^{}]+)\}\}/g)].map(m => m[1].trim()).filter(n => knownVars.has(n));
}
