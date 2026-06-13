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

import { eventSource, event_types, generateQuietPrompt, name1, name2, addOneMessage, updateMessageBlock, appendMediaToMessage, callPopup } from '../../../../script.js';
import { ConnectionManagerRequestService } from '../../shared.js';
import { SOURCE_LABELS, loadModelsForSource, generatePreviewBlob, generateAndUpload } from './imageGen.js';

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

// ruleVars holds values produced by prior actions in the same rule execution.
// System vars (second argument) always take precedence over rule-produced vars.
// ---------------------------------------------------------------------------
// Template condition evaluator — used by {{#if}} blocks in compose variable
// Ported and extended from Personalyze/logic/computationalParser.js
// ---------------------------------------------------------------------------

function _evalAtomicCond(varName, op, rhs, lookup) {
    const raw  = lookup(varName);
    const val  = String(raw ?? '').trim();
    const valL = val.toLowerCase();
    const r    = (rhs ?? '').trim();
    const esc  = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    switch (op.toLowerCase()) {
        case 'matches':  { try { return new RegExp(r, 'i').test(val); } catch { return false; } }
        case 'contains': return valL.includes(r.toLowerCase());
        case 'is':       return new RegExp(`^\\b${esc(r.toLowerCase())}\\b$`, 'i').test(valL);
        case 'in': {
            const items = r.replace(/^\(|\)$/g, '').split(',').map(s => s.trim()).filter(Boolean);
            return items.some(item => new RegExp(`^\\b${esc(item)}\\b$`, 'i').test(valL));
        }
        case 'empty':    return !raw || valL === '' || valL === 'none' || valL === 'unspecified';
        default:         return false;
    }
}

// Reduces a string of true/false/AND/OR/!/() tokens to a boolean.
// Operator precedence: ! > AND > OR. Parentheses override.
function _boolAlgebra(str) {
    str = str.trim();
    while (str.includes('(')) {
        const prev = str;
        str = str.replace(/\(([^()]+)\)/g, (_, g) => _boolAlgebra(g) ? 'true' : 'false');
        if (str === prev) break;
    }
    while (/!\s*(true|false)\b/i.test(str))
        str = str.replace(/!\s*true\b/gi, 'false').replace(/!\s*false\b/gi, 'true');
    while (/\b(true|false)\s+AND\s+(true|false)\b/i.test(str))
        str = str.replace(/\b(true|false)\s+AND\s+(true|false)\b/gi,
            (_, l, r) => l.toLowerCase() === 'true' && r.toLowerCase() === 'true' ? 'true' : 'false');
    while (/\b(true|false)\s+OR\s+(true|false)\b/i.test(str))
        str = str.replace(/\b(true|false)\s+OR\s+(true|false)\b/gi,
            (_, l, r) => l.toLowerCase() === 'true' || r.toLowerCase() === 'true' ? 'true' : 'false');
    return str.toLowerCase().trim() === 'true';
}

const _VNAME = '[a-zA-Z0-9_-]+';

function _evalCondition(cond, lookup) {
    let e = cond;
    // empty (no rhs)
    e = e.replace(new RegExp(`(${_VNAME})\\s+empty\\b`, 'gi'),
        (_, v) => _evalAtomicCond(v, 'empty', null, lookup) ? 'true' : 'false');
    // in (list)
    e = e.replace(new RegExp(`(${_VNAME})\\s+in\\s+\\(([^)]+)\\)`, 'gi'),
        (_, v, list) => _evalAtomicCond(v, 'in', list, lookup) ? 'true' : 'false');
    // matches / contains / is "rhs"
    e = e.replace(new RegExp(`(${_VNAME})\\s+(matches|contains|is)\\s+"([^"]*)"`, 'gi'),
        (_, v, op, rhs) => _evalAtomicCond(v, op, rhs, lookup) ? 'true' : 'false');
    try { return _boolAlgebra(e); } catch { return false; }
}

