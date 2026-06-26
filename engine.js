/**
 * @file st-extensions/SillyTavern-Triggeryze/engine.js
 * @stamp {"utc":"2026-06-26T00:00:00.000Z"}
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
 * onChatLoaded()                        — fires event:CHAT_LOADED rules when a chat is opened or switched
 * onGenerationStarted()                 — clears dedup state, then fires event:GENERATION_STARTED rules
 * onStreamToken(text)                   — stream-stage rule loop + live patch passes
 * onMessageReceived(messageId)          — postMessage-stage rule loop (with recheck)
 * onCharacterMessageRendered(messageId) — badge rebuild + event:CHARACTER_MESSAGE_RENDERED rule dispatch
 * fireRuleManually(ruleId, msgId, highlighted, forcedMatchedKw?) — badge-triggered manual rule execution
 * cancelCurrentOperations()             — invalidate in-flight actions (called by clicking a thinking badge)
 * reinjectRuleBadges(messageId?)        — render or refresh rule badge buttons
 * reinjectInlineBadges(messageId?)      — inject or refresh inline keyword badge spans
 *
 * @contract
 *   assertions:
 *     purity:          none — owns _fired, _generationId; reads/writes DOM via sub-modules
 *     state_ownership: [_generationId, _fired, _firstTokenFired, _prevTurnAiId]
 *     external_io:     delegates all IO to engine/ sub-modules and badge.js
 */

import { getSettings, getEnabledRules }                                       from './settings/storage.js';
import { clearWiCache }                                from './triggers/lb-query.js';
import { clearTurnVars, setTurnVar }                  from './triggers/turn-vars.js';
import { setCurrentEvent, clearCurrentEvent }         from './triggers/event.js';
import { clearPrefetchCache, isDispatchActive }                              from './actions/index.js';
import { clearAllMessageBadges, ensureBadge, setBadge, renderRuleBadges, injectInlineBadges, reinjectAllInlineBadges, removeAllInlineBadges, startInlineBadgeRemovalWatcher, stopInlineBadgeRemovalWatcher } from './badge.js';
import { evaluateTriggers, ruleHasStage }                                     from './engine/evaluate.js';
import { stopPatchObserver, applyLivePatch, applyPrefetch, applyInlineBadgePatch, clearLivePatchState, highlightPendingKeyword, clearPendingHighlights } from './engine/live-patch.js';
import { executeActions, applyEarlyActions, clearEarlyFired }                from './engine/execute.js';
import { trgLog, trgPerf, trgDev }                                             from './logger.js';

let _generationId    = 0;
const _fired         = new Set();
let _firstTokenFired = false;
// Index of the last completed AI message before the current generation began.
// Set in onGenerationStarted; used to demolish that turn's badges on first token
// and to guard CHARACTER_MESSAGE_RENDERED from rebuilding them mid-generation.
let _prevTurnAiId    = -1;

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
                graph:       cfg.graph === true,
                compact:     cfg.compact === true,
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
            const def = {
                ruleId:        r.id,
                keywords:      cfg.keywords ?? '',
                caseSensitive: cfg.caseSensitive ?? false,
                color:         cfg.color ?? '#8888ff',
                clickAction:   cfg.clickAction || 'fire',
            };
            if (cfg.useRegex) { def.useRegex = true; def.pattern = cfg.pattern ?? ''; }
            return def;
        });
}

export function cancelCurrentOperations() {
    _generationId++;
    trgLog('operations cancelled — generation id bumped', { _generationId });
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
    trgLog('badge reinjectRuleBadges', { messageId, defs: defs.length });
    if (messageId !== null) { renderRuleBadges(messageId, defs); return; }
    const stCtx = window.SillyTavern?.getContext?.();
    if (!stCtx?.chat) return;
    stCtx.chat.forEach((_msg, idx) => renderRuleBadges(idx, defs));
}

