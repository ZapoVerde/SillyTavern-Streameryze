/**
 * @file st-extensions/SillyTavern-Triggeryze/engine/live-patch.js
 * @stamp {"utc":"2026-06-15T00:00:00.000Z"}
 * @architectural-role UI — streaming visual patch: MutationObserver, live replace, sideCall prefetch
 * @description
 * Owns all state and logic for updating the streaming message DOM between tokens.
 * Three sub-concerns:
 *   1. Patch observer: a MutationObserver that stamps precomputed HTML as a microtask
 *      after ST's onProgressStreaming write, eliminating the one-token display lag.
 *   2. Live replace: applyLivePatch re-runs replace rules each token using a split-and-anchor
 *      strategy so only the new suffix is re-processed per token.
 *   3. Prefetch + live sideCall: fires LLM dispatches the moment the trigger keyword appears
 *      and applies settled results to the display without waiting for postMessage.
 *
 * @api-declaration
 * applyLivePatch(text, msgId, stCtx)      — visual replace pass, called per token
 * applyPrefetch(text, msgId, stCtx, getGenId) — sideCall prefetch pass, called per token
 * stopPatchObserver()                     — disconnect observer; call on MESSAGE_RECEIVED
 * clearLivePatchState()                   — reset all state; call on GENERATION_STARTED
 * highlightPendingKeyword(el, keyword)    — wraps keyword occurrences in .trg-pending-kw spans
 * clearPendingHighlights()                — clear in-flight highlight annotations
 * hasLiveResult(key)                      — true when a live preview result exists for key
 * setLiveResult(key, result)              — stores a live preview result (called from execute.js)
 *
 * @contract
 *   assertions:
 *     purity:          none — owns DOM state and prefetch scheduling
 *     state_ownership: [_livePatches, _pendingHighlights, _liveResults, _patchObserver vars]
 *     external_io:     MutationObserver (DOM), messageFormatting, setBadge, prefetchSideCall
 */

import { messageFormatting }                                       from '../../../../../script.js';
import { getSettings }                                             from '../settings/storage.js';
import { evaluateTriggers, getVarDeps }                            from './evaluate.js';
import { resolveLbTokens, prefetchSideCall, getPrefetchedResults } from '../actions/index.js';
import { setBadge }                                                from '../badge.js';

const log = (tag, ...args) => { if (getSettings()?.verbose) console.log(`[triggeryze] ${tag}`, ...args); };

// ── Observer state ─────────────────────────────────────────────────────────────
let _pendingPatchHtml      = null;
let _patchObserver         = null;
let _patchObserverMsgId    = -1;
let _patchObserverApplying = false;

// ── Per-generation streaming state ─────────────────────────────────────────────
const _livePatches       = new Map(); // Map<ruleId, { keyword, patchedPrefix, origLength }>
const _pendingHighlights = new Map(); // Map<key, keyword> — sideCall in flight
const _liveResults       = new Map(); // Map<key, { keyword, replacement, mode }> — settled results

export function clearLivePatchState() {
    stopPatchObserver();
    _livePatches.clear();
    _pendingHighlights.clear();
    _liveResults.clear();
}

export function clearPendingHighlights() { _pendingHighlights.clear(); }
export function hasLiveResult(key)       { return _liveResults.has(key); }
export function setLiveResult(key, r)    { _liveResults.set(key, r); }

// ── MutationObserver ───────────────────────────────────────────────────────────

export function highlightPendingKeyword(mesTextEl, keyword) {
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
        for (const kw of _pendingHighlights.values()) highlightPendingKeyword(mesTextEl, kw);
        _patchObserverApplying = false;
    });
    _patchObserver.observe(mesTextEl, { childList: true, subtree: true, characterData: true });
}

export function stopPatchObserver() {
    _patchObserver?.disconnect();
    _patchObserver         = null;
    _patchObserverMsgId    = -1;
    _pendingPatchHtml      = null;
    _patchObserverApplying = false;
}

// ── Live replace pass ──────────────────────────────────────────────────────────