function interpolate(template, vars, ruleVars = {}) {
    const lookup = (name) => vars[name] ?? ruleVars[name] ?? '';

    // {{#if condition}}body{{/if}}
    // Condition uses bare variable names (no {{}}). Body may contain {{varName}} tokens.
    let out = template.replace(
        /\{\{#if\s+([\s\S]*?)\}\}([\s\S]*?)\{\{\/if\}\}/g,
        (_, cond, body) => _evalCondition(cond, lookup) ? body : '',
    );

    // {{varName}} — simple substitution
    return out.replace(/\{\{([^{}]+)\}\}/g, (_, key) => lookup(key.trim()));
}

/**
 * Builds the click-to-inject variable chip legend shown above prompt inputs.
 * System vars (gray) are always available. Rule-produced vars (amber) come from
 * prior actions in the same rule that have config.outputVar set.
 * ACTION_REGISTRY is referenced by name — safe because this is only called after
 * the module has fully initialised (from within renderConfig handlers).
 */
function renderVarLegend(priorActions) {
    const sys = [
        { n: 'keyword',   h: 'matched keyword' },
        { n: 'up-to',     h: 'text before keyword' },
        { n: 'message',   h: 'full message (postMessage)' },
        { n: 'paragraph', h: 'paragraph containing keyword' },
        { n: 'history',   h: 'chat history' },
        { n: 'char',      h: 'character name' },
        { n: 'user',      h: 'user name' },
    ];
    const rule = (priorActions ?? [])
        .filter(a => a.config?.outputVar)
        .map(a => ({ n: a.config.outputVar, h: `from ${ACTION_REGISTRY[a.type]?.label ?? a.type}` }));
    const chip = (v, cls) =>
        `<span class="smz-var-chip ${cls} smz-var-inject" data-token="{{${esc(v.n)}}}" title="${esc(v.h)}">{{${esc(v.n)}}}</span>`;
    return `<div class="smz-var-legend">${
        sys.map(v => chip(v, 'smz-var-chip-sys')).join('')
    }${rule.length ? `<span class="smz-var-legend-sep"></span>${rule.map(v => chip(v, 'smz-var-chip-rule')).join('')}` : ''}</div>`;
}

// Count of active background LLM dispatches. When non-zero, engine.onGenerationStarted
// must not clear Streameryze's per-generation state — the GENERATION_STARTED event it
// sees is from a quiet/background call, not a real new generation.
let _activeDispatches = 0;
export function isDispatchActive() { return _activeDispatches > 0; }

/**
 * Dispatches a prompt to an LLM.
 * Tries the Connection Manager profile first (if profileId set), then falls back
 * to the main ST chat LLM via generateQuietPrompt.
 */
async function dispatch(prompt, profileId, debug = false) {
    _activeDispatches++;
    const tStart = performance.now();
    if (debug) console.log('[SMZ:dev] >>> LLM prompt:\n' + prompt);
    try {
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

        const text = String(result?.content ?? result ?? '').trim();
        if (debug) console.log(`[SMZ:dev] <<< LLM result (${Math.round(performance.now() - tStart)}ms):\n` + text);
        return text;
    } finally {
        _activeDispatches--;
    }
}

// Wraps dispatch() with Loggeryze waterfall timing for prefetch calls that fire
// during streaming. time/timeEnd are no-ops outside an active turn, so this is
// safe to call unconditionally — but only meaningful when a turn is live.
function prefetchDispatch(prompt, profileId) {
    window.loggeryze?.time('Streameryze: sideCall [non-blocking]');
    return dispatch(prompt, profileId)
        .then(r  => { window.loggeryze?.timeEnd('Streameryze: sideCall [non-blocking]'); return r; })
        .catch(() => { window.loggeryze?.timeEnd('Streameryze: sideCall [non-blocking]'); return null; });
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

    const mkPrompt = (paragraph = '', upTo = '') => interpolate(config.prompt ?? '', {
        keyword:   matchedKeyword ?? '',
        message:   streamText,
        paragraph,
        history:   historyText,
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
        async execute(config, { matchedKeyword, messageId, stCtx, vars }) {
            const msg = stCtx?.chat?.[messageId];
            if (!msg) return;
            const re          = new RegExp(matchedKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
            const replacement = interpolate(config.replacement ?? '', { keyword: matchedKeyword }, vars ?? {});
            const updated     = msg.mes.replace(re, replacement);
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
        renderConfig($el, config, onChange, ctx) {
            $el.html(`${renderVarLegend(ctx?.priorActions)}
<input type="text" class="text_pole smz-cfg smz-replace-input" placeholder="replacement — blank to delete. Use {{varName}} to inject a step result." value="${esc(config.replacement)}" />`);
            $el.find('.smz-replace-input').on('input', function () { onChange({ ...config, replacement: this.value }); });
            $el.on('click', '.smz-var-inject', function () {
                const token = $(this).data('token');
                const $inp  = $el.find('.smz-replace-input');
                const el    = $inp[0];
                if (!el) return;
                const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? s;
                el.value = el.value.slice(0, s) + token + el.value.slice(e);
                el.selectionStart = el.selectionEnd = s + token.length;
                $inp.trigger('input');
                el.focus();
            });
        },
    },

    sideCall: {
        label: 'call LLM',
        stage: 'postMessage',
        defaultConfig: { prompt: '', profileId: null, outputMode: 'replaceKeyword', callMode: 'once', historyTurns: 0, outputVar: '' },

        async execute(config, { matchedKeyword, messageId, stCtx, ruleId, actionIdx, isCurrentGeneration, vars, debug }) {
            const msg         = stCtx?.chat?.[messageId];
            const charName    = name2 ?? '';
            const userName    = name1 ?? '';
            const mode        = config.outputMode  ?? 'replaceKeyword';
            const callMode    = config.callMode    ?? 'once';
            const cacheKey    = `${ruleId}:${actionIdx}`;
            const historyText = buildHistoryText(stCtx?.chat, messageId, config.historyTurns ?? 0);
            const kwEsc       = matchedKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const mkRe        = () => new RegExp(kwEsc, 'gi');

            const mkPrompt = (paragraph = '', upTo = '') => interpolate(config.prompt ?? '', {
                keyword:   matchedKeyword ?? '',
                message:   msg?.mes ?? '',
                paragraph,
                history:   historyText,
                'up-to':   upTo,
                char:      charName,
                user:      userName,
            }, vars ?? {});

            if (!mkPrompt().trim()) return;

            const save = async () => {
                if (isCurrentGeneration && !isCurrentGeneration()) return;
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
                        runQueued(paragraphs.slice(nc).map(p => () => dispatch(mkPrompt(p.text, msg.mes.slice(0, p.start)), config.profileId ?? null, debug))),
                    ]);
                    if (isCurrentGeneration && !isCurrentGeneration()) return;
                    const results = [...pre, ...fresh];
                    let built = msg.mes;
                    for (let i = n - 1; i >= 0; i--) {
                        if (!results[i]) continue;
                        built = built.slice(0, paragraphs[i].start) + results[i] + built.slice(paragraphs[i].end);
                    }
                    msg.mes = built;
                } else {
                    const firstMatch = mkRe().exec(msg.mes);
                    if (!firstMatch) return;
                    const p      = extractParagraph(msg.mes, firstMatch.index);
                    const upTo   = msg.mes.slice(0, firstMatch.index);
                    const cached = getPrefetchedResults(cacheKey);
                    let text;
                    try {
                        text = cached?.length ? await cached[0] : await dispatch(mkPrompt(p.text, upTo), config.profileId ?? null, debug);
                    } catch (err) { console.error('[streameryze] sideCall replaceParagraph: dispatch failed', err); return; }
                    if (!text || (isCurrentGeneration && !isCurrentGeneration())) return;
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
                    runQueued(matches.slice(nc).map(m => () => dispatch(mkPrompt('', msg.mes.slice(0, m.index)), config.profileId ?? null, debug))),
                ]);
                if (isCurrentGeneration && !isCurrentGeneration()) return;
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
            const firstMatch = mkRe().exec(msg?.mes ?? '');
            const upTo       = firstMatch ? (msg?.mes ?? '').slice(0, firstMatch.index) : '';
            const cached     = getPrefetchedResults(cacheKey);
            if (debug && cached?.length) console.log(`[SMZ:dev]   [${actionIdx}] sideCall using prefetch cache`);
            let text;
            try {
                text = cached?.length ? await cached[0] : await dispatch(mkPrompt('', upTo), config.profileId ?? null, debug);
            } catch (err) { console.error('[streameryze] sideCall: dispatch failed', err); return; }
            if (debug && cached?.length) console.log(`[SMZ:dev]   [${actionIdx}] sideCall prefetch result:`, text);

            if (!text || (isCurrentGeneration && !isCurrentGeneration())) return;
            if (config.outputVar && vars) vars[config.outputVar] = text;
            if (mode === 'silent') return;

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

        renderConfig($el, config, onChange, ctx) {
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
        <label class="smz-sc-lbl">save as</label>
        <input type="text" class="smz-cfg smz-sc-outvar" placeholder="variable name (optional)" value="${esc(config.outputVar ?? '')}" style="flex:1" />
    </div>
    <div class="smz-sc-row">
        <label class="smz-sc-lbl">history</label>
        <input type="number" class="smz-cfg smz-sc-history" min="0" max="20" step="1"
            value="${config.historyTurns ?? 0}" style="width:54px" />
        <small class="smz-sc-hint-inline">turns  —  use {{history}} in prompt</small>
    </div>
    ${renderVarLegend(ctx?.priorActions)}
    <textarea class="text_pole smz-cfg smz-sc-prompt" rows="3"
        placeholder="Prompt — {{keyword}} {{up-to}} {{paragraph}} {{message}} {{history}} {{char}} {{user}}">${esc(config.prompt)}</textarea>
</div>`);

            const update = () => onChange({
                ...config,
                profileId:    $el.find('.smz-sc-profile').val() || null,
                outputMode:   $el.find('.smz-sc-mode').val(),
                callMode:     $el.find('.smz-sc-callmode').val(),
                outputVar:    $el.find('.smz-sc-outvar').val().trim(),
                historyTurns: parseInt($el.find('.smz-sc-history').val(), 10) || 0,
                prompt:       $el.find('.smz-sc-prompt').val(),
            });

            $el.find('.smz-sc-profile, .smz-sc-mode, .smz-sc-callmode').on('change', update);
            $el.find('.smz-sc-history, .smz-sc-outvar').on('input', update);
            $el.find('.smz-sc-prompt').on('input', update);
            $el.on('click', '.smz-var-inject', function () {
                const token = $(this).data('token');
                const $ta   = $el.find('.smz-sc-prompt');
                const el    = $ta[0];
                if (!el) return;
                const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? s;
                el.value = el.value.slice(0, s) + token + el.value.slice(e);
                el.selectionStart = el.selectionEnd = s + token.length;
                $ta.trigger('input');
                el.focus();
            });
        },
    },

    compose: {
        label: 'compose variable',
        stage: 'postMessage',
        defaultConfig: { outputVar: '', template: '' },
        async execute(config, { matchedKeyword, messageId, stCtx, vars, debug }) {
            if (!config.outputVar || !vars) return;
            const msg  = stCtx?.chat?.[messageId];
            const text = msg?.mes ?? '';
            const kwEsc     = (matchedKeyword ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const firstMatch = kwEsc ? new RegExp(kwEsc, 'i').exec(text) : null;
            const upTo      = firstMatch ? text.slice(0, firstMatch.index) : '';
            const result = interpolate(config.template ?? '', {
                keyword: matchedKeyword ?? '',
                message: text,
                'up-to': upTo,
                char:    name2 ?? '',
                user:    name1 ?? '',
            }, vars);
            if (debug) console.log(`[SMZ:dev]   compose "${config.outputVar}" =`, result);
            vars[config.outputVar] = result;
        },
        renderConfig($el, config, onChange, ctx) {
            $el.html(`
<div class="smz-sc-wrap">
    <div class="smz-sc-row">
        <label class="smz-sc-lbl">name</label>
        <input type="text" class="smz-cfg smz-cv-name" placeholder="variable name" value="${esc(config.outputVar ?? '')}" style="flex:1" />
    </div>
    ${renderVarLegend(ctx?.priorActions)}
    <textarea class="text_pole smz-cfg smz-cv-template" rows="3"
        placeholder="{{#if keyword matches &quot;breath|hitch&quot;}}Forced Physical Reaction Cliché&#10;{{/if}}{{#if keyword is &quot;stone&quot;}}Purple Prose Metaphor&#10;{{/if}}">${esc(config.template ?? '')}</textarea>
<div class="smz-kw-footer">
    <span class="smz-help-toggle" title="Template language quick reference">?</span>
</div>
<div class="smz-help-text" style="display:none;">
    <b>{{varName}}</b> — insert variable &nbsp;&nbsp; <b>{{#if condition}}…{{/if}}</b> — conditional block<br>
    Condition operators: <span class="smz-help-eg">matches "regex"</span> &nbsp; <span class="smz-help-eg">contains "text"</span> &nbsp; <span class="smz-help-eg">is "value"</span> &nbsp; <span class="smz-help-eg">in (a, b, c)</span> &nbsp; <span class="smz-help-eg">empty</span><br>
    Combinators: <span class="smz-help-eg">AND</span> &nbsp; <span class="smz-help-eg">OR</span> &nbsp; <span class="smz-help-eg">!</span> &nbsp; <span class="smz-help-eg">( )</span> — see the Template Language reference drawer for full docs.
</div>
</div>`);

            const update = () => onChange({
                ...config,
                outputVar: $el.find('.smz-cv-name').val().trim(),
                template:  $el.find('.smz-cv-template').val(),
            });
            $el.find('.smz-cv-name, .smz-cv-template').on('input', update);
            $el.find('.smz-help-toggle').on('click', function () {
                $el.find('.smz-help-text').slideToggle(150);
                $(this).toggleClass('smz-help-open');
            });
            $el.on('click', '.smz-var-inject', function () {
                const token = $(this).data('token');
                const $ta   = $el.find('.smz-cv-template');
                const el    = $ta[0];
                if (!el) return;
                const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? s;
                el.value = el.value.slice(0, s) + token + el.value.slice(e);
                el.selectionStart = el.selectionEnd = s + token.length;
                $ta.trigger('input');
                el.focus();
            });
        },
    },

    imageGen: {
        label: 'generate image',
        stage: 'postMessage',
        defaultConfig: { source: 'pollinations', model: '', comfyUiUrl: '', prompt: '{{keyword}}', historyTurns: 0, outputVar: '', persist: true },

        async execute(config, { matchedKeyword, messageId, stCtx, isCurrentGeneration, vars }) {
            const msg = stCtx?.chat?.[messageId];
            if (!msg) return;
            if (!msg.extra || typeof msg.extra !== 'object') msg.extra = {};

            const kwEsc       = (matchedKeyword ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const firstMatch  = kwEsc ? new RegExp(kwEsc, 'i').exec(msg.mes ?? '') : null;
            const upTo        = firstMatch ? (msg.mes ?? '').slice(0, firstMatch.index) : '';
            const historyText = buildHistoryText(stCtx?.chat, messageId, config.historyTurns ?? 0);

            const prompt = interpolate(config.prompt ?? '', {
                keyword:  matchedKeyword ?? '',
                message:  msg.mes ?? '',
                'up-to':  upTo,
                history:  historyText,
                char:     name2 ?? '',
                user:     name1 ?? '',
            }, vars ?? {});
            if (!prompt.trim()) return;

            // Fire-and-forget — image generation can take many seconds and must not
            // block onMessageReceived (which would lock the ST send button).
            // All state needed is captured in the closure; the swipe guard
            // (isCurrentGeneration) still cancels stale results if the user swipes.
            (async () => {
                let imagePath;
                const tImg = performance.now();
                try {
                    imagePath = await generateAndUpload(prompt, config, stCtx?.name2 ?? name2 ?? 'streameryze');
                    console.info(`[SMZ:PERF] imageGen | source=${config.source ?? 'pollinations'} | ${Math.round(performance.now() - tImg)}ms`);
                } catch (err) {
                    console.error('[streameryze] imageGen: generation failed', err);
                    window.toastr?.error(`Image generation failed: ${err.message.slice(0, 80)}`, 'Streameryze');
                    return;
                }

                // Swipe guard: abort if the generation this action belonged to is no longer current
                if (!imagePath || (isCurrentGeneration && !isCurrentGeneration())) return;

                if (config.outputVar && vars) vars[config.outputVar] = imagePath;

                const persist = config.persist ?? true;
                if (persist) {
                    if (!Array.isArray(msg.extra.media)) msg.extra.media = [];
                    msg.extra.media.push({ url: imagePath, type: 'image', source: 'generated', title: matchedKeyword ?? '' });
                    msg.extra.media_display ??= 'gallery';
                    msg.extra.media_index = msg.extra.media.length - 1;
                    msg.extra.inline_image = true;
                }

                try {
                    const $mesEl = $(`.mes[mesid="${messageId}"]`);
                    if ($mesEl.length) appendMediaToMessage(msg, $mesEl, 'keep');
                    if (persist && typeof stCtx.saveChat === 'function') await stCtx.saveChat();
                    if (persist) eventSource.emit(event_types.MESSAGE_UPDATED, messageId);
                } catch (err) {
                    console.error('[streameryze] imageGen: render/save failed', err);
                }
            })();
            // Return immediately — caller is not blocked by the image request
        },

        renderConfig($el, config, onChange, ctx) {
            const srcOpts = Object.entries(SOURCE_LABELS)
                .map(([val, text]) => {
                    const sel = val === (config.source || 'pollinations') ? ' selected' : '';
                    return `<option value="${val}"${sel}>${text}</option>`;
                })
                .join('');

            const isComfy = (config.source || 'pollinations') === 'comfy';

            $el.html(`
<div class="smz-ig-wrap">
    <div class="smz-sc-row">
        <label class="smz-sc-lbl">source</label>
        <select class="smz-ig-source text_pole" style="flex:1">${srcOpts}</select>
    </div>
    <div class="smz-sc-row smz-ig-model-row"${isComfy ? ' style="display:none"' : ''}>
        <label class="smz-sc-lbl">model</label>
        <div class="smz-ig-model-ctrl" style="flex:1;min-width:0">
            <input type="text" class="text_pole" placeholder="loading…" disabled style="width:100%" />
        </div>
    </div>
    <div class="smz-sc-row smz-ig-comfy-row"${!isComfy ? ' style="display:none"' : ''}>
        <label class="smz-sc-lbl">ComfyUI URL</label>
        <input type="text" class="smz-ig-comfy text_pole" style="flex:1"
            value="${esc(config.comfyUiUrl || '')}" placeholder="http://127.0.0.1:8188" />
    </div>
    <div class="smz-sc-row">
        <label class="smz-sc-lbl">history</label>
        <input type="number" class="smz-ig-history" min="0" max="20" step="1"
            value="${config.historyTurns ?? 0}" style="width:54px" />
        <small class="smz-sc-hint-inline">turns  —  use {{history}} in prompt</small>
    </div>
    <div class="smz-sc-row">
        <label class="smz-sc-lbl">save as</label>
        <input type="text" class="smz-ig-outvar text_pole" placeholder="variable name (optional)" value="${esc(config.outputVar ?? '')}" style="flex:1" />
    </div>
    ${renderVarLegend(ctx?.priorActions)}
    <textarea class="smz-ig-prompt text_pole" rows="2"
        placeholder="Image prompt — {{keyword}} {{up-to}} {{message}} {{history}} {{char}} {{user}}">${esc(config.prompt || '')}</textarea>
    <div class="smz-sc-row">
        <label class="smz-check-row">
            <input type="checkbox" class="smz-ig-persist" ${(config.persist ?? true) ? 'checked' : ''} />
            persist in chat
        </label>
        <small class="smz-sc-hint-inline" style="margin-left:8px">uncheck for ephemeral (shown this session only)</small>
    </div>
    <div class="smz-ig-footer">
        <button class="smz-ig-test menu_button">Test</button>
        <span class="smz-ig-test-status"></span>
    </div>
</div>`);

            const readConfig = () => ({
                source:       $el.find('.smz-ig-source').val() || 'pollinations',
                model:        ($el.find('.smz-ig-model-ctrl select, .smz-ig-model-ctrl input').first().val() ?? '').trim(),
                comfyUiUrl:   $el.find('.smz-ig-comfy').val()?.trim() || '',
                historyTurns: parseInt($el.find('.smz-ig-history').val(), 10) || 0,
                outputVar:    $el.find('.smz-ig-outvar').val()?.trim() || '',
                prompt:       $el.find('.smz-ig-prompt').val() || '',
                persist:      $el.find('.smz-ig-persist').prop('checked'),
            });

            const refreshModelControl = async (source, currentModel) => {
                const $modelRow = $el.find('.smz-ig-model-row');
                const $comfyRow = $el.find('.smz-ig-comfy-row');
                const $ctrl     = $el.find('.smz-ig-model-ctrl');

                if (source === 'comfy') {
                    $modelRow.hide();
                    $comfyRow.show();
                    return;
                }
                $comfyRow.hide();
                $modelRow.show();
                $ctrl.html('<input type="text" class="text_pole" placeholder="loading…" disabled style="width:100%" />');

                const models = await loadModelsForSource(source);
                $ctrl.empty();

                if (models && models.length) {
                    const $sel = $('<select class="text_pole" style="width:100%"></select>');
                    models.forEach(m => {
                        const val  = m.value ?? m;
                        const text = m.text  ?? m;
                        $sel.append($('<option>', { value: val, text }));
                    });
                    $sel.val(currentModel || '');
                    if (!$sel.val()) $sel.val(models[0].value ?? models[0]);
                    $sel.on('change', () => onChange(readConfig()));
                    $ctrl.append($sel);
                } else {
                    const $inp = $('<input type="text" class="text_pole" placeholder="model name (blank for default)" style="width:100%" />');
                    $inp.val(currentModel || '');
                    $inp.on('input', () => onChange(readConfig()));
                    $ctrl.append($inp);
                }
            };

            refreshModelControl(config.source || 'pollinations', config.model ?? '');

            $el.find('.smz-ig-source').on('change', function () {
                const cfg = readConfig();
                onChange(cfg);
                refreshModelControl($(this).val(), cfg.model);
            });

            $el.find('.smz-ig-comfy').on('input', () => onChange(readConfig()));
            $el.find('.smz-ig-history, .smz-ig-outvar').on('input', () => onChange(readConfig()));
            $el.find('.smz-ig-prompt').on('input', () => onChange(readConfig()));
            $el.find('.smz-ig-persist').on('change', () => onChange(readConfig()));
            $el.on('click', '.smz-var-inject', function () {
                const token = $(this).data('token');
                const $ta   = $el.find('.smz-ig-prompt');
                const el    = $ta[0];
                if (!el) return;
                const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? s;
                el.value = el.value.slice(0, s) + token + el.value.slice(e);
                el.selectionStart = el.selectionEnd = s + token.length;
                $ta.trigger('input');
                el.focus();
            });

            $el.find('.smz-ig-test').on('click', async function () {
                const $btn    = $(this);
                const $status = $el.find('.smz-ig-test-status');
                const cfg     = readConfig();
                const prompt  = cfg.prompt.trim() || 'a scene image';

                $btn.prop('disabled', true).text('Generating…');
                $status.text('');

                try {
                    const blobUrl = await generatePreviewBlob(prompt, cfg);
                    $status.html('<span style="color:var(--SmartThemeQuoteColor,#28a745)">✓ OK</span>');
                    await callPopup(
                        `<h3 style="margin-top:0">Streameryze — Image Test</h3>
                         <p style="opacity:.7;font-size:.85em;margin-bottom:8px">${esc(prompt)}</p>
                         <img src="${esc(blobUrl)}" style="width:100%;border-radius:6px" />`,
                        'text',
                    );
                    URL.revokeObjectURL(blobUrl);
                } catch (err) {
                    $status.html(`<span style="color:var(--SmartThemeErrorColor,#dc3545)">✗ ${esc(err.message.slice(0, 100))}</span>`);
                } finally {
                    $btn.prop('disabled', false).text('Test');
                }
            });
        },
    },

};
