/**
 * @file st-extensions/SillyTavern-Streameryze/actions.js
 * @stamp {"utc":"2026-06-13T00:00:00.000Z"}
 * @architectural-role IO Wrapper + Registry
 * @description
 * Action registry and built-in action implementations.
 *
 * An action receives an execution context and produces a side effect —
 * stopping the stream, mutating a message, firing an LLM call, etc.
 * Actions do not evaluate triggers. They act; they do not decide whether
 * to act. That responsibility belongs to the engine.
 *
 * Each action declares a stage: 'stream' (fires during active generation)
 * or 'postMessage' (fires after the final message is committed). The engine
 * will only call an action at its declared stage.
 *
 * To add a new action type: add an entry to ACTION_REGISTRY. The engine
 * and settings panel discover it automatically.
 *
 * @api-declaration
 * ACTION_REGISTRY       — map of type key → action definition
 * clearPrefetchCache()  — called by engine on GENERATION_STARTED
 * prefetchSideCall(...) — called by engine during streaming to pre-fire dispatches
 * getPrefetchedResults  — called by sideCall.execute to consume cached promises
 *
 * Execution context shape:
 *   stream stage:      { matchedKeyword: string, stCtx: object }
 *   postMessage stage: { matchedKeyword: string, messageId: number, stCtx: object,
 *                        ruleId: string, actionIdx: number }
 *
 * @contract
 *   assertions:
 *     purity:          each action owns exactly one responsibility
 *     state_ownership: none
 *     external_io:     stCtx.stopGeneration(), stCtx.generate(), stCtx.saveChat(),
 *                      generateQuietPrompt, ConnectionManagerRequestService, eventSource
 */

import { eventSource, event_types, generateQuietPrompt, name1, name2, addOneMessage, updateMessageBlock } from '../../../../script.js';
import { ConnectionManagerRequestService } from '../../shared.js';

function esc(s) { return $('<span>').text(s ?? '').html(); }

/**
 * Runs async task functions with capped concurrency, preserving result order.
 * concurrency=1 gives serial execution (safe when the underlying call uses
 * shared global state, e.g. generateQuietPrompt / generateRaw).
 */
function runQueued(taskFns, concurrency = 1) {
    return new Promise(resolve => {
        const results = new Array(taskFns.length).fill(null);
        let nextIdx = 0, done = 0, running = 0;
        if (!taskFns.length) { resolve(results); return; }
        function kick() {
            while (running < concurrency && nextIdx < taskFns.length) {
                const i = nextIdx++;
                running++;
                taskFns[i]()
                    .then(r  => { results[i] = r ?? null; })
                    .catch(() => { results[i] = null; })
                    .finally(() => { running--; done++; if (done === taskFns.length) resolve(results); else kick(); });
            }
        }
        kick();
    });
}

function interpolate(template, vars) {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}

/**
 * Dispatches a prompt to an LLM.
 * Tries the Connection Manager profile first (if profileId set), then falls back
 * to the main ST chat LLM via generateQuietPrompt.
 */