export async function applyLivePatch(text, streamingMessageId, stCtx) {
    const s   = getSettings();
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
            const rawSuffix   = text.slice(anchor.origLength);
            const re          = new RegExp(anchor.keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
            let patchedSuffix = rawSuffix;
            for (const action of replaceActions) patchedSuffix = patchedSuffix.replace(re, action.config?.replacement ?? '');
            displayText = anchor.patchedPrefix + patchedSuffix;
            _livePatches.set(rule.id, { ...anchor, patchedPrefix: displayText, origLength: text.length });
            anyChange = true;
        } else {
            const matched = await evaluateTriggers(rule, displayText);
            if (matched === null) continue;
            const re = new RegExp(matched.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
            let patched = displayText;
            for (const action of replaceActions) patched = patched.replace(re, action.config?.replacement ?? '');
            _livePatches.set(rule.id, { keyword: matched, patchedPrefix: patched, origLength: text.length });
            displayText = patched;
            anyChange   = true;
        }
    }

    for (const lr of _liveResults.values()) {
        const re = new RegExp(lr.keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        if (lr.mode === 'replaceKeyword') {
            const updated = displayText.replace(re, lr.replacement);
            if (updated !== displayText) { displayText = updated; anyChange = true; }
        } else if (lr.mode === 'replaceParagraph') {
            const m = re.exec(displayText); re.lastIndex = 0;
            if (!m) continue;
            const nlEnd = displayText.indexOf('\n', m.index);
            if (nlEnd === -1) continue;
            const start   = displayText.lastIndexOf('\n', m.index - 1) + 1;
            const updated = displayText.slice(0, start) + lr.replacement + displayText.slice(nlEnd);
            if (updated !== displayText) { displayText = updated; anyChange = true; }
        }
    }

    if (!anyChange || displayText === text) return;

    startPatchObserver(streamingMessageId);
    _pendingPatchHtml = messageFormatting(displayText, msg.name, msg.is_system, msg.is_user, streamingMessageId, {}, false);
    log('live patch queued', { streamingMessageId });
    setBadge(streamingMessageId, 'modified');
}

// ── Prefetch pass ──────────────────────────────────────────────────────────────

async function attachLiveApply(promise, key, config, matchedKeyword, streamingMessageId, stCtx, genId, getGenId) {
    const mode = config.outputMode ?? 'replaceKeyword';
    if (mode !== 'replaceKeyword' && mode !== 'replaceParagraph') return;

    let result;
    try { result = await promise; } catch { return; }

    if (!result || getGenId() !== genId) return;
    if (_patchObserverMsgId !== streamingMessageId) return;

    const msg = stCtx?.chat?.[streamingMessageId];
    if (!msg) return;

    _pendingHighlights.delete(key);
    _liveResults.set(key, { keyword: matchedKeyword, replacement: result, mode });

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

export async function applyPrefetch(text, streamingMessageId, stCtx, getGenId) {
    const s = getSettings();
    for (const rule of (s.rules ?? [])) {
        if (!rule.enabled) continue;
        const sideCallIdxs = (rule.actions ?? []).map((a, idx) => ({ a, idx })).filter(({ a }) => a.type === 'sideCall');
        if (!sideCallIdxs.length) continue;

        const ruleVars = new Set((rule.actions ?? []).map(a => a.config?.outputVar).filter(Boolean));
        const matched  = await evaluateTriggers(rule, text);
        if (matched === null) continue;

        for (const { a, idx } of sideCallIdxs) {
            if (getVarDeps(a.config, ruleVars).length > 0) continue;
            const key            = `${rule.id}:${idx}`;
            const isNew          = !getPrefetchedResults(key);
            const resolvedPrompt = await resolveLbTokens(a.config?.prompt ?? '', matched);
            const resolvedConfig = resolvedPrompt !== a.config?.prompt ? { ...a.config, prompt: resolvedPrompt } : (a.config ?? {});
            prefetchSideCall(key, resolvedConfig, matched, text, stCtx, streamingMessageId);
            if (isNew) {
                const promises = getPrefetchedResults(key);
                if (promises?.length) attachLiveApply(promises[0], key, resolvedConfig, matched, streamingMessageId, stCtx, getGenId(), getGenId);
            }
            if (!_pendingHighlights.has(key)) _pendingHighlights.set(key, matched);
        }
    }
    if (_pendingHighlights.size) startPatchObserver(streamingMessageId);
}
