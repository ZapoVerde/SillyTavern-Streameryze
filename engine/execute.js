/**
 * @file st-extensions/SillyTavern-Triggeryze/engine/execute.js
 * @stamp {"utc":"2026-07-01T00:00:00.000Z"}
 * @architectural-role Engine — action execution
 * @description
 * Owns the action-execution loop (executeActions). Each rule evaluator calls this
 * once when triggers are satisfied, at whatever point in the generation lifecycle
 * the trigger fires. Actions run as early as possible: actions whose template fields
 * use only immediately-available tokens (keyword, up-to, turn vars) execute right
 * away; actions whose templates reference {{message}} or {{paragraph}} await the
 * committed message text before executing. This lets a keyword rule start work the
 * moment its keyword appears in the stream without waiting for generation to end.
 *
 * Variable writes go through turn-state and automatically notify any subscribed rule
 * evaluators, producing the reactive cascade.
 *
 * @api-declaration
 * executeActions(rule, execCtx, getGenId) — runs all actions for a rule, each gated on its template tier
 *
 * @contract
 *   assertions:
 *     purity:          none — executes action registry entries which have arbitrary IO
 *     state_ownership: none
 *     external_io:     delegates all IO to ACTION_REGISTRY entries
 */

import { getVarDeps }                                               from './evaluate.js';
import { ACTION_REGISTRY }                                          from '../actions/index.js';
import { getTemplateTier }                                          from '../actions/template.js';
import { setTurnVar, getTurnVarsSnapshot }                          from '../triggers/turn-vars.js';
import { waitForMessageText, getMessageText, getMessageId }         from './turn-state.js';
import { trgLog, trgDev, trgError }                                from '../logger.js';

export async function executeActions(rule, execCtx, getGenId) {
    const allActions = (rule.actions ?? []).map((a, idx) => ({ a, idx }));
    if (!allActions.length) return;

    const capturedGenId       = getGenId();
    const isCurrentGeneration = () => getGenId() === capturedGenId;
    const vars  = { ...getTurnVarsSnapshot(rule._rulesetId), highlighted: execCtx.highlighted ?? '', 'chat_id': execCtx.stCtx?.chatId ?? '' };
    const debug = rule.devMode ?? false;

    trgDev(debug, `── rule "${rule.name ?? rule.id}" | keyword="${execCtx.matchedKeyword}" ──`);
    trgDev(debug, '  rule json:', JSON.stringify(rule, null, 2));

    const knownVars = new Set(allActions.map(({ a }) => a.config?.outputVar).filter(Boolean));
    const varReady  = new Map();
    for (const name of knownVars) {
        let resolve;
        varReady.set(name, { promise: new Promise(r => { resolve = r; }), resolve });
    }

    const runOne = async ({ a, idx }) => {
        const deps = getVarDeps(a.config, knownVars);
        trgLog('exec action', { idx, type: a.type, outputVar: a.config?.outputVar, deps });
        if (deps.length) {
            trgDev(debug, `  [${idx}] ${a.type} waiting for: [${deps.join(', ')}]`);
            await Promise.all(deps.map(d => varReady.get(d).promise));
            trgLog('exec action unblocked', { idx, type: a.type, vars: Object.fromEntries(deps.map(d => [d, (vars[d] ?? '').toString().slice(0, 40)])) });
            trgDev(debug, `  [${idx}] ${a.type} unblocked | vars:`, { ...vars });
        }

        const def = ACTION_REGISTRY[a.type];
        if (!def) return;

        // Gate on template tier — await committed message for message/paragraph-tier actions.
        const tier = getTemplateTier(def.templateFields?.(a.config) ?? []);
        if (tier !== 'immediate' && !getMessageText()) {
            await waitForMessageText();
            if (!isCurrentGeneration()) return;
        }

        // For message-tier actions fired before message was committed, refresh context.
        const ctx = (tier !== 'immediate')
            ? { ...execCtx, stCtx: window.SillyTavern?.getContext?.(), messageId: getMessageId() }
            : execCtx;

        const ruleName = rule.name ?? rule.id;
        trgLog('action', { ruleId: rule.id, type: a.type, actionIdx: idx, ...ctx });
        try {
            await def.execute(a.config ?? {}, { ...ctx, ruleId: rule.id, ruleName, actionIdx: idx, isCurrentGeneration, vars, debug });
        } catch (err) {
            trgError('action', a.type, 'threw', `(rule: ${ruleName})`, err);
        } finally {
            trgDev(debug, `  [${idx}] ${a.type} done | vars:`, { ...vars });
            if (a.config?.outputVar) {
                if (a.config.outputVar in vars) setTurnVar(a.config.outputVar, vars[a.config.outputVar], rule._rulesetId);
                varReady.get(a.config.outputVar)?.resolve();
            }
        }
    };

    await Promise.all(allActions.map(runOne));
}
