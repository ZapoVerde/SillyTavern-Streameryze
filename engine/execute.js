/**
 * @file st-extensions/SillyTavern-Triggeryze/engine/execute.js
 * @stamp {"utc":"2026-06-15T00:00:00.000Z"}
 * @architectural-role Engine — action execution and early streaming action pass
 * @description
 * Owns the action-execution loop (executeActions) and the early-action pass
 * (applyEarlyActions). The early-action pass fires side-effect-once postMessage
 * actions during streaming whenever their template tier is satisfied, so results
 * are visible before the stream ends. Text-preview actions write to live-patch.js's
 * _liveResults for immediate visual feedback without committing to msg.mes.
 *
 * @api-declaration
 * executeActions(rule, stage, execCtx, getGenId) — runs all stage-matching actions for a rule
 * applyEarlyActions(text, msgId, stCtx, getGenId) — early pass during streaming
 * clearEarlyFired()                               — reset early-fired set (call on GENERATION_STARTED)
 *
 * @contract
 *   assertions:
 *     purity:          none — executes action registry entries which have arbitrary IO
 *     state_ownership: [_earlyFired]
 *     external_io:     delegates all IO to ACTION_REGISTRY entries
 */

import { getSettings, getEnabledRules }                                     from '../settings/storage.js';
import { stageMatches, getVarDeps, evaluateTriggers }                       from './evaluate.js';
import { hasLiveResult, setLiveResult }                                     from './live-patch.js';
import { ACTION_REGISTRY, getTemplateTier, resolveLbTokens, interpolate }   from '../actions/index.js';
import { setTurnVar, getTurnVar, getTurnVarsSnapshot }   from '../triggers/turn-vars.js';
import { trgLog, trgDev, trgError }                                         from '../logger.js';

// Actions that ran early during streaming and must be skipped at postMessage.
const _earlyFired = new Set();

export function clearEarlyFired() { _earlyFired.clear(); }

function isOnceAction(a) {
    if (a.type === 'compose' || a.type === 'imageGen') return true;
    if (a.type === 'update' && (a.config?.target ?? 'lorebook') === 'lorebook') return true;
    return false;
}

function isLivePreviewAction(a) {
    if (a.type !== 'update' || (a.config?.target ?? 'lorebook') !== 'text') return false;
    const mode = a.config?.mode ?? 'replaceKeyword';
    return mode === 'replaceKeyword' || mode === 'replaceParagraph';
}

export async function executeActions(rule, stage, execCtx, getGenId) {
    const stageActions = (rule.actions ?? [])
        .map((a, idx) => ({ a, idx }))
        .filter(({ a }) => stageMatches(ACTION_REGISTRY[a.type]?.stage, stage));
    if (!stageActions.length) return;

    const capturedGenId       = getGenId();
    const isCurrentGeneration = () => getGenId() === capturedGenId;
    const vars  = { ...getTurnVarsSnapshot(rule._rulesetId), highlighted: execCtx.highlighted ?? '', 'chat_id': execCtx.stCtx?.chatId ?? '' };
    const debug = rule.devMode ?? false;

    trgDev(debug, `── rule "${rule.name ?? rule.id}" | ${stage} | keyword="${execCtx.matchedKeyword}" ──`);
    trgDev(debug, '  rule json:', JSON.stringify(rule, null, 2));

    const knownVars = new Set(stageActions.map(({ a }) => a.config?.outputVar).filter(Boolean));
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

        const earlyKey = `${rule.id}:${idx}`;
        if (_earlyFired.has(earlyKey)) {
            trgDev(debug, `  [${idx}] ${a.type} skipped (early-fired)`);
            if (a.config?.outputVar) {
                const recovered = getTurnVar(a.config.outputVar, rule._rulesetId);
                if (recovered !== undefined) vars[a.config.outputVar] = recovered;
                varReady.get(a.config.outputVar)?.resolve();
            }
            return;
        }

        const def = ACTION_REGISTRY[a.type];
        if (!def) return;
        trgLog('action', { ruleId: rule.id, type: a.type, actionIdx: idx, ...execCtx });
        try {
            await def.execute(a.config ?? {}, { ...execCtx, ruleId: rule.id, actionIdx: idx, isCurrentGeneration, vars, debug });
        } catch (err) {
            trgError('action', a.type, 'threw', err);
        } finally {
            trgDev(debug, `  [${idx}] ${a.type} done | vars:`, { ...vars });
            if (a.config?.outputVar) {
                if (a.config.outputVar in vars) setTurnVar(a.config.outputVar, vars[a.config.outputVar], rule._rulesetId);
                varReady.get(a.config.outputVar)?.resolve();
            }
        }
    };

    await Promise.all(stageActions.map(runOne));
}