async function dispatch(prompt, profileId) {
    let result = null;

    if (profileId) {
        try {
            result = await ConnectionManagerRequestService.sendRequest(profileId, prompt, null);
        } catch (err) {
            console.warn('[streameryze] sideCall: ConnectionManager failed, falling back to main LLM', err);
        }
    }

    if (result === null) {
        result = await generateQuietPrompt({ quietPrompt: prompt, removeReasoning: true });
    }

    return String(result?.content ?? result ?? '').trim();
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
 * Builds a formatted transcript of the N turn-pairs before `beforeIndex`.
 * Format matches the Vistalyze convention: "Name: message" blocks joined by double newlines.
 */
function buildHistoryText(chat, beforeIndex, numPairs) {
    if (!numPairs || numPairs <= 0 || !chat?.length) return '';
    const start = Math.max(0, beforeIndex - numPairs * 2);
    const slice = chat.slice(start, beforeIndex);
    if (!slice.length) return '';
    return slice.map(m => `${m.name ?? 'Unknown'}: ${m.mes ?? ''}`).join('\n\n');
}

/** Returns { text, start, end } of the newline-bounded paragraph at matchIndex. */
function extractParagraph(text, matchIndex) {
    const start = text.lastIndexOf('\n', matchIndex - 1) + 1;
    const nlEnd  = text.indexOf('\n', matchIndex);
    const end    = nlEnd === -1 ? text.length : nlEnd;
    return { text: text.slice(start, end), start, end };
}

/** Returns all unique paragraphs (by start index) that contain a regex match, in order. */
function collectUniqueParagraphs(text, re) {
    const seen = new Map();
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
        const p = extractParagraph(text, m.index);
        if (!seen.has(p.start)) seen.set(p.start, p);
    }
    return [...seen.values()].sort((a, b) => a.start - b.start);
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

    const historyText = buildHistoryText(stCtx?.chat, streamingMsgIdx ?? 0, config.historyTurns ?? 0);
    const kwEsc = matchedKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const mkRe  = () => new RegExp(kwEsc, 'gi');

    const mkPrompt = (paragraph = '') => interpolate(config.prompt ?? '', {
        keyword:   matchedKeyword ?? '',
        message:   streamText,
        paragraph,
        history:   historyText,
        char:      name2 ?? '',
        user:      name1 ?? '',
    });
    if (!mkPrompt().trim()) return;

    if (callMode === 'once') {
        if (_prefetchCache.has(key)) return;
        const para = mode === 'replaceParagraph' ? (() => { const m = mkRe().exec(streamText); return m ? extractParagraph(streamText, m.index).text : ''; })() : '';
        _prefetchCache.set(key, [dispatch(mkPrompt(para), config.profileId ?? null).catch(() => null)]);
    } else if (mode === 'replaceParagraph') {
        const paragraphs = collectUniqueParagraphs(streamText, mkRe());
        const existing   = _prefetchCache.get(key) ?? [];
        while (existing.length < paragraphs.length) {
            const p = paragraphs[existing.length];
            existing.push(dispatch(mkPrompt(p.text), config.profileId ?? null).catch(() => null));
        }
        _prefetchCache.set(key, existing);
    } else {
        // perMatch replaceKeyword: one call per keyword instance
        const count    = [...streamText.matchAll(mkRe())].length;
        const existing = _prefetchCache.get(key) ?? [];
        while (existing.length < count) {
            existing.push(dispatch(mkPrompt(), config.profileId ?? null).catch(() => null));
        }
        _prefetchCache.set(key, existing);
    }
}

/**
 * Action registry.
 *
 * Each entry must provide:
 *   label         — display name shown in the settings UI
 *   stage         — 'stream' | 'postMessage'
 *   defaultConfig — initial config object when the action is first added
 *   execute(config, execCtx) → Promise<void>
 *                 — performs the action. Must not throw.
 *   renderConfig($el, config, onChange)
 *                 — renders configuration UI into $el; calls onChange(newConfig)
 *                   when the user edits a field.
 */
