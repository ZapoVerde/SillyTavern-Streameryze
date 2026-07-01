/**
 * @file st-extensions/SillyTavern-Triggeryze/actions/slash-cmd.js
 * @stamp {"utc":"2026-07-01T00:00:00.000Z"}
 * @architectural-role Registry — slashCmd action (ST slash command execution)
 * @description
 * Executes one or more ST slash commands with {{variable}} interpolation.
 * The pipe result of the last command is optionally written to a turn variable.
 * Valid at both stream and postMessage stages; pair with a chat-complete trigger
 * to restrict to after the message is received.
 *
 * @api-declaration
 * slashCmd — action definition object for the ACTION_REGISTRY; preview(config, text) resolves
 *   the command string only — it is never executed by preview, since slash commands can have
 *   arbitrary side effects
 *
 * @contract
 *   assertions:
 *     purity:          none — calls stCtx.executeSlashCommandsWithOptions, writes to vars
 *     state_ownership: none
 *     external_io:     stCtx.executeSlashCommandsWithOptions, resolveLbTokens (lorebook read)
 */

import { name1, name2 } from '../../../../../script.js';
import { interpolate, resolveLbTokens } from './template.js';
import { esc, extractParagraph } from './text.js';
import { renderVarLegend } from './var-legend.js';
import { trgDev } from '../logger.js';
import { testDrawerHtml, attachTestDrawer } from '../triggers/test-drawer.js';
import { getTurnVarsSnapshot } from '../triggers/turn-vars.js';

// Resolves the command string against the given text — shared by execute() and preview().
// preview() stops here; it never calls executeSlashCommandsWithOptions.
async function resolve(config, { matchedKeyword, highlighted, text, vars, messageId }) {
    const kwEsc      = (matchedKeyword ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const firstMatch = kwEsc ? new RegExp(kwEsc, 'i').exec(text) : null;
    const upTo       = firstMatch ? text.slice(0, firstMatch.index) : '';
    const paragraph  = firstMatch ? extractParagraph(text, firstMatch.index).text : '';

    const resolvedCmd = await resolveLbTokens(config.command ?? '', matchedKeyword, highlighted, vars, messageId);
    return interpolate(resolvedCmd, {
        keyword:   matchedKeyword ?? '',
        message:   text,
        'up-to':   upTo,
        paragraph,
        char:      name2 ?? '',
        user:      name1 ?? '',
    }, vars ?? {});
}

export const slashCmd = {
    label: 'slash commands',
    templateFields: cfg => [cfg.command],
    defaultConfig: { command: '', outputVar: '' },

    async execute(config, { matchedKeyword, messageId, stCtx, vars, debug, highlighted = '' }) {
        const chatIdx = messageId ?? ((stCtx?.chat?.length ?? 1) - 1);
        const text    = stCtx?.chat?.[chatIdx]?.mes ?? '';
        const cmd     = await resolve(config, { matchedKeyword, highlighted, text, vars, messageId });

        trgDev(debug, `  slashCmd:`, cmd);

        const result = await stCtx.executeSlashCommandsWithOptions(cmd);

        trgDev(debug && result?.pipe != null, `  slashCmd pipe:`, result?.pipe);

        if (config.outputVar && vars && result?.pipe != null) {
            vars[config.outputVar] = result.pipe;
        }
    },

    async preview(config, text) {
        if (!config.command) return { hint: 'Set a command to preview.' };
        const cmd = await resolve(config, {
            matchedKeyword: '', highlighted: '', text, messageId: null,
            vars: getTurnVarsSnapshot(),
        });
        return { output: `Would run:\n${cmd}` };
    },

    renderConfig($el, config, onChange, ctx) {
        $el.html(`
<div class="trg-sc-wrap">
    <small class="trg-hint trg-hint-warn">Fires at stream stage and after message — pair with an <em>event: chat complete</em> trigger (all) to restrict to after the message is received.</small>
    <div class="trg-sc-row" style="margin-top:6px">
        <label class="trg-sc-lbl">save as</label>
        <input type="text" class="trg-cfg trg-slashcmd-outvar trg-outvar-field" placeholder="variable name (optional)" value="${esc(config.outputVar ?? '')}" style="flex:1" />
    </div>
    ${renderVarLegend(ctx?.priorActions, ctx?.crossRuleVars, ctx?.globalVars)}
    <textarea class="text_pole trg-cfg trg-slashcmd-cmd" rows="4"
        placeholder="/setvar key=mood value=&quot;{{keyword}}&quot;&#10;/trigger id=myQR">${esc(config.command ?? '')}</textarea>
    ${testDrawerHtml()}
</div>`);

        $el.on('click', '.trg-var-inject', function () {
            const token = $(this).data('token');
            const $ta   = $el.find('.trg-slashcmd-cmd');
            const el    = $ta[0];
            if (!el) return;
            const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? s;
            el.value = el.value.slice(0, s) + token + el.value.slice(e);
            el.selectionStart = el.selectionEnd = s + token.length;
            $ta.trigger('input');
            el.focus();
        });

        const read = () => ({
            ...config,
            outputVar: $el.find('.trg-slashcmd-outvar').val().trim(),
            command:   $el.find('.trg-slashcmd-cmd').val(),
        });
        const update = () => onChange(read());
        const refreshTestDrawer = attachTestDrawer($el, read, (cfg, text) => slashCmd.preview(cfg, text));
        $el.find('.trg-slashcmd-outvar, .trg-slashcmd-cmd').on('input', () => { update(); refreshTestDrawer(); });
    },
};
