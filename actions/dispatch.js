/**
 * @file st-extensions/SillyTavern-Triggeryze/actions/dispatch.js
 * @stamp {"utc":"2026-06-15T00:00:00.000Z"}
 * @architectural-role IO — LLM dispatch and prefetch cache for sideCall actions
 * @description
 * Owns the active-dispatch counter, the prefetch promise cache, and the two
 * dispatch functions (blocking and fire-and-forget). Also owns prefetchSideCall,
 * which the engine calls on each stream token to pre-fire LLM calls before
 * the stream ends.
 *
 * @api-declaration
 * isDispatchActive()                                        — true while any LLM dispatch is in flight
 * clearPrefetchCache()                                      — called by engine on GENERATION_STARTED
 * getPrefetchedResults(key)                                 — returns cached promise array for a given key, or null
 * prefetchSideCall(key, config, keyword, streamText, stCtx, msgIdx) — fires prefetch promises during streaming
 *
 * @contract
 *   assertions:
 *     purity:          none — owns state and performs external LLM calls
 *     state_ownership: [_activeDispatches, _prefetchCache]
 *     external_io:     generateQuietPrompt, ConnectionManagerRequestService, window.loggeryze
 */

import { generateQuietPrompt, name1, name2 } from '../../../../../script.js';
import { ConnectionManagerRequestService } from '../../../shared.js';
import { interpolate, resolveHistoryTokens } from './template.js';
import { extractParagraph, collectUniqueParagraphs } from './text.js';

// Count of active background LLM dispatches. When non-zero, engine.onGenerationStarted
// must not clear Triggeryze's per-generation state — the GENERATION_STARTED event it
// sees is from a quiet/background call, not a real new generation.
let _activeDispatches = 0;
export function isDispatchActive() { return _activeDispatches > 0; }

/**
 * Dispatches a prompt to an LLM.
 * Tries the Connection Manager profile first (if profileId set), then falls back
 * to the main ST chat LLM via generateQuietPrompt.
 */
export async function dispatch(prompt, profileId, debug = false) {
    _activeDispatches++;
    const tStart = performance.now();
    if (debug) console.log('[TRG:dev] >>> LLM prompt:\n' + prompt);
    try {
        let result = null;

        if (profileId) {
            try {
                result = await ConnectionManagerRequestService.sendRequest(profileId, prompt, null);
            } catch (err) {
                console.warn('[triggeryze] sideCall: ConnectionManager failed, falling back to main LLM', err);
            }
        }

        if (result === null) {
            result = await generateQuietPrompt({ quietPrompt: prompt, removeReasoning: true });
        }

        const text = String(result?.content ?? result ?? '').trim();
        if (debug) console.log(`[TRG:dev] <<< LLM result (${Math.round(performance.now() - tStart)}ms):\n` + text);
        return text;
    } finally {
        _activeDispatches--;
    }
}

// Wraps dispatch() with Loggeryze waterfall timing for prefetch calls that fire
// during streaming. time/timeEnd are no-ops outside an active turn, so this is
// safe to call unconditionally — but only meaningful when a turn is live.
function prefetchDispatch(prompt, profileId) {
    window.loggeryze?.time('Triggeryze: sideCall [non-blocking]');
    return dispatch(prompt, profileId)
        .then(r  => { window.loggeryze?.timeEnd('Triggeryze: sideCall [non-blocking]'); return r; })
        .catch(() => { window.loggeryze?.timeEnd('Triggeryze: sideCall [non-blocking]'); return null; });
}

// ---------------------------------------------------------------------------
// Prefetch cache — sideCall dispatches fired during streaming
//
// Key: `${ruleId}:${actionIdx}`
// Value: ordered array of in-flight / settled Promises<string|null>
//   - once mode:     one promise max
//   - perMatch mode: one promise per keyword instance seen so far
//
// The engine fires calls here as keyword instances appear in the stream.
// sideCall.execute awaits the cached promises instead of dispatching fresh calls,
// so results are usually already available by the time the stream ends.
// ---------------------------------------------------------------------------

const _prefetchCache = new Map();

export function clearPrefetchCache() {
    _prefetchCache.clear();
}

export function getPrefetchedResults(key) {
    return _prefetchCache.get(key) ?? null;
}

/**
 * Called by the engine on each stream token when a sideCall rule's trigger fires.
 * Fires dispatch promises for any new keyword/paragraph instances since the last call.
 * key:             `${ruleId}:${actionIdx}`
 * matchedKeyword:  the trigger's matched string
 * streamText:      accumulated stream text (msg.mes is stale during streaming)
 * stCtx / msgIdx:  for building {{history}} from chat turns before the streaming message
 */
export function prefetchSideCall(key, config, matchedKeyword, streamText, stCtx, streamingMsgIdx) {
    const callMode = config.callMode ?? 'once';
    const mode     = config.outputMode ?? 'replaceKeyword';
    if (mode === 'silent') return;

    // Resolve {{history:[N]}} / {{history:var}} inline in the prompt at prefetch time.
    // Variable-form tokens ({{history:var}}) resolve to empty if the var isn't set yet
    // during streaming — execute() at postMessage stage will have the correct value.
    const resolvedPrompt = resolveHistoryTokens(config.prompt ?? '', stCtx?.chat, streamingMsgIdx ?? 0, {});
    const kwEsc = matchedKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const mkRe  = () => new RegExp(kwEsc, 'gi');

    const mkPrompt = (paragraph = '', upTo = '') => interpolate(resolvedPrompt, {
        keyword:   matchedKeyword ?? '',
        message:   streamText,
        paragraph,
        'up-to':   upTo,
        char:      name2 ?? '',
        user:      name1 ?? '',
    });
    if (!mkPrompt().trim()) return;

    if (callMode === 'once') {
        if (_prefetchCache.has(key)) return;
        let para = '', upTo = '';
        const firstMatch = mkRe().exec(streamText);
        if (firstMatch) {
            upTo = streamText.slice(0, firstMatch.index);
            if (mode === 'replaceParagraph') para = extractParagraph(streamText, firstMatch.index).text;
        }
        _prefetchCache.set(key, [prefetchDispatch(mkPrompt(para, upTo), config.profileId ?? null)]);
    } else if (mode === 'replaceParagraph') {
        const paragraphs = collectUniqueParagraphs(streamText, mkRe());
        const existing   = _prefetchCache.get(key) ?? [];
        while (existing.length < paragraphs.length) {
            const p    = paragraphs[existing.length];
            const upTo = streamText.slice(0, p.start);
            existing.push(prefetchDispatch(mkPrompt(p.text, upTo), config.profileId ?? null));
        }
        _prefetchCache.set(key, existing);
    } else {
        // perMatch replaceKeyword: one call per keyword instance, each with its own {{up-to}}
        const matches  = [...streamText.matchAll(mkRe())];
        const existing = _prefetchCache.get(key) ?? [];
        while (existing.length < matches.length) {
            const m    = matches[existing.length];
            const upTo = streamText.slice(0, m.index);
            existing.push(prefetchDispatch(mkPrompt('', upTo), config.profileId ?? null));
        }
        _prefetchCache.set(key, existing);
    }
}
