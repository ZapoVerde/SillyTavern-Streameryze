/**
 * @file st-extensions/SillyTavern-Triggeryze/engine.js
 * @stamp {"utc":"2026-06-13T00:00:00.000Z"}
 * @architectural-role Orchestrator
 * @description
 * Rule evaluation engine. Owns the per-generation dedup state and routes
 * stream and postMessage events through the active rule list.
 *
 * For each event:
 *   1. Collect rules whose actions include the current stage.
 *   2. Skip rules already fired this generation (dedup).
 *   3. Evaluate the rule's triggers against the event text, applying
 *      AND/OR logic as configured.
 *   4. On a match, execute all actions at the current stage and mark
 *      the rule as fired.
 *
 * Live stream patch:
 *   ST fires STREAM_TOKEN_RECEIVED *before* onProgressStreaming updates the DOM.
 *   A direct .mes_text write during the event would always be one token behind —
 *   ST immediately overwrites it. Instead:
 *     1. The engine precomputes corrected HTML during the event and stores it.
 *     2. A MutationObserver on .mes_text fires as a microtask after ST's innerHTML
 *        write, before the browser paints. It stamps the precomputed correction.
 *   This eliminates the raw/corrected alternation visible in each streaming frame.
 *   Anchoring (split-and-advance) keeps per-token work proportional to suffix
 *   length only — no full-text regex passes after the first match.
 *   The authoritative replacement still happens in onMessageReceived.
 *
 * The engine does not know what any specific trigger or action does.
 * It dispatches; the registries implement.
 *
 * @api-declaration
 * onGenerationStarted() — clears dedup state, WI cache, and live-patch anchors
 * onStreamToken(text)   — evaluates stream-stage rules + live patch
 * onMessageReceived(id) — evaluates postMessage-stage rules
 *
 * @contract
 *   assertions:
 *     purity:          owns _fired Set and _livePatches Map; no other state
 *     state_ownership: [_fired, _livePatches]
 *     external_io:     delegates all IO to action registry entries
 */

import { messageFormatting }     from '../../../../script.js';
import { extension_settings }   from '../../../extensions.js';
import { TRIGGER_REGISTRY, clearWiCache, setChatComplete, setTurnVar, clearTurnVars } from './triggers.js';
import { ACTION_REGISTRY, clearPrefetchCache, prefetchSideCall, getPrefetchedResults, isDispatchActive, resolveLbTokens } from './actions.js';
import { ensureBadge, setBadge, renderRuleBadges } from './badge.js';

const EXT_NAME = 'triggeryze';

// Incremented on every GENERATION_STARTED (including swipes).
// Passed into executeActions so sideCall.execute can detect staleness.
let _generationId = 0;

// Per-generation dedup. Keyed by "{ruleId}:{stage}".
// A rule fires at most once per stage per generation.
const _fired = new Set();

// Per-generation live-patch anchors.
// Shape: Map<ruleId, { keyword: string, patchedPrefix: string, origLength: number }>
const _livePatches = new Map();

// MutationObserver for the streaming message's .mes_text.
// ST fires STREAM_TOKEN_RECEIVED *before* it writes to the DOM (onProgressStreaming
// runs after the event). We can't correct text we haven't seen yet, so we precompute
// the corrected HTML during the event and store it here. The observer fires as a
// microtask immediately after ST's innerHTML write, before the browser paints.
let _pendingPatchHtml      = null;  // corrected HTML ready to stamp
let _patchObserver         = null;  // active MutationObserver
let _patchObserverMsgId    = -1;    // message ID currently being watched
let _patchObserverApplying = false; // re-entrancy guard

// Pending keyword highlights: sideCall rules that have fired a prefetch but
// whose result has not yet been applied. The observer wraps these in
// .trg-pending-kw spans on each ST render so the user sees something is in flight.
// Keyed by `${ruleId}:${actionIdx}`, value is the matched keyword string.
const _pendingHighlights = new Map();

// Settled sideCall results ready for live display (replaceKeyword / replaceParagraph).
// Applied to displayText on every subsequent token so the result stays visible
// while streaming continues. msg.mes is still written at postMessage.
// Keyed by `${ruleId}:${actionIdx}`, shape: { keyword, replacement, mode }.
const _liveResults = new Map();

