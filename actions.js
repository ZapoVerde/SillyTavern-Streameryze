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
 * ACTION_REGISTRY — map of type key → action definition
 *
 * Execution context shape:
 *   stream stage:      { matchedKeyword: string, stCtx: object }
 *   postMessage stage: { matchedKeyword: string, messageId: number, stCtx: object }
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
        defaultConfig: { prompt: '', profileId: null, outputMode: 'replaceKeyword' },

        async execute(config, { matchedKeyword, messageId, stCtx }) {
            const msg      = stCtx?.chat?.[messageId];
            const charName = name2 ?? '';
            const userName = name1 ?? '';
            const mode     = config.outputMode ?? 'replaceKeyword';

            const buildPrompt = () => interpolate(config.prompt ?? '', {
                keyword: matchedKeyword ?? '',
                message: msg?.mes ?? '',
                char:    charName,
                user:    userName,
            });

            if (!buildPrompt().trim()) return;

            // Find every instance of the matched keyword (case-insensitive).
            // One queued LLM call is fired per instance so each gets an independent
            // result. Serial queue (concurrency=1) avoids shared-state collisions in
            // generateQuietPrompt, matching the Canonize executor pattern.
            const re      = new RegExp(matchedKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
            const matches = mode === 'replaceKeyword' ? [...(msg?.mes ?? '').matchAll(re)] : [null];

            let results;
            try {
                results = await runQueued(
                    matches.map(() => () => dispatch(buildPrompt(), config.profileId ?? null)),
                );
            } catch (err) {
                console.error('[streameryze] sideCall: dispatch failed', err);
                return;
            }

            if (mode === 'silent') return;

            if (mode === 'replaceKeyword') {
                if (!msg) return;
                // Rebuild message backwards so index positions stay valid.
                let built = msg.mes;
                for (let i = matches.length - 1; i >= 0; i--) {
                    if (!results[i]) continue;
                    const m = matches[i];
                    built = built.slice(0, m.index) + results[i] + built.slice(m.index + m[0].length);
                }
                msg.mes = built;
                try {
                    updateMessageBlock(messageId, msg);
                    if (typeof stCtx.saveChat === 'function') await stCtx.saveChat();
                    eventSource.emit(event_types.MESSAGE_UPDATED, messageId);
                } catch (err) { console.error('[streameryze] sideCall replaceKeyword: render/save failed', err); }
                return;
            }

            const text = results[0];
            if (!text) return;

            if (mode === 'appendToMessage') {
                if (!msg) return;
                msg.mes = msg.mes + '\n\n' + text;
                try {
                    updateMessageBlock(messageId, msg);
                    if (typeof stCtx.saveChat === 'function') await stCtx.saveChat();
                    eventSource.emit(event_types.MESSAGE_UPDATED, messageId);
                } catch (err) { console.error('[streameryze] sideCall appendToMessage: render/save failed', err); }
                return;
            }

            if (mode === 'insertMessage') {
                const newMsg = {
                    name:      charName,
                    is_user:   false,
                    is_system: false,
                    send_date: new Date().toLocaleString(),
                    mes:       text,
                    extra:     {},
                    swipe_id:  0,
                    swipes:    [text],
                };
                stCtx.chat.splice(messageId + 1, 0, newMsg);
                try {
                    addOneMessage(newMsg, { insertAfter: messageId, scroll: true });
                    if (typeof stCtx.saveChat === 'function') await stCtx.saveChat();
                } catch (err) { console.error('[streameryze] sideCall insertMessage: failed', err); }
                return;
            }
        },

        renderConfig($el, config, onChange) {
            // Build Connection Manager profile options.
            // Falls back gracefully if the extension is disabled or unavailable.
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
            <option value="replaceKeyword" ${s(config.outputMode, 'replaceKeyword' )}>replace keyword</option>
            <option value="appendToMessage"${s(config.outputMode, 'appendToMessage')}>append to message</option>
            <option value="insertMessage"  ${s(config.outputMode, 'insertMessage'  )}>insert as message</option>
            <option value="silent"         ${s(config.outputMode, 'silent'         )}>silent (discard)</option>
        </select>
    </div>
    <textarea class="text_pole smz-cfg smz-sc-prompt" rows="3"
        placeholder="Prompt template. Use {{keyword}}, {{message}}, {{char}}, {{user}}">${esc(config.prompt)}</textarea>
    <small class="smz-hint">Placeholders: {{keyword}} {{message}} {{char}} {{user}}</small>
</div>`);

            const update = () => onChange({
                ...config,
                profileId:  $el.find('.smz-sc-profile').val() || null,
                outputMode: $el.find('.smz-sc-mode').val(),
                prompt:     $el.find('.smz-sc-prompt').val(),
            });

            $el.find('.smz-sc-profile, .smz-sc-mode').on('change', update);
            $el.find('.smz-sc-prompt').on('input', update);
        },
    },

};
