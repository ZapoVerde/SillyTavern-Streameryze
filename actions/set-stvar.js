/**
 * @file st-extensions/SillyTavern-Triggeryze/actions/set-stvar.js
 * @stamp {"utc":"2026-07-01T00:00:00.000Z"}
 * @architectural-role Registry — Set ST Variable action (write to ST chat or global variable store)
 * @description
 * Evaluates a template string and writes the result into an ST chat variable
 * (chat_metadata.variables) or global variable (extension_settings.variables.global).
 * ST variables persist across turns; chat variables are scoped to this chat file,
 * global variables are shared across all chats.
 *
 * @api-declaration
 * setStVar — action definition object for the ACTION_REGISTRY; preview(config, text) resolves
 *   the value template against sample text without writing to the ST variable store
 *
 * @contract
 *   assertions:
 *     purity:          none — writes to ST variable stores
 *     state_ownership: none (delegates to ST variables API)
 *     external_io:     setLocalVariable / setGlobalVariable (ST API), resolveLbTokens
 */

import { name1, name2 }                                                         from '../../../../../script.js';
import { setLocalVariable, setGlobalVariable }                                   from '../../../../../scripts/variables.js';
import { interpolate, resolveLbTokens }                                          from './template.js';
import { esc }                                                                   from './text.js';
import { renderVarLegend }                                                       from './var-legend.js';
import { trgDev }                                                                from '../logger.js';
import { testDrawerHtml, attachTestDrawer }                                      from '../triggers/test-drawer.js';
import { getTurnVarsSnapshot }                                                   from '../triggers/turn-vars.js';

// Resolves the value template against the given text and, if applyFn is given, invokes it with
// the resolved value in the SAME continuation — shared by execute() and preview(). setLocalVariable/
// setGlobalVariable is the only action-observable write that isn't gated by the engine's turn-var
// dependency mechanism (chatvar::/globalvar:: reads bypass it, since they aren't tracked by
// outputVar). Chaining the write as a second, separately-awaited step after resolution would add
// a microtask tick and let a same-turn compose action read the var before this action wrote it —
// so the write has to happen inside the same .then() as the interpolation, not after it.
function resolveAndApply(config, { matchedKeyword, highlighted, text, vars, messageId }, applyFn) {
    const kwEsc      = (matchedKeyword ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const firstMatch = kwEsc ? new RegExp(kwEsc, 'i').exec(text) : null;
    const upTo       = firstMatch ? text.slice(0, firstMatch.index) : '';
    return resolveLbTokens(config.value ?? '', matchedKeyword, highlighted, vars, messageId).then(resolved => {
        const value = interpolate(resolved, {
            keyword: matchedKeyword ?? '',
            message: text,
            'up-to': upTo,
            char:    name2 ?? '',
            user:    name1 ?? '',
        }, vars ?? {});
        applyFn?.(value);
        return value;
    });
}

export const setStVar = {
    label: 'Set ST variable',
    templateFields: cfg => [cfg.value],
    defaultConfig: { scope: 'chat', varName: '', key: '', value: '' },

    async execute(config, { matchedKeyword, messageId, stCtx, vars, debug, highlighted = '' }) {
        if (!config.varName) return;
        const text = stCtx?.chat?.[messageId]?.mes ?? '';
        await resolveAndApply(config, { matchedKeyword, highlighted, text, vars, messageId }, value => {
            const keyArg = config.key?.trim() ? { index: config.key.trim() } : {};
            trgDev(debug, `  setStVar ${config.scope}:${config.varName}${config.key ? `[${config.key}]` : ''} =`, value);
            if (config.scope === 'global') {
                setGlobalVariable(config.varName, value, keyArg);
            } else {
                setLocalVariable(config.varName, value, keyArg);
            }
        });
    },

    async preview(config, text) {
        if (!config.varName) return { hint: 'Set a variable name to preview.' };
        const value = await resolveAndApply(config, {
            matchedKeyword: '', highlighted: '', text, messageId: null,
            vars: getTurnVarsSnapshot(),
        }, null);
        const scope = config.scope === 'global' ? 'global' : 'chat';
        const name  = config.key?.trim() ? `${config.varName}[${config.key.trim()}]` : config.varName;
        return { output: `Would set ${scope} var ${name} =\n${value}` };
    },

    renderConfig($el, config, onChange, ctx) {
        $el.html(`
<div class="trg-sc-wrap">
    <div class="trg-sc-row">
        <label class="trg-sc-lbl">scope</label>
        <select class="trg-cfg trg-stv-scope">
            <option value="chat"   ${(config.scope ?? 'chat') !== 'global' ? 'selected' : ''}>chat — persists this conversation</option>
            <option value="global" ${config.scope === 'global'             ? 'selected' : ''}>global — persists across all chats</option>
        </select>
    </div>
    <div class="trg-sc-row">
        <label class="trg-sc-lbl">name</label>
        <input type="text" class="trg-cfg trg-stv-name" placeholder="variable name" value="${esc(config.varName ?? '')}" style="flex:1" />
    </div>
    <div class="trg-sc-row">
        <label class="trg-sc-lbl">key</label>
        <input type="text" class="trg-cfg trg-stv-key" placeholder="optional — object key or array index (e.g. hp, 0)" value="${esc(config.key ?? '')}" style="flex:1" />
    </div>
    ${renderVarLegend(ctx?.priorActions, ctx?.crossRuleVars, ctx?.globalVars)}
    <textarea class="text_pole trg-cfg trg-stv-value" rows="3"
        placeholder="value — supports {{variables}}, {{chatvar::stats.hp}}, {{math: expr}}">${esc(config.value ?? '')}</textarea>
    ${testDrawerHtml()}
</div>`);

        const read = () => ({
            ...config,
            scope:   $el.find('.trg-stv-scope').val(),
            varName: $el.find('.trg-stv-name').val().trim(),
            key:     $el.find('.trg-stv-key').val().trim(),
            value:   $el.find('.trg-stv-value').val(),
        });
        const update = () => onChange(read());
        const refreshTestDrawer = attachTestDrawer($el, read, (cfg, text) => setStVar.preview(cfg, text));
        $el.find('.trg-stv-scope, .trg-stv-name, .trg-stv-key, .trg-stv-value').on('input change', () => { update(); refreshTestDrawer(); });
        $el.on('click', '.trg-var-inject', function () {
            const token = $(this).data('token');
            const $ta   = $el.find('.trg-stv-value');
            const el    = $ta[0];
            if (!el) return;
            const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? s;
            el.value = el.value.slice(0, s) + token + el.value.slice(e);
            el.selectionStart = el.selectionEnd = s + token.length;
            $ta.trigger('input');
            el.focus();
        });
    },
};