export async function applyEarlyActions(text, streamingMessageId, stCtx, getGenId) {
    const s = getSettings();

    for (const rule of getEnabledRules(s)) {
        if (rule.triggers?.some(t => t.type === 'event' && t.config?.event === 'MESSAGE_RECEIVED')) continue;

        const ruleVars   = new Set((rule.actions ?? []).map(a => a.config?.outputVar).filter(Boolean));
        const candidates = (rule.actions ?? [])
            .map((a, idx) => ({ a, idx }))
            .filter(({ a }) => {
                const def = ACTION_REGISTRY[a.type];
                if (!def || !stageMatches(def.stage, 'postMessage')) return false;
                return isOnceAction(a) || isLivePreviewAction(a);
            });

        if (!candidates.length) continue;

        const tieredCandidates = candidates.filter(({ a, idx }) => {
            const key = `${rule.id}:${idx}`;
            if (_earlyFired.has(key) || hasLiveResult(key)) return false;
            if (getVarDeps(a.config, ruleVars).length > 0) return false;
            const tier = getTemplateTier(ACTION_REGISTRY[a.type].templateFields?.(a.config) ?? []);
            return tier !== 'message';
        });

        if (!tieredCandidates.length) continue;

        const matched = await evaluateTriggers(rule, text);
        if (matched === null) continue;

        const capturedGenId       = getGenId();
        const isCurrentGeneration = () => getGenId() === capturedGenId;
        const debug = rule.devMode ?? false;
        const vars  = { 'chat_id': stCtx?.chatId ?? '' };

        for (const { a, idx } of tieredCandidates) {
            const def  = ACTION_REGISTRY[a.type];
            const tier = getTemplateTier(def.templateFields?.(a.config) ?? []);
            const key  = `${rule.id}:${idx}`;

            if (tier === 'paragraph') {
                const kwEsc = matched.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const m     = new RegExp(kwEsc, 'i').exec(text);
                if (!m || text.indexOf('\n', m.index) === -1) continue;
            }

            if (isLivePreviewAction(a)) {
                try {
                    const kwEsc      = matched.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const firstMatch = new RegExp(kwEsc, 'i').exec(text);
                    const upTo       = firstMatch ? text.slice(0, firstMatch.index) : '';
                    const nlEnd      = text.indexOf('\n', firstMatch?.index ?? 0);
                    const para       = firstMatch
                        ? text.slice(text.lastIndexOf('\n', firstMatch.index - 1) + 1, nlEnd === -1 ? text.length : nlEnd)
                        : '';
                    const resolved = await resolveLbTokens(a.config?.value ?? '', matched, '', vars);
                    const value    = interpolate(resolved, { keyword: matched, message: text, 'up-to': upTo, paragraph: para }, vars);
                    setLiveResult(key, { keyword: matched, replacement: value, mode: a.config?.mode ?? 'replaceKeyword' });
                    trgLog('early live-preview computed', { key, mode: a.config?.mode });
                } catch (err) {
                    trgError('early live-preview', a.type, 'threw', err);
                }
                continue;
            }

            _earlyFired.add(key);
            try {
                await def.execute(a.config ?? {}, {
                    matchedKeyword: matched, messageId: streamingMessageId,
                    stCtx, vars, debug, isCurrentGeneration,
                });
                if (a.config?.outputVar && vars[a.config.outputVar] !== undefined)
                    setTurnVar(a.config.outputVar, vars[a.config.outputVar]);
                trgDev(debug, `  early-fired ${a.type} [${idx}]`);
            } catch (err) {
                trgError('early action', a.type, 'threw', err);
                _earlyFired.delete(key);
            }
        }
    }
}
