/**
 * @file triggers/badge.js
 * @stamp {"utc":"2026-06-16T00:00:00.000Z"}
 * @architectural-role Registry — badge trigger entry
 * @description
 * Trigger that never auto-fires; it renders clickable badge buttons onto messages and
 * fires the parent rule's actions when a badge is clicked. Three styles: top (near header),
 * bottom (after message text), inline (wraps matched keywords). The actual badge rendering
 * on message DOM is handled by badge.js (the Orchestrator-adjacent module at the extension
 * root); this entry only owns the trigger config schema and settings UI.
 *
 * @api-declaration
 * badgeTrigger — trigger registry entry object
 *
 * @contract
 *   assertions:
 *     purity:          test() always returns null; renderConfig mutates DOM only
 *     state_ownership: none
 *     external_io:     none (preview reads turn-vars via kw-preview.js)
 */

import { esc, updateKwPreview } from './kw-preview.js';

export const badgeTrigger = {
    label: 'badge',
    defaultConfig: { style: 'top', label: 'run', color: '#8888ff', splitOn: '', keywords: '', caseSensitive: false, clickAction: 'fire' },
    async test() {
        // Never auto-fires. Activated only by clicking the rendered badge.
        return null;
    },
    renderConfig($el, config, onChange) {
        const s = config.style ?? 'top';
        $el.html(`
<div style="display:flex;flex-direction:column;gap:6px">
    <div style="display:flex;gap:8px;align-items:center">
        <label style="font-size:.8em;opacity:.6;flex-shrink:0;min-width:38px">style</label>
        <select class="trg-badge-style" style="font-size:.85em;flex:1">
            <option value="top"    ${s==='top'    ?'selected':''}>top — button near message header</option>
            <option value="bottom" ${s==='bottom' ?'selected':''}>bottom — button after message text</option>
            <option value="inline" ${s==='inline' ?'selected':''}>inline — wraps matched keywords</option>
        </select>
    </div>
    <div class="trg-badge-label-row"${s==='inline'?' style="display:none"':''}>
        <div style="display:flex;gap:8px;align-items:center">
            <input type="text" class="text_pole trg-badge-label" placeholder="label or {{varName}}" value="${esc(config.label ?? 'run')}" style="flex:1" />
            <input type="color" class="trg-badge-color-top" value="${esc(config.color ?? '#8888ff')}"
                title="Badge color"
                style="width:32px;height:26px;padding:1px 2px;border-radius:4px;cursor:pointer;border:1px solid rgba(255,255,255,.2);background:none;flex-shrink:0" />
        </div>
        <div style="display:flex;gap:8px;align-items:center;margin-top:4px">
            <label style="font-size:.8em;opacity:.6;flex-shrink:0;min-width:38px">split</label>
            <input type="text" class="text_pole trg-badge-spliton" placeholder="\\n or , — leave empty for single badge" value="${esc(config.splitOn ?? '')}" style="flex:1;font-size:.85em" />
        </div>
    </div>
    <div class="trg-badge-inline-row"${s!=='inline'?' style="display:none"':''}>
        <div style="display:flex;gap:8px;align-items:flex-start">
            <div style="flex:1;min-width:0">
                <input type="text" class="text_pole trg-badge-kw" placeholder="word1, fire*, el?ra, or {{varName}}" value="${esc(config.keywords ?? '')}" />
                <div class="trg-kw-preview" style="display:none"></div>
                <div class="trg-kw-footer">
                    <label class="trg-check-row">
                        <input type="checkbox" class="trg-badge-cs" ${config.caseSensitive?'checked':''} />
                        case sensitive
                    </label>
                </div>
            </div>
            <input type="color" class="trg-badge-color-inline" value="${esc(config.color ?? '#8888ff')}"
                title="Badge color"
                style="width:32px;height:26px;padding:1px 2px;border-radius:4px;cursor:pointer;border:1px solid rgba(255,255,255,.2);background:none;flex-shrink:0;margin-top:2px" />
        </div>
    </div>
    <div style="display:flex;gap:8px;align-items:center">
        <label style="font-size:.8em;opacity:.6;flex-shrink:0;min-width:38px">click</label>
        <select class="trg-badge-clickaction" style="font-size:.85em;flex:1">
            <option value="fire"        ${(config.clickAction??'fire')==='fire'        ?'selected':''}>fire rule actions</option>
            <option value="inject"      ${(config.clickAction??'fire')==='inject'      ?'selected':''}>inject to input</option>
            <option value="inject-send" ${(config.clickAction??'fire')==='inject-send' ?'selected':''}>inject and send</option>
        </select>
    </div>
    <small class="trg-badge-hint trg-hint"></small>
</div>`);

        const setHint = style => {
            const msg = style === 'inline'
                ? 'Wraps each keyword match as a clickable badge. Matched text passes to actions as {{keyword}}.'
                : style === 'bottom'
                    ? 'Adds badges after message text. {{varName}} in label; splitOn splits into multiple badges. Use with postMessage actions.'
                    : 'Adds badges near message header. {{varName}} in label; splitOn splits into multiple badges. Use with postMessage actions.';
            $el.find('.trg-badge-hint').text(msg);
        };
        setHint(s);

        const syncVisibility = style => {
            if (style === 'inline') {
                $el.find('.trg-badge-label-row').hide();
                $el.find('.trg-badge-inline-row').show();
            } else {
                $el.find('.trg-badge-label-row').show();
                $el.find('.trg-badge-inline-row').hide();
            }
            setHint(style);
        };

        const read = () => {
            const style = $el.find('.trg-badge-style').val();
            return {
                style,
                label:         $el.find('.trg-badge-label').val(),
                splitOn:       $el.find('.trg-badge-spliton').val(),
                color:         style === 'inline'
                                   ? $el.find('.trg-badge-color-inline').val()
                                   : $el.find('.trg-badge-color-top').val(),
                keywords:      $el.find('.trg-badge-kw').val(),
                caseSensitive: $el.find('.trg-badge-cs').prop('checked'),
                clickAction:   $el.find('.trg-badge-clickaction').val(),
            };
        };

        $el.find('.trg-badge-style').on('change', function () { syncVisibility(this.value); onChange(read()); });
        $el.find('.trg-badge-label, .trg-badge-spliton').on('input', () => onChange(read()));
        $el.find('.trg-badge-color-top, .trg-badge-color-inline').on('input', () => onChange(read()));
        $el.find('.trg-badge-clickaction').on('change', () => onChange(read()));
        $el.find('.trg-badge-kw').on('input', function () {
            const cur = read();
            updateKwPreview($el, cur.keywords, cur.caseSensitive);
            onChange(cur);
        });
        $el.find('.trg-badge-cs').on('change', function () {
            const cur = read();
            updateKwPreview($el, cur.keywords, cur.caseSensitive);
            onChange(cur);
        });
        if (s === 'inline') updateKwPreview($el, config.keywords ?? '', config.caseSensitive ?? false);
    },
};