export function reinjectInlineBadges(messageId = null) {
    const s    = getSettings();
    const defs = getInlineBadgeDefs(getEnabledRules(s));
    trgLog('badge reinjectInlineBadges', { messageId, defs: defs.length });
    if (messageId !== null) { injectInlineBadges(messageId, defs); return; }
    reinjectAllInlineBadges(defs);
}

export async function onGenerationStarted() {
    if (isDispatchActive()) return;
    stopInlineBadgeRemovalWatcher();
    _generationId++;
    _firstTokenFired = false;
    clearLivePatchState();
    _fired.clear();
    clearEarlyFired();
    clearPrefetchCache();
    clearWiCache();
    clearTurnVars();
    const stCtx = window.SillyTavern?.getContext?.();
    // Find the last completed AI message before this generation starts.
    // We scan backwards from the tail of chat, skipping any user message and
    // any AI placeholder that has no content yet (ST may have inserted an empty
    // slot before firing GENERATION_STARTED). The result is the message whose
    // badges should be demolished when the first token arrives.
    const _chat = stCtx?.chat ?? [];
    _prevTurnAiId = -1;
    for (let i = _chat.length - 1; i >= 0; i--) {
        if (!_chat[i]?.is_user && _chat[i]?.mes) { _prevTurnAiId = i; break; }
    }
    trgLog('generation started — dedup cleared', { prevTurnAiId: _prevTurnAiId });

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
            if (matched === null) { trgLog('no match (generationStarted)', { ruleId: rule.id }); continue; }
            trgLog('match (generationStarted)', { ruleId: rule.id, matched });
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
    if (!_firstTokenFired) {
        _firstTokenFired = true;
        // Demolish every badge on the previous AI turn in one call: status pill,
        // top rule buttons, bottom container, and inline keyword spans.
        // After this point, CHARACTER_MESSAGE_RENDERED is guarded (see below) so
        // ST cannot rebuild them for _prevTurnAiId during this generation.
        if (_prevTurnAiId >= 0) clearAllMessageBadges(_prevTurnAiId);
        // Global inline sweep: applyInlineBadgePatch may have grown inline badges
        // on other messages during the previous generation. Remove any that remain.
        removeAllInlineBadges();
    }
    const stCtx = window.SillyTavern?.getContext?.();

    for (const rule of getEnabledRules(s)) {
        if (!ruleHasStage(rule, 'stream')) continue;
        const key = `${rule.id}:stream`;
        if (_fired.has(key)) continue;

        const matched = await evaluateTriggers(rule, text);
        if (matched === null) { trgLog('no match (stream)', { ruleId: rule.id }); continue; }

        trgLog('match (stream)', { ruleId: rule.id, matched });
        _fired.add(key);
        await executeActions(rule, 'stream', { matchedKeyword: matched, stCtx }, () => _generationId);
    }

    const streamingMessageId = (stCtx?.chat?.length ?? 0) - 1;
    if (streamingMessageId >= 0) {
        await applyEarlyActions(text, streamingMessageId, stCtx, () => _generationId);
        await applyLivePatch(text, streamingMessageId, stCtx);
        await applyPrefetch(text, streamingMessageId, stCtx, () => _generationId);
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

    startInlineBadgeRemovalWatcher();
    setCurrentEvent('MESSAGE_RECEIVED');
    ensureBadge(messageId);
    const _enabledRules = getEnabledRules(s);
    for (const rule of _enabledRules) trgDev(rule.devMode, `[turn start] rule json: ${JSON.stringify(rule, null, 2)}`);
    trgLog('badge onMessageReceived', { messageId, enabledRules: _enabledRules.length, ruleBadgeDefs: getRuleBadgeDefs(_enabledRules).length, inlineDefs: getInlineBadgeDefs(_enabledRules).length });
    renderRuleBadges(messageId, getRuleBadgeDefs(_enabledRules));
    injectInlineBadges(messageId, getInlineBadgeDefs(_enabledRules));

    const firedThisCall   = new Set();
    const matchedKeywords = new Set();
    const tPostMsg        = performance.now();
    let rulesFired = 0;
    let anyFired   = true;
    const capturedGenId = _generationId;

    try {
        loop: while (anyFired) {
            anyFired = false;
            for (const rule of getEnabledRules(s)) {
                if (!ruleHasStage(rule, 'postMessage')) continue;
                const key = `${rule.id}:postMessage`;
                if (firedThisCall.has(key)) continue;

                const currentText = stCtx?.chat?.[messageId]?.mes ?? '';
                const matched = await evaluateTriggers(rule, currentText);
                if (matched === null) { trgLog('no match (postMessage)', { ruleId: rule.id }); continue; }

                trgLog('match (postMessage)', { ruleId: rule.id, matched });
                _fired.add(key);
                firedThisCall.add(key);
                anyFired = true;
                rulesFired++;
                matchedKeywords.add(matched);
                setBadge(messageId, 'thinking');
                await executeActions(rule, 'postMessage', { matchedKeyword: matched, messageId, stCtx }, () => _generationId);
                setBadge(messageId, 'modified');
                if (_generationId !== capturedGenId) { trgLog('postMessage cancelled — breaking loop', { messageId }); break loop; }
            }
        }
    } finally {
        clearCurrentEvent();
    }

    // Re-render rule badges now that compose actions have populated turn vars (e.g. layer_bars).
    trgLog('badge post-loop re-render', { messageId });
    renderRuleBadges(messageId, getRuleBadgeDefs(getEnabledRules(s)));
    // Re-inject inline badges after yielding to the event loop so ST has a chance to commit
    // its final markdown-rendered DOM before we walk text nodes.
    setTimeout(() => { trgLog('badge setTimeout inline re-inject', { messageId }); injectInlineBadges(messageId, getInlineBadgeDefs(getEnabledRules(s))); }, 0);

    if (matchedKeywords.size) {
        const mesTextEl = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
        if (mesTextEl) {
            for (const kw of matchedKeywords) highlightPendingKeyword(mesTextEl, kw);
        }
    }
    if (rulesFired > 0) {
        trgPerf(`postMessage | rules=${rulesFired} | elapsed=${Math.round(performance.now() - tPostMsg)}ms`);
    }

    for (const rule of getEnabledRules(s)) {
        if (!ruleHasStage(rule, 'stream')) continue;
        const key = `${rule.id}:stream`;
        if (_fired.has(key)) continue;

        const matched = await evaluateTriggers(rule, text);
        if (matched === null) { trgLog('no match (stream/non-streaming)', { ruleId: rule.id }); continue; }

        trgLog('match (stream/non-streaming)', { ruleId: rule.id, matched });
        _fired.add(key);
        await executeActions(rule, 'stream', { matchedKeyword: matched, stCtx }, () => _generationId);
    }
}

export async function onMessageSwiped(messageId) {
    _generationId++;
    clearLivePatchState();
    clearTurnVars();
    const s = getSettings();
    if (!s?.enabled) return;
    const candidates = getEnabledRules(s).filter(r =>
        r.triggers?.some(t => t.type === 'event' && t.config?.event === 'MESSAGE_SWIPED')
    );
    if (!candidates.length) return;
    const stCtx = window.SillyTavern?.getContext?.();
    setCurrentEvent('MESSAGE_SWIPED');
    try {
        for (const rule of candidates) {
            if (!ruleHasStage(rule, 'postMessage')) continue;
            const matched = await evaluateTriggers(rule, '');
            if (matched === null) { trgLog('no match (messageSwiped)', { ruleId: rule.id }); continue; }
            trgLog('match (messageSwiped)', { ruleId: rule.id, matched });
            await executeActions(rule, 'postMessage', { matchedKeyword: matched, messageId, stCtx }, () => _generationId);
        }
    } finally {
        clearCurrentEvent();
    }
}

export async function onChatLoaded() {
    clearTurnVars();
    const s = getSettings();
    if (!s?.enabled) return;
    const candidates = getEnabledRules(s).filter(r =>
        r.triggers?.some(t => t.type === 'event' && t.config?.event === 'CHAT_LOADED')
    );
    if (!candidates.length) return;
    const stCtx = window.SillyTavern?.getContext?.();
    setCurrentEvent('CHAT_LOADED');
    try {
        for (const rule of candidates) {
            if (!ruleHasStage(rule, 'postMessage')) continue;
            const matched = await evaluateTriggers(rule, '');
            if (matched === null) { trgLog('no match (chatLoaded)', { ruleId: rule.id }); continue; }
            trgLog('match (chatLoaded)', { ruleId: rule.id, matched });
            await executeActions(rule, 'postMessage', { matchedKeyword: matched, stCtx }, () => _generationId);
        }
    } finally {
        clearCurrentEvent();
    }
}

/**
 * Rebuild all badge types for one message from current settings.
 *
 * This is the single "reconstruct" counterpart to clearAllMessageBadges.
 * Call it whenever ST re-renders a message that is not the demolished
 * previous-turn message.
 *
 * Why inline badges are NOT different here: for historical/completed messages,
 * injectInlineBadges runs once on the final text — no growth tracking needed.
 * Per-token inline growth only applies to the actively streaming message and
 * is handled separately by applyInlineBadgePatch (which chases the live buffer).
 */
async function _renderAllBadgesForMessage(messageId) {
    const enabledRules = getEnabledRules(getSettings());
    ensureBadge(messageId);
    renderRuleBadges(messageId, getRuleBadgeDefs(enabledRules));
    await injectInlineBadges(messageId, getInlineBadgeDefs(enabledRules));
}

export async function onCharacterMessageRendered(messageId) {
    const s = getSettings();
    if (!s?.enabled) return;

    // GUARD: once the first token of the current generation has landed, the
    // previous AI turn's badges were demolished in onStreamToken. ST can re-fire
    // CHARACTER_MESSAGE_RENDERED for that message (e.g. after a context-menu
    // action re-renders it). Block all badge injection so the demolition sticks
    // for the full duration of this generation.
    if (_firstTokenFired && messageId === _prevTurnAiId) return;

    // Rebuild badge state for any non-demolished message that ST has re-rendered.
    // Runs for historical messages too: on page load ST fires this for every
    // message, and CHAT_CHANGED alone cannot cover mid-session re-renders.
    await _renderAllBadgesForMessage(messageId);

    // RULE DISPATCH: CHARACTER_MESSAGE_RENDERED rules are turn-scoped — only fire
    // for the most recent AI message. Historical re-renders skip dispatch so rules
    // don't fire repeatedly as the user scrolls or ST repaints old messages.
    const stCtx = window.SillyTavern?.getContext?.();
    const chat   = stCtx?.chat ?? [];
    const lastAiId = chat.reduce((max, msg, idx) => (!msg.is_user ? idx : max), -1);
    if (lastAiId < 0 || messageId !== lastAiId) return;

    const candidates = getEnabledRules(s).filter(r =>
        r.triggers?.some(t => t.type === 'event' && t.config?.event === 'CHARACTER_MESSAGE_RENDERED')
    );
    if (!candidates.length) return;
    setCurrentEvent('CHARACTER_MESSAGE_RENDERED');
    try {
        for (const rule of candidates) {
            if (!ruleHasStage(rule, 'postMessage')) continue;
            const key = `${rule.id}:charRendered:${messageId}`;
            if (_fired.has(key)) continue;
            const matched = await evaluateTriggers(rule, '');
            if (matched === null) { trgLog('no match (charRendered)', { ruleId: rule.id }); continue; }
            trgLog('match (charRendered)', { ruleId: rule.id, matched });
            _fired.add(key);
            await executeActions(rule, 'postMessage', { matchedKeyword: matched, messageId, stCtx }, () => _generationId);
        }
    } finally {
        clearCurrentEvent();
    }
}
