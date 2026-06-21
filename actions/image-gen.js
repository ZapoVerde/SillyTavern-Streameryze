/**
 * @file st-extensions/SillyTavern-Triggeryze/actions/image-gen.js
 * @stamp {"utc":"2026-06-15T00:00:00.000Z"}
 * @architectural-role Registry — imageGen action (fire-and-forget image generation)
 * @description
 * Generates an image from an interpolated prompt and attaches it to the message.
 * Dispatches fire-and-forget so generation never blocks onMessageReceived.
 * A swipe guard (isCurrentGeneration) cancels stale results if the user swipes
 * before the image arrives.
 *
 * @api-declaration
 * imageGen — action definition object for the ACTION_REGISTRY
 *
 * @contract
 *   assertions:
 *     purity:          none — calls generateAndUpload, writes msg.extra, calls saveChat
 *     state_ownership: none
 *     external_io:     generateAndUpload (imageGen.js), appendMediaToMessage, eventSource, stCtx.saveChat
 */

import { eventSource, event_types, name1, name2, appendMediaToMessage, callPopup } from '../../../../../script.js';
import { SOURCE_LABELS, loadModelsForSource, generatePreviewBlob, generateAndUpload } from '../imageGen.js';
import { interpolate, resolveLbTokens, resolveHistoryTokens } from './template.js';
import { esc } from './text.js';
import { renderVarLegend } from './var-legend.js';
import { trgError, trgPerf } from '../logger.js';

