/**
 * @file st-extensions/SillyTavern-Triggeryze/engine.js
 * @stamp {"utc":"2026-06-16T00:00:00.000Z"}
 * @architectural-role Engine — rule dispatch orchestrator
 * @description
 * Owns per-generation dedup state and routes GENERATION_STARTED / STREAM_TOKEN_RECEIVED /
 * MESSAGE_RECEIVED events through the active rule list. No trigger evaluation, action
 * execution, or DOM patching logic lives here; those are delegated to engine/ sub-modules.
 *
 * Rules are stored in rulesets (see storage.js). The engine never works with rulesets
 * directly — it calls getEnabledRules(s) to receive a flat pre-filtered list, identical
 * in shape to the old s.rules array.
 *
 * For each event:
 *   1. Collect rules whose actions include the current stage.
 *   2. Skip rules already fired this generation (dedup via _fired).
 *   3. Evaluate triggers, then on a match dispatch to executeActions.
 *
 * @api-declaration
 * onGenerationStarted()                 — clears dedup state, then fires event:GENERATION_STARTED rules
 * onStreamToken(text)                   — stream-stage rule loop + live patch passes
 * onMessageReceived(messageId)          — postMessage-stage rule loop (with recheck)
 * onCharacterMessageRendered(messageId) — fires event:CHARACTER_MESSAGE_RENDERED rules for a message
 * fireRuleManually(ruleId, msgId, highlighted, forcedMatchedKw?) — badge-triggered manual rule execution
 * reinjectRuleBadges(messageId?)        — render or refresh rule badge buttons
 * reinjectInlineBadges(messageId?)      — inject or refresh inline keyword badge spans
 *
 * @contract
 *   assertions:
 *     purity:          none — owns _fired, _generationId; reads/writes DOM via sub-modules
 *     state_ownership: [_generationId, _fired]
 *     external_io:     delegates all IO to engine/ sub-modules and badge.js
 */

import { getSettings, getEnabledRules }                                       from './settings/storage.js';
import { clearWiCache }                                from './triggers/lb-query.js';
import { clearTurnVars }                              from './triggers/turn-vars.js';
import { setCurrentEvent, clearCurrentEvent }         from './triggers/event.js';
import { clearPrefetchCache, isDispatchActive }                              from './actions/index.js';
import { ensureBadge, setBadge, renderRuleBadges, injectInlineBadges, reinjectAllInlineBadges, removeAllInlineBadges } from './badge.js';
import { evaluateTriggers, ruleHasStage }                                     from './engine/evaluate.js';
import { stopPatchObserver, applyLivePatch, applyPrefetch, applyInlineBadgePatch, clearLivePatchState, highlightPendingKeyword, clearPendingHighlights } from './engine/live-patch.js';
import { executeActions, applyEarlyActions, clearEarlyFired }                from './engine/execute.js';

let _generationId = 0;
const _fired      = new Set();

const log = (tag, ...args) => { if (getSettings()?.verbose) console.log(`[triggeryze] ${tag}`, ...args); };

function _isBadgeTrigger(t) {
    return t.type === 'badge' && t.config?.style !== 'inline' || t.type === 'badgeTrigger';
}
function _isInlineTrigger(t) {
    return t.type === 'badge' && t.config?.style === 'inline' || t.type === 'inlineBadge';
}

function getRuleBadgeDefs(rules) {
    return (rules ?? [])
        .filter(r => r.enabled && r.triggers?.some(_isBadgeTrigger))
        .map(r => {
            const t   = r.triggers.find(_isBadgeTrigger);
            const cfg = t?.config ?? {};
            const legacy = t?.type === 'badgeTrigger';
            return {
                ruleId:      r.id,
                label:       cfg.label || r.name || 'run',
                color:       cfg.color || '#8888ff',
                style:       legacy ? 'top' : (cfg.style || 'top'),
                splitOn:     cfg.splitOn || '',
                clickAction: cfg.clickAction || 'fire',
            };
        });
}

function getInlineBadgeDefs(rules) {
    return (rules ?? [])
        .filter(r => r.enabled && r.triggers?.some(_isInlineTrigger))
        .map(r => {
            const cfg = r.triggers.find(_isInlineTrigger)?.config ?? {};
            return {
                ruleId:        r.id,
                keywords:      cfg.keywords ?? '',
                caseSensitive: cfg.caseSensitive ?? false,
                color:         cfg.color ?? '#8888ff',
                clickAction:   cfg.clickAction || 'fire',
            };
        });
}

export async function fireRuleManually(ruleId, messageId, highlighted = '', forcedMatchedKw = null) {
    const s = getSettings();
    if (!s?.enabled) return;
    const rule = getEnabledRules(s).find(r => r.id === ruleId);
    if (!rule) return;
    const stCtx = window.SillyTavern?.getContext?.();
    const defaultLabel = rule.triggers?.find(t => t.type === 'badge' || t.type === 'badgeTrigger')?.config?.label ?? 'badge';
    const matchedKeyword = forcedMatchedKw ?? defaultLabel;
    setBadge(messageId, 'thinking');
    try {
        await executeActions(rule, 'postMessage', { matchedKeyword, messageId, stCtx, highlighted }, () => _generationId);
    } finally {
        setBadge(messageId, 'modified');
    }
}