/**
 * Wraps every occurrence of `keyword` inside mesTextEl in a .trg-pending-kw span.
 * Skips text nodes inside pre/code/a/.trg-pending-kw to avoid double-wrapping.
 */
function highlightPendingKeyword(mesTextEl, keyword) {
    if (!keyword) return;
    const re = new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const walker = document.createTreeWalker(mesTextEl, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (node.parentElement?.closest('pre, code, a, .trg-pending-kw')) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        },
    });
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    for (const node of nodes) {
        const txt = node.nodeValue;
        re.lastIndex = 0;
        if (!re.test(txt)) continue;
        re.lastIndex = 0;
        const frag = document.createDocumentFragment();
        let last = 0, m;
        while ((m = re.exec(txt)) !== null) {
            if (m.index > last) frag.appendChild(document.createTextNode(txt.slice(last, m.index)));
            const span = document.createElement('span');
            span.className = 'trg-pending-kw';
            span.textContent = m[0];
            frag.appendChild(span);
            last = m.index + m[0].length;
        }
        if (last < txt.length) frag.appendChild(document.createTextNode(txt.slice(last)));
        node.parentNode.replaceChild(frag, node);
    }
}

function startPatchObserver(messageId) {
    if (_patchObserverMsgId === messageId) return;
    stopPatchObserver();
    const mesTextEl = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
    if (!mesTextEl) return;
    _patchObserverMsgId = messageId;
    _patchObserver = new MutationObserver(() => {
        if (_patchObserverApplying) return;
        if (!_pendingPatchHtml && !_pendingHighlights.size) return;
        _patchObserverApplying = true;
        if (_pendingPatchHtml) {
            mesTextEl.innerHTML = _pendingPatchHtml;
            _pendingPatchHtml = null;
        }
        for (const kw of _pendingHighlights.values()) {
            highlightPendingKeyword(mesTextEl, kw);
        }
        _patchObserverApplying = false;
    });
    _patchObserver.observe(mesTextEl, { childList: true, subtree: true, characterData: true });
}

function stopPatchObserver() {
    _patchObserver?.disconnect();
    _patchObserver         = null;
    _patchObserverMsgId    = -1;
    _pendingPatchHtml      = null;
    _patchObserverApplying = false;
}

function getSettings()        { return extension_settings[EXT_NAME]; }
function log(tag, ...args)    { if (getSettings()?.verbose) console.log(`[${EXT_NAME}] ${tag}`, ...args); }

// ---------------------------------------------------------------------------
// Trigger evaluation
// ---------------------------------------------------------------------------

async function runTrigger(trigger, text) {
    const def = TRIGGER_REGISTRY[trigger.type];
    if (!def) return null;
    try { return await def.test(text, trigger.config ?? {}); }
    catch (err) { console.warn(`[${EXT_NAME}] trigger ${trigger.type} threw`, err); return null; }
}