export const imageGen = {
    label: 'generate image',
    stage: 'postMessage',
    templateFields: cfg => [cfg.prompt],
    defaultConfig: { source: 'pollinations', model: '', comfyUiUrl: '', prompt: '{{keyword}}', outputVar: '', persist: true },

    async execute(config, { matchedKeyword, messageId, stCtx, isCurrentGeneration, vars, highlighted = '' }) {
        const msg = stCtx?.chat?.[messageId];
        if (!msg) return;
        if (!msg.extra || typeof msg.extra !== 'object') msg.extra = {};

        const kwEsc          = (matchedKeyword ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const firstMatch     = kwEsc ? new RegExp(kwEsc, 'i').exec(msg.mes ?? '') : null;
        const upTo           = firstMatch ? (msg.mes ?? '').slice(0, firstMatch.index) : '';
        const resolvedPrompt = resolveHistoryTokens(
            await resolveLbTokens(config.prompt ?? '', matchedKeyword, highlighted, vars, messageId),
            stCtx?.chat, messageId, vars ?? {},
        );

        const prompt = interpolate(resolvedPrompt, {
            keyword:  matchedKeyword ?? '',
            message:  msg.mes ?? '',
            'up-to':  upTo,
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
                imagePath = await generateAndUpload(prompt, config, stCtx?.name2 ?? name2 ?? 'triggeryze');
                trgPerf(`imageGen | source=${config.source ?? 'pollinations'} | ${Math.round(performance.now() - tImg)}ms`);
            } catch (err) {
                trgError('imageGen: generation failed', err);
                window.toastr?.error(`Image generation failed: ${err.message.slice(0, 80)}`, 'Triggeryze');
                return;
            }

            if (!imagePath || (isCurrentGeneration && !isCurrentGeneration())) return;

            if (config.outputVar && vars) vars[config.outputVar] = imagePath;

            const persist = config.persist ?? true;
            if (!Array.isArray(msg.extra.media)) msg.extra.media = [];
            msg.extra.media.push({ url: imagePath, type: 'image', source: 'generated', title: matchedKeyword ?? '' });
            msg.extra.media_display ??= 'gallery';
            msg.extra.media_index = msg.extra.media.length - 1;
            msg.extra.inline_image = true;

            try {
                const $mesEl = $(`.mes[mesid="${messageId}"]`);
                if ($mesEl.length) appendMediaToMessage(msg, $mesEl, 'keep');
                if (persist && typeof stCtx.saveChat === 'function') await stCtx.saveChat();
                if (persist) eventSource.emit(event_types.MESSAGE_UPDATED, messageId);
            } catch (err) {
                trgError('imageGen: render/save failed', err);
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
<div class="trg-ig-wrap">
    <div class="trg-sc-row">
        <label class="trg-sc-lbl">source</label>
        <select class="trg-ig-source text_pole" style="flex:1">${srcOpts}</select>
    </div>
    <div class="trg-sc-row trg-ig-model-row"${isComfy ? ' style="display:none"' : ''}>
        <label class="trg-sc-lbl">model</label>
        <div class="trg-ig-model-ctrl" style="flex:1;min-width:0">
            <input type="text" class="text_pole" placeholder="loading…" disabled style="width:100%" />
        </div>
    </div>
    <div class="trg-sc-row trg-ig-comfy-row"${!isComfy ? ' style="display:none"' : ''}>
        <label class="trg-sc-lbl">ComfyUI URL</label>
        <input type="text" class="trg-ig-comfy text_pole" style="flex:1"
            value="${esc(config.comfyUiUrl || '')}" placeholder="http://127.0.0.1:8188" />
    </div>
    <div class="trg-sc-row">
        <label class="trg-sc-lbl">save as</label>
        <input type="text" class="trg-ig-outvar text_pole trg-outvar-field" placeholder="variable name (optional)" value="${esc(config.outputVar ?? '')}" style="flex:1" />
    </div>
    ${renderVarLegend(ctx?.priorActions, ctx?.crossRuleVars, ctx?.globalVars)}
    <textarea class="trg-ig-prompt text_pole" rows="2"
        placeholder="Image prompt — {{keyword}} {{up-to}} {{message}} {{history:[2]}} {{char}} {{user}}">${esc(config.prompt || '')}</textarea>
    <div class="trg-sc-row">
        <label class="trg-check-row">
            <input type="checkbox" class="trg-ig-persist" ${(config.persist ?? true) ? 'checked' : ''} />
            persist in chat
        </label>
        <small class="trg-sc-hint-inline" style="margin-left:8px">uncheck for ephemeral (shown this session only)</small>
    </div>
    <div class="trg-ig-footer">
        <button class="trg-ig-test menu_button">Test</button>
        <span class="trg-ig-test-status"></span>
    </div>
</div>`);

        const readConfig = () => ({
            source:     $el.find('.trg-ig-source').val() || 'pollinations',
            model:      ($el.find('.trg-ig-model-ctrl select, .trg-ig-model-ctrl input').first().val() ?? '').trim(),
            comfyUiUrl: $el.find('.trg-ig-comfy').val()?.trim() || '',
            outputVar:  $el.find('.trg-ig-outvar').val()?.trim() || '',
            prompt:     $el.find('.trg-ig-prompt').val() || '',
            persist:    $el.find('.trg-ig-persist').prop('checked'),
        });

        const refreshModelControl = async (source, currentModel) => {
            const $modelRow = $el.find('.trg-ig-model-row');
            const $comfyRow = $el.find('.trg-ig-comfy-row');
            const $ctrl     = $el.find('.trg-ig-model-ctrl');

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

        $el.find('.trg-ig-source').on('change', function () {
            const cfg = readConfig();
            onChange(cfg);
            refreshModelControl($(this).val(), cfg.model);
        });

        $el.find('.trg-ig-comfy').on('input', () => onChange(readConfig()));
        $el.find('.trg-ig-outvar').on('input', () => onChange(readConfig()));
        $el.find('.trg-ig-prompt').on('input', () => onChange(readConfig()));
        $el.find('.trg-ig-persist').on('change', () => onChange(readConfig()));
        $el.on('click', '.trg-var-inject', function () {
            const token = $(this).data('token');
            const $ta   = $el.find('.trg-ig-prompt');
            const el    = $ta[0];
            if (!el) return;
            const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? s;
            el.value = el.value.slice(0, s) + token + el.value.slice(e);
            el.selectionStart = el.selectionEnd = s + token.length;
            $ta.trigger('input');
            el.focus();
        });

        $el.find('.trg-ig-test').on('click', async function () {
            const $btn    = $(this);
            const $status = $el.find('.trg-ig-test-status');
            const cfg     = readConfig();
            const prompt  = cfg.prompt.trim() || 'a scene image';

            $btn.prop('disabled', true).text('Generating…');
            $status.text('');

            try {
                const blobUrl = await generatePreviewBlob(prompt, cfg);
                $status.html('<span style="color:var(--SmartThemeQuoteColor,#28a745)">✓ OK</span>');
                await callPopup(
                    `<h3 style="margin-top:0">Triggeryze — Image Test</h3>
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
};
