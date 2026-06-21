/**
 * @file st-extensions/SillyTavern-Triggeryze/actions/load-image.js
 * @stamp {"utc":"2026-06-19T00:00:00.000Z"}
 * @architectural-role Registry — loadImage action (display a pre-existing image in the message gallery)
 * @description
 * Resolves a path template and attaches the image to the message using ST's media gallery —
 * the same rendering path as imageGen, but with no generation step.
 * Stage 'both' lets the image appear immediately when the trigger keyword is seen during
 * streaming, without waiting for the message to commit. An idempotency check on msg.extra.media
 * prevents a duplicate entry when the action fires a second time at postMessage stage.
 *
 * @api-declaration
 * loadImage — action definition object for the ACTION_REGISTRY
 *
 * @contract
 *   assertions:
 *     purity:          none — writes msg.extra, calls appendMediaToMessage, calls saveChat
 *     state_ownership: none
 *     external_io:     appendMediaToMessage, eventSource, stCtx.saveChat
 */

import { eventSource, event_types, name1, name2, appendMediaToMessage } from '../../../../../script.js';
import { interpolate, resolveLbTokens, resolveHistoryTokens }            from './template.js';
import { esc }                                                            from './text.js';
import { renderVarLegend }                                                from './var-legend.js';
import { trgError }                                                       from '../logger.js';

export const loadImage = {
    label: 'load image',
    stage: 'both',
    templateFields: cfg => [cfg.path],
    defaultConfig: { path: '', outputVar: '', persist: true },

    async execute(config, { matchedKeyword, messageId, stCtx, vars, highlighted = '' }) {
        const msg = stCtx?.chat?.[messageId];
        if (!msg) return;
        if (!msg.extra || typeof msg.extra !== 'object') msg.extra = {};

        const kwEsc      = (matchedKeyword ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const firstMatch = kwEsc ? new RegExp(kwEsc, 'i').exec(msg.mes ?? '') : null;
        const upTo       = firstMatch ? (msg.mes ?? '').slice(0, firstMatch.index) : '';
        const resolved   = resolveHistoryTokens(
            await resolveLbTokens(config.path ?? '', matchedKeyword, highlighted, vars, messageId),
            stCtx?.chat, messageId, vars ?? {},
        );
        const path = interpolate(resolved, {
            keyword:  matchedKeyword ?? '',
            message:  msg.mes ?? '',
            'up-to':  upTo,
            char:     name2 ?? '',
            user:     name1 ?? '',
        }, vars ?? {});
        if (!path.trim()) return;

        if (config.outputVar && vars) vars[config.outputVar] = path;

        // With stage:'both', stream and postMessage both fire execute. Skip if the path
        // is already in the gallery so the image is not added twice.
        if (Array.isArray(msg.extra.media) && msg.extra.media.some(m => m.url === path)) return;

        if (!Array.isArray(msg.extra.media)) msg.extra.media = [];
        msg.extra.media.push({ url: path, type: 'image', source: 'loaded', title: matchedKeyword ?? '' });
        msg.extra.media_display ??= 'gallery';
        msg.extra.media_index = msg.extra.media.length - 1;
        msg.extra.inline_image = true;

        const persist = config.persist ?? true;
        try {
            const $mesEl = $(`.mes[mesid="${messageId}"]`);
            if ($mesEl.length) appendMediaToMessage(msg, $mesEl, 'keep');
            if (persist && typeof stCtx.saveChat === 'function') await stCtx.saveChat();
            if (persist) eventSource.emit(event_types.MESSAGE_UPDATED, messageId);
        } catch (err) {
            trgError('loadImage: render/save failed', err);
        }
    },

    renderConfig($el, config, onChange, ctx) {
        $el.html(`
<div class="trg-sc-wrap">
    <div class="trg-sc-row">
        <label class="trg-sc-lbl">path</label>
        <input type="text" class="trg-li-path text_pole" style="flex:1"
            value="${esc(config.path ?? '')}"
            placeholder="image path or {{varName}}" />
    </div>
    <div class="trg-sc-row">
        <label class="trg-sc-lbl">save as</label>
        <input type="text" class="trg-li-outvar text_pole trg-outvar-field" placeholder="variable name (optional)" value="${esc(config.outputVar ?? '')}" style="flex:1" />
    </div>
    ${renderVarLegend(ctx?.priorActions, ctx?.crossRuleVars, ctx?.globalVars)}
    <div class="trg-sc-row">
        <label class="trg-check-row">
            <input type="checkbox" class="trg-li-persist" ${(config.persist ?? true) ? 'checked' : ''} />
            persist in chat
        </label>
        <small class="trg-sc-hint-inline" style="margin-left:8px">uncheck for ephemeral (shown this session only)</small>
    </div>
</div>`);

        const readConfig = () => ({
            path:      $el.find('.trg-li-path').val()?.trim() || '',
            outputVar: $el.find('.trg-li-outvar').val()?.trim() || '',
            persist:   $el.find('.trg-li-persist').prop('checked'),
        });

        $el.find('.trg-li-path, .trg-li-outvar').on('input', () => onChange(readConfig()));
        $el.find('.trg-li-persist').on('change', () => onChange(readConfig()));
        $el.on('click', '.trg-var-inject', function () {
            const token = $(this).data('token');
            const $inp  = $el.find('.trg-li-path');
            const el    = $inp[0];
            if (!el) return;
            const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? s;
            el.value = el.value.slice(0, s) + token + el.value.slice(e);
            el.selectionStart = el.selectionEnd = s + token.length;
            $inp.trigger('input');
            el.focus();
        });
    },
};