export function reinjectRuleBadges(messageId = null) {
    const s    = getSettings();
    const defs = getRuleBadgeDefs(getEnabledRules(s));
    if (messageId !== null) { renderRuleBadges(messageId, defs); return; }
    const stCtx = window.SillyTavern?.getContext?.();
    if (!stCtx?.chat) return;
    stCtx.chat.forEach((_msg, idx) => renderRuleBadges(idx, defs));
}

export function reinjectInlineBadges(messageId = null) {
    const s    = getSettings();
    const defs = getInlineBadgeDefs(getEnabledRules(s));
    if (messageId !== null) { injectInlineBadges(messageId, defs); return; }
    reinjectAllInlineBadges(defs);
}

export async function onGenerationStarted() {
    if (isDispatchActive()) return;
    _generationId++;
    removeAllInlineBadges();
    clearLivePatchState();
    _fired.clear();
    clearEarlyFired();
    clearPrefetchCache();
    clearWiCache();
    clearTurnVars();
    const stCtx = window.SillyTavern?.getContext?.();
    const lastId = (stCtx?.chat?.length ?? 0) - 1;
    if (lastId >= 0) setBadge(lastId, 'unchanged');
    log('generation started — dedup cleared');

    const s = getSettings();
    if (!s?.enabled) return;
    const candidates = getEnabledRules(s).filter(r =>
        r.triggers?.some(t => t.type === 'event' && t.config?.event === 'GENERATION_STARTED')
    );
    if (!candidates.length) return;
    setCurrentEvent('GENERATION_STARTED');
    try {
        for (const rule of candidates) {
            if (!ruleHasStage(rule, 'postMessage')) continue;
            const key = `${rule.id}:generationStarted`;
            if (_fired.has(key)) continue;
            const matched = await evaluateTriggers(rule, '');
            if (matched === null) { log('no match (generationStarted)', { ruleId: rule.id }); continue; }
            log('match (generationStarted)', { ruleId: rule.id, matched });
            _fired.add(key);
            await executeActions(rule, 'postMessage', { matchedKeyword: matched, stCtx }, () => _generationId);
        }
    } finally {
        clearCurrentEvent();
    }
}

export async function onStreamToken(text) {
    const s = getSettings();
    if (!s?.enabled) return;
    const stCtx = window.SillyTavern?.getContext?.();

    for (const rule of getEnabledRules(s)) {
        if (!ruleHasStage(rule, 'stream')) continue;
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
        await applyInlineBadgePatch(streamingMessageId, getInlineBadgeDefs(getEnabledRules(s)));
    }
}

export async function onMessageReceived(messageId) {
    const s = getSettings();
    if (!s?.enabled) return;
    stopPatchObserver();
    clearPendingHighlights();
    const stCtx = window.SillyTavern?.getContext?.();
    const text  = stCtx?.chat?.[messageId]?.mes ?? '';

    setCurrentEvent('MESSAGE_RECEIVED');
    ensureBadge(messageId);
    renderRuleBadges(messageId, getRuleBadgeDefs(getEnabledRules(s)));
    injectInlineBadges(messageId, getInlineBadgeDefs(getEnabledRules(s)));

    const firedThisCall   = new Set();
    const matchedKeywords = new Set();
    const tPostMsg        = performance.now();
    let rulesFired = 0;
    let anyFired   = true;

    try {
        while (anyFired) {
            anyFired = false;
            for (const rule of getEnabledRules(s)) {
                if (!ruleHasStage(rule, 'postMessage')) continue;
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
    } finally {
        clearCurrentEvent();
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

    for (const rule of getEnabledRules(s)) {
        if (!ruleHasStage(rule, 'stream')) continue;
        const key = `${rule.id}:stream`;
        if (_fired.has(key)) continue;

        const matched = await evaluateTriggers(rule, text);
        if (matched === null) { log('no match (stream/non-streaming)', { ruleId: rule.id }); continue; }

        log('match (stream/non-streaming)', { ruleId: rule.id, matched });
        _fired.add(key);
        await executeActions(rule, 'stream', { matchedKeyword: matched, stCtx }, () => _generationId);
    }
}

export async function onCharacterMessageRendered(messageId) {
    const s = getSettings();
    if (!s?.enabled) return;
    const candidates = getEnabledRules(s).filter(r =>
        r.triggers?.some(t => t.type === 'event' && t.config?.event === 'CHARACTER_MESSAGE_RENDERED')
    );
    if (!candidates.length) return;
    const stCtx = window.SillyTavern?.getContext?.();
    // Triggeryze is turn-scoped — only fire for the last AI message in the chat.
    // On page load ST fires CHARACTER_MESSAGE_RENDERED for every historical message;
    // this guard ensures only the most recent completed turn triggers rules.
    const chat = stCtx?.chat ?? [];
    const lastAiId = chat.reduce((max, msg, idx) => (!msg.is_user ? idx : max), -1);
    if (lastAiId < 0 || messageId !== lastAiId) return;
    setCurrentEvent('CHARACTER_MESSAGE_RENDERED');
    try {
        for (const rule of candidates) {
            if (!ruleHasStage(rule, 'postMessage')) continue;
            const key = `${rule.id}:charRendered:${messageId}`;
            if (_fired.has(key)) continue;
            const matched = await evaluateTriggers(rule, '');
            if (matched === null) { log('no match (charRendered)', { ruleId: rule.id }); continue; }
            log('match (charRendered)', { ruleId: rule.id, matched });
            _fired.add(key);
            await executeActions(rule, 'postMessage', { matchedKeyword: matched, messageId, stCtx }, () => _generationId);
        }
    } finally {
        clearCurrentEvent();
    }
}
