/**
 * @file st-extensions/SillyTavern-Triggeryze/engine.js
 * @stamp {"utc":"2026-06-15T00:00:00.000Z"}
 * @architectural-role Engine — rule dispatch orchestrator
 * @description
 * Owns per-generation dedup state and routes GENERATION_STARTED / STREAM_TOKEN_RECEIVED /
 * MESSAGE_RECEIVED events through the active rule list. No trigger evaluation, action
 * execution, or DOM patching logic lives here; those are delegated to engine/ sub-modules.
 *
 * For each event:
 *   1. Collect rules whose actions include the current stage.
 *   2. Skip rules already fired this generation (dedup via _fired).
 *   3. Evaluate triggers, then on a match dispatch to executeActions.
 *
 * @api-declaration
 * onGenerationStarted()                 — clears dedup state and all sub-module caches
 * onStreamToken(text)                   — stream-stage rule loop + live patch passes
 * onMessageReceived(messageId)          — postMessage-stage rule loop (with recheck)
 * fireRuleManually(ruleId, msgId, highlighted) — badge-triggered manual rule execution
 * reinjectRuleBadges(messageId?)        — render or refresh rule badge buttons
 *
 * @contract
 *   assertions:
 *     purity:          none — owns _fired, _generationId; reads/writes DOM via sub-modules
 *     state_ownership: [_generationId, _fired]
 *     external_io:     delegates all IO to engine/ sub-modules and badge.js
 */

import { getSettings }                                                       from './settings/storage.js';
import { clearWiCache, setChatComplete, clearTurnVars }                      from './triggers.js';
import { clearPrefetchCache, isDispatchActive }                              from './actions/index.js';
import { ensureBadge, setBadge, renderRuleBadges }                           from './badge.js';
import { evaluateTriggers, ruleHasStage }                                    from './engine/evaluate.js';
import { stopPatchObserver, applyLivePatch, applyPrefetch, clearLivePatchState, highlightPendingKeyword, clearPendingHighlights } from './engine/live-patch.js';
import { executeActions, applyEarlyActions, clearEarlyFired }                from './engine/execute.js';

let _generationId = 0;
const _fired      = new Set();

const log = (tag, ...args) => { if (getSettings()?.verbose) console.log(`[triggeryze] ${tag}`, ...args); };

function getRuleBadgeDefs(rules) {
    return (rules ?? [])
        .filter(r => r.enabled && r.triggers?.some(t => t.type === 'badgeTrigger'))
        .map(r => {
            const cfg = r.triggers.find(t => t.type === 'badgeTrigger')?.config ?? {};
            return { ruleId: r.id, label: cfg.label || r.name || 'run', color: cfg.color || null };
        });
}

export async function fireRuleManually(ruleId, messageId, highlighted = '') {
    const s = getSettings();
    if (!s?.enabled) return;
    const rule = (s.rules ?? []).find(r => r.id === ruleId && r.enabled);
    if (!rule) return;
    const stCtx = window.SillyTavern?.getContext?.();
    const label = rule.triggers?.find(t => t.type === 'badgeTrigger')?.config?.label ?? 'badge';
    setBadge(messageId, 'thinking');
    try {
        await executeActions(rule, 'postMessage', { matchedKeyword: label, messageId, stCtx, highlighted }, () => _generationId);
    } finally {
        setBadge(messageId, 'modified');
    }
}

export function reinjectRuleBadges(messageId = null) {
    const s    = getSettings();
    const defs = getRuleBadgeDefs(s?.rules);
    if (messageId !== null) { renderRuleBadges(messageId, defs); return; }
    const stCtx = window.SillyTavern?.getContext?.();
    if (!stCtx?.chat) return;
    stCtx.chat.forEach((_msg, idx) => renderRuleBadges(idx, defs));
}