async function evaluateTriggers(rule, text) {
    if (!rule.triggers?.length) return null;

    if (rule.triggerLogic === 'all') {
        // AND — every trigger must match; return first matched keyword
        const results = await Promise.all(rule.triggers.map(t => runTrigger(t, text)));
        return results.every(r => r !== null) ? (results.find(r => r !== null) ?? null) : null;
    }

    // OR (default) — first match wins
    for (const trigger of rule.triggers) {
        const matched = await runTrigger(trigger, text);
        if (matched !== null) return matched;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Action execution
// ---------------------------------------------------------------------------

function stageMatches(defStage, queryStage) {
    return Array.isArray(defStage) ? defStage.includes(queryStage) : defStage === queryStage;
}

function ruleHasStage(rule, stage) {
    return rule.actions?.some(a => stageMatches(ACTION_REGISTRY[a.type]?.stage, stage));
}

// Returns the subset of knownVars referenced as {{varName}} in any string config field.
function getVarDeps(config, knownVars) {
    if (!knownVars.size) return [];
    const text = Object.values(config ?? {}).filter(v => typeof v === 'string').join(' ');
    return [...text.matchAll(/\{\{([^{}]+)\}\}/g)].map(m => m[1].trim()).filter(n => knownVars.has(n));
}

async function executeActions(rule, stage, execCtx) {
    const stageActions = (rule.actions ?? [])
        .map((a, idx) => ({ a, idx }))
        .filter(({ a }) => stageMatches(ACTION_REGISTRY[a.type]?.stage, stage));
    if (!stageActions.length) return;

    const capturedGenId = _generationId;
    const isCurrentGeneration = () => _generationId === capturedGenId;
    const vars = {};
    const debug = rule.devMode ?? false;

    if (debug) console.log(`[TRG:dev] ── rule "${rule.name ?? rule.id}" | ${stage} | keyword="${execCtx.matchedKeyword}" ──`);

    // For each outputVar declared in this stage, create a deferred promise.
    // Actions await the deferreds for the vars they consume, so a downstream
    // action never runs before its inputs exist — but independent actions run in parallel.
    const knownVars = new Set(stageActions.map(({ a }) => a.config?.outputVar).filter(Boolean));
    const varReady  = new Map();
    for (const name of knownVars) {
        let resolve;
        const promise = new Promise(r => { resolve = r; });
        varReady.set(name, { promise, resolve });
    }

    const runOne = async ({ a, idx }) => {
        const deps = getVarDeps(a.config, knownVars);
        if (deps.length) {
            if (debug) console.log(`[TRG:dev]   [${idx}] ${a.type} waiting for: [${deps.join(', ')}]`);
            await Promise.all(deps.map(d => varReady.get(d).promise));
            if (debug) console.log(`[TRG:dev]   [${idx}] ${a.type} unblocked | vars:`, { ...vars });
        }

        const def = ACTION_REGISTRY[a.type];
        if (!def) return;
        log('action', { ruleId: rule.id, type: a.type, actionIdx: idx, ...execCtx });
        try {
            await def.execute(a.config ?? {}, { ...execCtx, ruleId: rule.id, actionIdx: idx, isCurrentGeneration, vars, debug });
        } catch (err) {
            console.error(`[${EXT_NAME}] action ${a.type} threw`, err);
        } finally {
            if (debug) console.log(`[TRG:dev]   [${idx}] ${a.type} done | vars:`, { ...vars });
            if (a.config?.outputVar) {
                // Publish to turn-level store so subsequent rules' varMatch triggers can read it.
                if (a.config.outputVar in vars) setTurnVar(a.config.outputVar, vars[a.config.outputVar]);
                // Always resolve so downstream actions are never permanently blocked by an upstream failure.
                varReady.get(a.config.outputVar)?.resolve();
            }
        }
    };

    await Promise.all(stageActions.map(runOne));
}

// ---------------------------------------------------------------------------
// Live stream patch
// Applies replace-type rules visually on each token without touching msg.mes.
// Uses a split-and-anchor strategy: once a keyword is first matched, the patched
// display text is stored alongside the original text length at that point.
// Subsequent tokens only apply the replacement to the new suffix, avoiding
// repeated full-text regex passes as the message grows.
// Uses a direct .mes_text write (messageFormatting only) instead of the heavier
// updateMessageBlock to match ST's own streaming update cost.
// The authoritative replacement still happens in onMessageReceived.
// ---------------------------------------------------------------------------

async function applyLivePatch(text, streamingMessageId, stCtx) {
    const s = getSettings();
    const msg = stCtx?.chat?.[streamingMessageId];
    if (!msg) return;

    let displayText = text;
    let anyChange   = false;

    for (const rule of (s.rules ?? [])) {
        if (!rule.enabled) continue;
        const replaceActions = (rule.actions ?? []).filter(a => a.type === 'replace');
        if (!replaceActions.length) continue;

        const anchor = _livePatches.get(rule.id);

        if (anchor) {
            // Already patched this generation — apply replacement only to the new
            // suffix (tokens that arrived after the anchor point), then prepend
            // the locked prefix. The already-patched portion is never re-processed.
            const rawSuffix = text.slice(anchor.origLength);
            const re        = new RegExp(anchor.keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
            let patchedSuffix = rawSuffix;
            for (const action of replaceActions) {
                patchedSuffix = patchedSuffix.replace(re, action.config?.replacement ?? '');
            }
            displayText = anchor.patchedPrefix + patchedSuffix;
            // Advance the anchor so the next token only processes the newest slice.
            _livePatches.set(rule.id, { ...anchor, patchedPrefix: displayText, origLength: text.length });
            anyChange = true;
        } else {
            // First token where this rule's trigger fires — establish the anchor.
            const matched = await evaluateTriggers(rule, displayText);
            if (matched === null) continue;

            const re = new RegExp(matched.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
            let patched = displayText;
            for (const action of replaceActions) {
                patched = patched.replace(re, action.config?.replacement ?? '');
            }
            _livePatches.set(rule.id, { keyword: matched, patchedPrefix: patched, origLength: text.length });
            displayText = patched;
            anyChange   = true;
        }
    }

    // Apply settled sideCall results (replaceKeyword / replaceParagraph).
    // These are applied fresh each token so the result stays visible as streaming continues.
    for (const lr of _liveResults.values()) {
        const re = new RegExp(lr.keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        if (lr.mode === 'replaceKeyword') {
            const updated = displayText.replace(re, lr.replacement);
            if (updated !== displayText) { displayText = updated; anyChange = true; }
        } else if (lr.mode === 'replaceParagraph') {
            const m = re.exec(displayText); re.lastIndex = 0;
            if (!m) continue;
            const nlEnd = displayText.indexOf('\n', m.index);
            if (nlEnd === -1) continue; // paragraph still streaming — skip
            const start = displayText.lastIndexOf('\n', m.index - 1) + 1;
            const updated = displayText.slice(0, start) + lr.replacement + displayText.slice(nlEnd);
            if (updated !== displayText) { displayText = updated; anyChange = true; }
        }
    }

    if (!anyChange || displayText === text) return;

    // Precompute corrected HTML and attach the observer.
    // The observer applies it the moment ST's onProgressStreaming writes to .mes_text —
    // which happens *after* this event handler returns. This eliminates the one-token
    // lag that caused the Sam/Horribleface alternation.
    startPatchObserver(streamingMessageId);
    _pendingPatchHtml = messageFormatting(displayText, msg.name, msg.is_system, msg.is_user, streamingMessageId, {}, false);
    log('live patch queued', { streamingMessageId });
    setBadge(streamingMessageId, 'modified');
}

// ---------------------------------------------------------------------------
// Prefetch pass
// Fires sideCall LLM dispatches as soon as the trigger keyword first appears in
// the stream, so the result is usually already settled by the time streaming ends.
// Also registers pending highlight entries so the observer can annotate the DOM.
// ---------------------------------------------------------------------------

// Called once per sideCall prefetch (first promise only, once-mode).
// When the LLM promise settles mid-stream, writes the result into _liveResults
// so applyLivePatch immediately incorporates it on the next token — and triggers
// an immediate display update for the current token without waiting for postMessage.
// Guard: if streaming has already ended (_patchObserverMsgId !== streamingMessageId),
// the result settled too late; postMessage's sideCall.execute will handle it normally.
async function attachLiveApply(promise, key, config, matchedKeyword, streamingMessageId, stCtx, genId) {
    const mode = config.outputMode ?? 'replaceKeyword';
    if (mode !== 'replaceKeyword' && mode !== 'replaceParagraph') return;

    let result;
    try { result = await promise; }
    catch { return; }

    if (!result || _generationId !== genId) return;
    if (_patchObserverMsgId !== streamingMessageId) return; // stream already ended

    const msg = stCtx?.chat?.[streamingMessageId];
    if (!msg) return;

    _pendingHighlights.delete(key);
    _liveResults.set(key, { keyword: matchedKeyword, replacement: result, mode });

    // Compute the corrected display text from current msg.mes and stamp it immediately.
    // applyLivePatch will keep it applied on every subsequent token.
    const kwRe = new RegExp(matchedKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    let displayText = msg.mes;

    if (mode === 'replaceKeyword') {
        displayText = displayText.replace(kwRe, result);
    } else {
        const m = kwRe.exec(displayText); kwRe.lastIndex = 0;
        if (m) {
            const nlEnd = displayText.indexOf('\n', m.index);
            if (nlEnd !== -1) {
                const start = displayText.lastIndexOf('\n', m.index - 1) + 1;
                displayText = displayText.slice(0, start) + result + displayText.slice(nlEnd);
            }
        }
    }

    if (displayText === msg.mes) return;

    startPatchObserver(streamingMessageId);
    _pendingPatchHtml = messageFormatting(displayText, msg.name, msg.is_system, msg.is_user, streamingMessageId, {}, false);
    log('sideCall live-applied to display', { key, mode, streamingMessageId });
    setBadge(streamingMessageId, 'modified');
}

async function applyPrefetch(text, streamingMessageId, stCtx) {
    const s = getSettings();
    for (const rule of (s.rules ?? [])) {
        if (!rule.enabled) continue;
        const sideCallIdxs = (rule.actions ?? [])
            .map((a, idx) => ({ a, idx }))
            .filter(({ a }) => a.type === 'sideCall');
        if (!sideCallIdxs.length) continue;

        // Vars produced by any action in this rule. A sideCall that references one
        // of these needs the var resolved first — only happens at postMessage once
        // the upstream action runs. Prefetching it now would use an empty value.
        const ruleVars = new Set((rule.actions ?? []).map(a => a.config?.outputVar).filter(Boolean));

        const matched = await evaluateTriggers(rule, text);
        if (matched === null) continue;

        for (const { a, idx } of sideCallIdxs) {
            if (getVarDeps(a.config, ruleVars).length > 0) continue; // var-dependent — skip early fire

            const key = `${rule.id}:${idx}`;
            const isNew = !getPrefetchedResults(key);
            const resolvedPrompt = await resolveLbTokens(a.config?.prompt ?? '', matched);
            const resolvedConfig = resolvedPrompt !== a.config?.prompt ? { ...a.config, prompt: resolvedPrompt } : (a.config ?? {});
            prefetchSideCall(key, resolvedConfig, matched, text, stCtx, streamingMessageId);
            if (isNew) {
                const promises = getPrefetchedResults(key);
                if (promises?.length) {
                    attachLiveApply(promises[0], key, resolvedConfig, matched, streamingMessageId, stCtx, _generationId);
                }
            }
            if (!_pendingHighlights.has(key)) {
                _pendingHighlights.set(key, matched);
            }
        }
    }
    if (_pendingHighlights.size) {
        startPatchObserver(streamingMessageId);
    }
}

// ---------------------------------------------------------------------------
// Badge trigger helpers
// ---------------------------------------------------------------------------

function getRuleBadgeDefs(rules) {
    return (rules ?? [])
        .filter(r => r.enabled && r.triggers?.some(t => t.type === 'badgeTrigger'))
        .map(r => {
            const cfg = r.triggers.find(t => t.type === 'badgeTrigger')?.config ?? {};
            return { ruleId: r.id, label: cfg.label || r.name || 'run', color: cfg.color || null };
        });
}

/** Fire a specific rule's postMessage actions manually (from a badge button click). */
export async function fireRuleManually(ruleId, messageId) {
    const s = getSettings();
    if (!s?.enabled) return;
    const rule = (s.rules ?? []).find(r => r.id === ruleId && r.enabled);
    if (!rule) return;
    const stCtx = window.SillyTavern?.getContext?.();
    const label  = rule.triggers?.find(t => t.type === 'badgeTrigger')?.config?.label ?? 'badge';
    setBadge(messageId, 'thinking');
    try {
        await executeActions(rule, 'postMessage', { matchedKeyword: label, messageId, stCtx });
    } finally {
        setBadge(messageId, 'modified');
    }
}

/**
 * Render (or clear) rule badge buttons for one or all messages.
 * Pass a messageId to update a single message; omit to refresh the whole chat.
 */
export function reinjectRuleBadges(messageId = null) {
    const s    = getSettings();
    const defs = getRuleBadgeDefs(s?.rules);
    if (messageId !== null) {
        renderRuleBadges(messageId, defs);
        return;
    }
    const stCtx = window.SillyTavern?.getContext?.();
    if (!stCtx?.chat) return;
    stCtx.chat.forEach((_msg, idx) => renderRuleBadges(idx, defs));
}

// ---------------------------------------------------------------------------
// Event handlers (exported for index.js to wire up)
// ---------------------------------------------------------------------------

export function onGenerationStarted() {
    // GENERATION_STARTED also fires when a background sideCall dispatch runs
    // generateQuietPrompt. Clearing state in that case would wipe the prefetch
    // cache and dedup mid-stream, causing an infinite dispatch loop.
    if (isDispatchActive()) return;

    _generationId++;
    stopPatchObserver();
    _fired.clear();
    _livePatches.clear();
    _pendingHighlights.clear();
    _liveResults.clear();
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

    // Stream-stage actions (stop, stopContinue)
    for (const rule of (s.rules ?? [])) {
        if (!rule.enabled || !ruleHasStage(rule, 'stream')) continue;
        const key = `${rule.id}:stream`;
        if (_fired.has(key)) continue;

        const matched = await evaluateTriggers(rule, text);
        if (matched === null) {
            log('no match (stream)', { ruleId: rule.id });
            continue;
        }

        log('match (stream)', { ruleId: rule.id, matched });
        _fired.add(key);
        await executeActions(rule, 'stream', { matchedKeyword: matched, stCtx });
    }

    // Live visual patch for replace rules + prefetch sideCall dispatches
    const streamingMessageId = (stCtx?.chat?.length ?? 0) - 1;
    if (streamingMessageId >= 0) {
        await applyLivePatch(text, streamingMessageId, stCtx);
        await applyPrefetch(text, streamingMessageId, stCtx);
    }
}

export async function onMessageReceived(messageId) {
    const s = getSettings();
    if (!s?.enabled) return;
    stopPatchObserver();      // stream is done; authoritative replace handles it from here
    _pendingHighlights.clear(); // results will replace highlights
    const stCtx = window.SillyTavern?.getContext?.();
    const text  = stCtx?.chat?.[messageId]?.mes ?? '';

    setChatComplete(true);
    ensureBadge(messageId);
    renderRuleBadges(messageId, getRuleBadgeDefs(s?.rules));

    // postMessage-stage rules: loop until stable.
    // Each iteration reads msg.mes fresh so earlier rules' writes are visible to
    // later rules' trigger checks (sequential evaluation / domain isolation).
    // Recheck passes run automatically — the loop repeats as long as at least one
    // new rule fires. firedThisCall is a LOCAL set for this invocation — it is not
    // affected by GENERATION_STARTED clearing the global _fired during a sideCall
    // dispatch (which would otherwise cause the loop to spin forever).
    const firedThisCall  = new Set();
    const matchedKeywords = new Set();
    const tPostMsg = performance.now();
    let rulesFired = 0;
    let anyFired = true;
    while (anyFired) {
        anyFired = false;
        for (const rule of (s.rules ?? [])) {
            if (!rule.enabled || !ruleHasStage(rule, 'postMessage')) continue;
            const key = `${rule.id}:postMessage`;
            if (firedThisCall.has(key)) continue;

            const currentText = stCtx?.chat?.[messageId]?.mes ?? '';
            const matched = await evaluateTriggers(rule, currentText);
            if (matched === null) {
                log('no match (postMessage)', { ruleId: rule.id });
                continue;
            }

            log('match (postMessage)', { ruleId: rule.id, matched });
            _fired.add(key);
            firedThisCall.add(key);
            anyFired = true;
            rulesFired++;
            matchedKeywords.add(matched);
            setBadge(messageId, 'thinking');
            await executeActions(rule, 'postMessage', { matchedKeyword: matched, messageId, stCtx });
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

    // stream-stage rules run here only when non-streaming mode is on.
    // STREAM_TOKEN_RECEIVED never fires for non-streamed responses, so this
    // is the only opportunity to evaluate them against the completed message.
    if (!s.nonStreaming) return;

    for (const rule of (s.rules ?? [])) {
        if (!rule.enabled || !ruleHasStage(rule, 'stream')) continue;
        const key = `${rule.id}:stream`;
        if (_fired.has(key)) continue;  // already fired during a streaming turn

        const matched = await evaluateTriggers(rule, text);
        if (matched === null) {
            log('no match (stream/non-streaming)', { ruleId: rule.id });
            continue;
        }

        log('match (stream/non-streaming)', { ruleId: rule.id, matched });
        _fired.add(key);
        await executeActions(rule, 'stream', { matchedKeyword: matched, stCtx });
    }
}