export const ACTION_REGISTRY = {

    stop: {
        label: 'stop',
        stage: 'stream',
        defaultConfig: {},
        async execute(config, { stCtx }) {
            stCtx?.stopGeneration?.();
        },
        renderConfig($el) {
            $el.html('<small class="smz-hint">Halts generation. The matched text stays in the partial message.</small>');
        },
    },

    stopContinue: {
        label: 'stop + continue',
        stage: 'stream',
        defaultConfig: {},
        async execute(config, { stCtx }) {
            stCtx?.stopGeneration?.();
            // GENERATION_STOPPED fires synchronously inside stopGeneration().
            // The 500ms delay lets the async stream teardown finish before resuming.
            eventSource.once(event_types.GENERATION_STOPPED, () => {
                setTimeout(() => window.SillyTavern?.getContext?.()?.generate?.('continue'), 500);
            });
        },
        renderConfig($el) {
            $el.html('<small class="smz-hint">Stops and resumes — newly triggered lorebook entries will be active in the continued reply.</small>');
        },
    },

    replace: {
        label: 'replace',
        stage: 'postMessage',
        defaultConfig: { replacement: '' },
        async execute(config, { matchedKeyword, messageId, stCtx }) {
            const msg = stCtx?.chat?.[messageId];
            if (!msg) return;
            // Case-insensitive replace: split on a regex so it matches regardless of case
            const re      = new RegExp(matchedKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
            const updated = msg.mes.replace(re, config.replacement ?? '');
            if (updated === msg.mes) return;
            msg.mes = updated;
            try {
                updateMessageBlock(messageId, msg);
                if (typeof stCtx.saveChat === 'function') await stCtx.saveChat();
                eventSource.emit(event_types.MESSAGE_UPDATED, messageId);
            } catch (err) {
                console.error('[streameryze] replace: render/save failed', err);
            }
        },
        renderConfig($el, config, onChange) {
            $el.html(`<input type="text" class="text_pole smz-cfg" placeholder="replacement — blank to delete" value="${esc(config.replacement)}" />`);
            $el.find('input').on('input', function () { onChange({ ...config, replacement: this.value }); });
        },
    },

    sideCall: {
        label: 'call LLM',
        stage: 'postMessage',
        defaultConfig: { prompt: '', profileId: null, outputMode: 'replaceKeyword', callMode: 'once', historyTurns: 0 },

        async execute(config, { matchedKeyword, messageId, stCtx, ruleId, actionIdx }) {
            const msg         = stCtx?.chat?.[messageId];
            const charName    = name2 ?? '';
            const userName    = name1 ?? '';
            const mode        = config.outputMode  ?? 'replaceKeyword';
            const callMode    = config.callMode    ?? 'once';
            const cacheKey    = `${ruleId}:${actionIdx}`;
            const historyText = buildHistoryText(stCtx?.chat, messageId, config.historyTurns ?? 0);
            const kwEsc       = matchedKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const mkRe        = () => new RegExp(kwEsc, 'gi');

            const mkPrompt = (paragraph = '') => interpolate(config.prompt ?? '', {
                keyword:   matchedKeyword ?? '',
                message:   msg?.mes ?? '',
                paragraph,
                history:   historyText,
                char:      charName,
                user:      userName,
            });

            if (!mkPrompt().trim()) return;

            const save = async () => {
                updateMessageBlock(messageId, msg);
                if (typeof stCtx.saveChat === 'function') await stCtx.saveChat();
                eventSource.emit(event_types.MESSAGE_UPDATED, messageId);
            };

            // replaceParagraph: replace the entire newline-bounded paragraph(s) containing the keyword.
            if (mode === 'replaceParagraph') {
                if (!msg) return;
                if (callMode === 'perMatch') {
                    const paragraphs = collectUniqueParagraphs(msg.mes, mkRe());
                    if (!paragraphs.length) return;
                    const cached = getPrefetchedResults(cacheKey) ?? [];
                    const n      = paragraphs.length;
                    const nc     = Math.min(cached.length, n);
                    const [pre, fresh] = await Promise.all([
                        Promise.all(cached.slice(0, nc)),
                        runQueued(paragraphs.slice(nc).map(p => () => dispatch(mkPrompt(p.text), config.profileId ?? null))),
                    ]);
                    const results = [...pre, ...fresh];
                    let built = msg.mes;
                    for (let i = n - 1; i >= 0; i--) {
                        if (!results[i]) continue;
                        built = built.slice(0, paragraphs[i].start) + results[i] + built.slice(paragraphs[i].end);
                    }
                    msg.mes = built;
                } else {
                    // once: first matching paragraph only
                    const firstMatch = mkRe().exec(msg.mes);
                    if (!firstMatch) return;
                    const p      = extractParagraph(msg.mes, firstMatch.index);
                    const cached = getPrefetchedResults(cacheKey);
                    let text;
                    try {
                        text = cached?.length ? await cached[0] : await dispatch(mkPrompt(p.text), config.profileId ?? null);
                    } catch (err) { console.error('[streameryze] sideCall replaceParagraph: dispatch failed', err); return; }
                    if (!text) return;
                    msg.mes = msg.mes.slice(0, p.start) + text + msg.mes.slice(p.end);
                }
                try { await save(); } catch (err) { console.error('[streameryze] sideCall replaceParagraph: render/save failed', err); }
                return;
            }

            // perMatch + replaceKeyword: one call per keyword instance.
            if (callMode === 'perMatch' && mode === 'replaceKeyword') {
                if (!msg) return;
                const matches = [...msg.mes.matchAll(mkRe())];
                if (!matches.length) return;
                const cached = getPrefetchedResults(cacheKey) ?? [];
                const nc     = Math.min(cached.length, matches.length);
                const [pre, fresh] = await Promise.all([
                    Promise.all(cached.slice(0, nc)),
                    runQueued(matches.slice(nc).map(() => () => dispatch(mkPrompt(), config.profileId ?? null))),
                ]);
                const results = [...pre, ...fresh];
                let built = msg.mes;
                for (let i = matches.length - 1; i >= 0; i--) {
                    if (!results[i]) continue;
                    const m = matches[i];
                    built = built.slice(0, m.index) + results[i] + built.slice(m.index + m[0].length);
                }
                msg.mes = built;
                try { await save(); } catch (err) { console.error('[streameryze] sideCall perMatch: render/save failed', err); }
                return;
            }

            // once: single LLM call, use prefetched promise if available.
            const cached = getPrefetchedResults(cacheKey);
            let text;
            try {
                text = cached?.length ? await cached[0] : await dispatch(mkPrompt(), config.profileId ?? null);
            } catch (err) { console.error('[streameryze] sideCall: dispatch failed', err); return; }

            if (!text || mode === 'silent') return;

            if (mode === 'replaceKeyword') {
                if (!msg) return;
                msg.mes = msg.mes.replace(mkRe(), text);
                try { await save(); } catch (err) { console.error('[streameryze] sideCall replaceKeyword: render/save failed', err); }
                return;
            }
            if (mode === 'appendToMessage') {
                if (!msg) return;
                msg.mes = msg.mes + '\n\n' + text;
                try { await save(); } catch (err) { console.error('[streameryze] sideCall appendToMessage: render/save failed', err); }
                return;
            }
            if (mode === 'insertMessage') {
                const newMsg = {
                    name: charName, is_user: false, is_system: false,
                    send_date: new Date().toLocaleString(),
                    mes: text, extra: {}, swipe_id: 0, swipes: [text],
                };
                stCtx.chat.splice(messageId + 1, 0, newMsg);
                try {
                    addOneMessage(newMsg, { insertAfter: messageId, scroll: true });
                    if (typeof stCtx.saveChat === 'function') await stCtx.saveChat();
                } catch (err) { console.error('[streameryze] sideCall insertMessage: failed', err); }
            }
        },

        renderConfig($el, config, onChange) {
            let profileOpts = `<option value="">main ST chat LLM (default)</option>`;
            try {
                for (const p of ConnectionManagerRequestService.getSupportedProfiles()) {
                    const sel = config.profileId === p.id ? ' selected' : '';
                    profileOpts += `<option value="${esc(p.id)}"${sel}>${esc(p.name)}</option>`;
                }
            } catch { /* Connection Manager not available */ }

            const s = (val, want) => val === want ? ' selected' : '';

            $el.html(`
<div class="smz-sc-wrap">
    <div class="smz-sc-row">
        <label class="smz-sc-lbl">connection</label>
        <select class="smz-cfg smz-sc-profile">${profileOpts}</select>
    </div>
    <div class="smz-sc-row">
        <label class="smz-sc-lbl">output</label>
        <select class="smz-cfg smz-sc-mode">
            <option value="replaceKeyword"  ${s(config.outputMode, 'replaceKeyword'  )}>replace keyword</option>
            <option value="replaceParagraph"${s(config.outputMode, 'replaceParagraph')}>replace paragraph</option>
            <option value="appendToMessage" ${s(config.outputMode, 'appendToMessage' )}>append to message</option>
            <option value="insertMessage"   ${s(config.outputMode, 'insertMessage'   )}>insert as message</option>
            <option value="silent"          ${s(config.outputMode, 'silent'          )}>silent (discard)</option>
        </select>
    </div>
    <div class="smz-sc-row">
        <label class="smz-sc-lbl">calls</label>
        <select class="smz-cfg smz-sc-callmode">
            <option value="once"    ${s(config.callMode, 'once'    )}>once — same result for all instances</option>
            <option value="perMatch"${s(config.callMode, 'perMatch')}>per match — independent call per instance</option>
        </select>
    </div>
    <div class="smz-sc-row">
        <label class="smz-sc-lbl">history</label>
        <input type="number" class="smz-cfg smz-sc-history" min="0" max="20" step="1"
            value="${config.historyTurns ?? 0}" style="width:54px" />
        <small class="smz-sc-hint-inline">turns  —  use {{history}} in prompt</small>
    </div>
    <textarea class="text_pole smz-cfg smz-sc-prompt" rows="3"
        placeholder="Prompt — {{keyword}} {{paragraph}} {{message}} {{history}} {{char}} {{user}}">${esc(config.prompt)}</textarea>
    <small class="smz-hint">{{keyword}} {{paragraph}} {{message}} {{history}} {{char}} {{user}}</small>
</div>`);

            const update = () => onChange({
                ...config,
                profileId:    $el.find('.smz-sc-profile').val() || null,
                outputMode:   $el.find('.smz-sc-mode').val(),
                callMode:     $el.find('.smz-sc-callmode').val(),
                historyTurns: parseInt($el.find('.smz-sc-history').val(), 10) || 0,
                prompt:       $el.find('.smz-sc-prompt').val(),
            });

            $el.find('.smz-sc-profile, .smz-sc-mode, .smz-sc-callmode').on('change', update);
            $el.find('.smz-sc-history').on('input', update);
            $el.find('.smz-sc-prompt').on('input', update);
        },
    },

};