export function onGenerationStarted() {
    if (isDispatchActive()) return;
    _generationId++;
    clearLivePatchState();
    _fired.clear();
    clearEarlyFired();
    clearPrefetchCache();
    clearWiCache();
    clearTurnVars();
    setChatComplete(false);
    const stCtx = window.SillyTavern?.getContext?.();
    const lastId = (stCtx?.chat?.length ?? 0) - 1;
    if (lastId >= 0) setBadge(lastId, 'unchanged');
    log('generation started — dedup cleared');
}

export async function onStreamToken(text) {
    const s = getSettings();
    if (!s?.enabled) return;
    const stCtx = window.SillyTavern?.getContext?.();

    for (const rule of (s.rules ?? [])) {
        if (!rule.enabled || !ruleHasStage(rule, 'stream')) continue;
        const key = `${rule.id}:stream`;
        if (_fired.has(key)) continue;

        const matched = await evaluateTriggers(rule, text);
        if (matched === null) { log('no match (stream)', { ruleId: rule.id }); continue; }

        log('match (stream)', { ruleId: rule.id, matched });
        _fired.add(key);
        await executeActions(rule, 'stream', { matchedKeyword: matched, stCtx }, () => _generationId);
    }

    const streamingMessageId = (stCtx?.chat?.length ?? 0) - 1;
    if (streamingMessageId >= 0) {
        await applyLivePatch(text, streamingMessageId, stCtx);
        await applyPrefetch(text, streamingMessageId, stCtx, () => _generationId);
        await applyEarlyActions(text, streamingMessageId, stCtx, () => _generationId);
    }
}

export async function onMessageReceived(messageId) {
    const s = getSettings();
    if (!s?.enabled) return;
    stopPatchObserver();
    clearPendingHighlights();
    const stCtx = window.SillyTavern?.getContext?.();
    const text  = stCtx?.chat?.[messageId]?.mes ?? '';

    setChatComplete(true);
    ensureBadge(messageId);
    renderRuleBadges(messageId, getRuleBadgeDefs(s?.rules));

    const firedThisCall   = new Set();
    const matchedKeywords = new Set();
    const tPostMsg        = performance.now();
    let rulesFired = 0;
    let anyFired   = true;

    while (anyFired) {
        anyFired = false;
        for (const rule of (s.rules ?? [])) {
            if (!rule.enabled || !ruleHasStage(rule, 'postMessage')) continue;
            const key = `${rule.id}:postMessage`;
            if (firedThisCall.has(key)) continue;

            const currentText = stCtx?.chat?.[messageId]?.mes ?? '';
            const matched = await evaluateTriggers(rule, currentText);
            if (matched === null) { log('no match (postMessage)', { ruleId: rule.id }); continue; }

            log('match (postMessage)', { ruleId: rule.id, matched });
            _fired.add(key);
            firedThisCall.add(key);
            anyFired = true;
            rulesFired++;
            matchedKeywords.add(matched);
            setBadge(messageId, 'thinking');
            await executeActions(rule, 'postMessage', { matchedKeyword: matched, messageId, stCtx }, () => _generationId);
            setBadge(messageId, 'modified');
        }
    }

    if (matchedKeywords.size) {
        const mesTextEl = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
        if (mesTextEl) {
            for (const kw of matchedKeywords) highlightPendingKeyword(mesTextEl, kw);
        }
    }
    if (rulesFired > 0) {
        console.info(`[TRG:PERF] postMessage | rules=${rulesFired} | elapsed=${Math.round(performance.now() - tPostMsg)}ms`);
    }

    if (!s.nonStreaming) return;

    for (const rule of (s.rules ?? [])) {
        if (!rule.enabled || !ruleHasStage(rule, 'stream')) continue;
        const key = `${rule.id}:stream`;
        if (_fired.has(key)) continue;

        const matched = await evaluateTriggers(rule, text);
        if (matched === null) { log('no match (stream/non-streaming)', { ruleId: rule.id }); continue; }

        log('match (stream/non-streaming)', { ruleId: rule.id, matched });
        _fired.add(key);
        await executeActions(rule, 'stream', { matchedKeyword: matched, stCtx }, () => _generationId);
    }
}
