/**
 * @file triggers/badge.js
 * @stamp {"utc":"2026-06-21T00:00:00.000Z"}
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

import { esc, updateKwPreview }                              from './kw-preview.js';
import { parseRegexPattern, findAllMatches, fuzzyMatchText } from './kw-match.js';
import { testDrawerHtml, attachTestDrawer }  from './test-drawer.js';

// Resolve function for the inline test drawer — no lorebook expansion, keywords are literal.
function _resolveTestSpans(cfg, text) {
    const matchMode = cfg.matchMode ?? (cfg.useRegex ? 'regex' : 'keyword');
    if (matchMode === 'regex') {
        if (!(cfg.pattern ?? '').trim()) return { hint: 'Enter a pattern above' };
        if (!parseRegexPattern(cfg.pattern))  return { error: 'Invalid pattern' };
        return findAllMatches(text, { useRegex: true, pattern: cfg.pattern });
    }
    if (!(cfg.keywords ?? '').trim()) return { hint: 'Enter keywords above' };
    const kws = cfg.keywords.split(',').map(k => k.trim()).filter(Boolean);
    if (matchMode === 'fuzzy') {
        const rawNum = parseFloat(cfg.fuzzyThreshold ?? '80');
        const thresh = Number.isFinite(rawNum) ? rawNum / 100 : 0.80;
        return findAllMatches(text, { useFuzzy: true, fuzzyKeywords: kws, fuzzyThreshold: thresh });
    }
    return findAllMatches(text, { resolvedKeywords: kws, caseSensitive: cfg.caseSensitive ?? false });
}

const _DESC = {
    top:    'A button placed near the message header. No keyword matching — this badge appears on every message. Use {{varName}} in the label; splitOn turns one label into multiple badges.',
    bottom: 'A button placed after the message text. No keyword matching — this badge appears on every message. Use {{varName}} in the label; splitOn turns one label into multiple badges. Works with postMessage actions.',
};

const _INLINE_DESC = 'Scans each message for keyword or pattern matches and wraps each match in-place as a clickable badge. '
    + 'Unlike top and bottom, this style only renders where a match exists — there is no badge on messages with no match. '
    + 'The matched word passes to actions as <code>{{keyword}}</code>.';

export const badgeTrigger = {
    label: 'badge',
    defaultConfig: { style: 'top', graph: false, compact: true, label: 'run', color: '#8888ff', splitOn: '', keywords: '', caseSensitive: false, matchMode: 'keyword', fuzzyThreshold: '80', pattern: '', badgeLabel: '', clickAction: 'fire' },
    async test() {
        // Never auto-fires. Activated only by clicking the rendered badge.
        return null;
    },
    renderConfig($el, config, onChange) {
        const s         = config.style ?? 'top';
        const matchMode = config.matchMode ?? (config.useRegex ? 'regex' : 'keyword');
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
        <small class="trg-badge-mode-desc trg-hint" style="display:block;margin-bottom:8px">${esc(_DESC[s] ?? _DESC.top)}</small>
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
        <div style="display:flex;gap:8px;align-items:center;margin-top:4px">
            <label style="font-size:.8em;opacity:.6;flex-shrink:0;min-width:38px"></label>
            <label class="trg-check-row" style="font-size:.8em">
                <input type="checkbox" class="trg-badge-graph" ${config.graph ? 'checked' : ''} />
                graph mode — monospace font, use <code>{{pad:N:{{.1}}}}</code> to align columns
            </label>
        </div>
        <div style="display:flex;gap:8px;align-items:center;margin-top:4px">
            <label style="font-size:.8em;opacity:.6;flex-shrink:0;min-width:38px"></label>
            <label class="trg-check-row" style="font-size:.8em">
                <input type="checkbox" class="trg-badge-compact" ${config.compact ? 'checked' : ''} />
                compact
            </label>
        </div>
    </div>
    <div class="trg-badge-inline-row"${s!=='inline'?' style="display:none"':''}>
        <small class="trg-hint" style="display:block;margin-bottom:8px">${_INLINE_DESC}</small>
        <div style="display:flex;gap:8px;align-items:flex-start">
            <div style="flex:1;min-width:0">
                <div style="display:flex;gap:12px;align-items:center;margin-bottom:4px;flex-wrap:wrap">
                    <label class="trg-check-row">
                        <input type="checkbox" class="trg-badge-regex" ${matchMode==='regex'?'checked':''} />
                        regex
                    </label>
                    <label class="trg-check-row">
                        <input type="checkbox" class="trg-badge-fuzzy" ${matchMode==='fuzzy'?'checked':''} />
                        fuzzy
                    </label>
                    <input type="number" class="trg-badge-fuzz-thresh" min="0" max="100"
                        value="${esc(config.fuzzyThreshold ?? '80')}" title="Jaro-Winkler threshold 0–100"
                        style="width:48px;${matchMode!=='fuzzy'?'visibility:hidden;':''}" />
                </div>
                <div class="trg-badge-kw-ui"${matchMode==='regex'?' style="display:none"':''}>
                    <input type="text" class="text_pole trg-badge-kw" placeholder="word1, fire*, el?ra, or {{varName}}" value="${esc(config.keywords ?? '')}" />
                    <div class="trg-kw-preview" style="display:none"></div>
                    <div class="trg-kw-footer">
                        <label class="trg-check-row trg-badge-cs-row"${matchMode==='fuzzy'?' style="visibility:hidden"':''}>
                            <input type="checkbox" class="trg-badge-cs" ${config.caseSensitive?'checked':''} />
                            case sensitive
                        </label>
                    </div>
                </div>
                <div class="trg-badge-pattern-ui"${matchMode!=='regex'?' style="display:none"':''}>
                    <textarea class="text_pole trg-badge-pattern" rows="2" placeholder="/pattern/flags or plain text (case-insensitive)">${esc(config.pattern ?? '')}</textarea>
                </div>
                <div style="display:flex;gap:8px;align-items:center;margin-top:4px">
                    <label style="font-size:.8em;opacity:.6;flex-shrink:0;min-width:38px">label</label>
                    <input type="text" class="text_pole trg-badge-inline-label" placeholder="optional — leave empty to wrap keyword" value="${esc(config.badgeLabel ?? '')}" style="flex:1;font-size:.85em" />
                </div>
            </div>
            <input type="color" class="trg-badge-color-inline" value="${esc(config.color ?? '#8888ff')}"
                title="Badge color"
                style="width:32px;height:26px;padding:1px 2px;border-radius:4px;cursor:pointer;border:1px solid rgba(255,255,255,.2);background:none;flex-shrink:0;margin-top:2px" />
        </div>
        ${testDrawerHtml()}
    </div>
    <div style="display:flex;gap:8px;align-items:center">
        <label style="font-size:.8em;opacity:.6;flex-shrink:0;min-width:38px">click</label>
        <select class="trg-badge-clickaction" style="font-size:.85em;flex:1">
            <option value="fire"        ${(config.clickAction??'fire')==='fire'        ?'selected':''}>fire rule actions</option>
            <option value="inject"      ${(config.clickAction??'fire')==='inject'      ?'selected':''}>inject to input</option>
            <option value="inject-send" ${(config.clickAction??'fire')==='inject-send' ?'selected':''}>inject and send</option>
        </select>
    </div>
</div>`);

        const syncVisibility = style => {
            if (style === 'inline') {
                $el.find('.trg-badge-label-row').hide();
                $el.find('.trg-badge-inline-row').show();
            } else {
                $el.find('.trg-badge-label-row').show();
                $el.find('.trg-badge-inline-row').hide();
                $el.find('.trg-badge-mode-desc').text(_DESC[style] ?? _DESC.top);
            }
        };

        const read = () => {
            const style   = $el.find('.trg-badge-style').val();
            const regexOn = $el.find('.trg-badge-regex').prop('checked');
            const fuzzyOn = $el.find('.trg-badge-fuzzy').prop('checked');
            return {
                style,
                graph:          $el.find('.trg-badge-graph').prop('checked'),
                compact:        $el.find('.trg-badge-compact').prop('checked'),
                label:          $el.find('.trg-badge-label').val(),
                splitOn:        $el.find('.trg-badge-spliton').val(),
                color:          style === 'inline'
                                    ? $el.find('.trg-badge-color-inline').val()
                                    : $el.find('.trg-badge-color-top').val(),
                keywords:       $el.find('.trg-badge-kw').val(),
                caseSensitive:  $el.find('.trg-badge-cs').prop('checked'),
                matchMode:      fuzzyOn ? 'fuzzy' : regexOn ? 'regex' : 'keyword',
                fuzzyThreshold: $el.find('.trg-badge-fuzz-thresh').val(),
                pattern:        $el.find('.trg-badge-pattern').val().trim(),
                badgeLabel:     $el.find('.trg-badge-inline-label').val(),
                clickAction:    $el.find('.trg-badge-clickaction').val(),
            };
        };

        const refreshTestDrawer = attachTestDrawer($el, read, _resolveTestSpans);

        $el.find('.trg-badge-style').on('change', function () { syncVisibility(this.value); onChange(read()); });
        $el.find('.trg-badge-label, .trg-badge-spliton').on('input', () => onChange(read()));
        $el.find('.trg-badge-graph, .trg-badge-compact').on('change', () => onChange(read()));
        $el.find('.trg-badge-color-top, .trg-badge-color-inline').on('input', () => onChange(read()));
        $el.find('.trg-badge-clickaction').on('change', () => onChange(read()));
        $el.find('.trg-badge-inline-label').on('input', () => onChange(read()));
        $el.find('.trg-badge-regex').on('change', function () {
            if (this.checked) $el.find('.trg-badge-fuzzy').prop('checked', false);
            const mm = this.checked ? 'regex' : 'keyword';
            $el.find('.trg-badge-kw-ui').toggle(mm !== 'regex');
            $el.find('.trg-badge-pattern-ui').toggle(mm === 'regex');
            $el.find('.trg-badge-fuzz-thresh').css('visibility', 'hidden');
            $el.find('.trg-badge-cs-row').css('visibility', 'visible');
            onChange(read());
            refreshTestDrawer();
        });
        $el.find('.trg-badge-fuzzy').on('change', function () {
            if (this.checked) $el.find('.trg-badge-regex').prop('checked', false);
            $el.find('.trg-badge-kw-ui').show();
            $el.find('.trg-badge-pattern-ui').hide();
            $el.find('.trg-badge-fuzz-thresh').css('visibility', this.checked ? 'visible' : 'hidden');
            $el.find('.trg-badge-cs-row').css('visibility', this.checked ? 'hidden' : 'visible');
            onChange(read());
            refreshTestDrawer();
        });
        $el.find('.trg-badge-fuzz-thresh').on('input', () => { onChange(read()); refreshTestDrawer(); });
        $el.find('.trg-badge-kw').on('input', function () {
            const cur = read();
            if (cur.matchMode === 'keyword') updateKwPreview($el, cur.keywords, cur.caseSensitive);
            onChange(cur);
            refreshTestDrawer();
        });
        $el.find('.trg-badge-cs').on('change', function () {
            const cur = read();
            updateKwPreview($el, cur.keywords, cur.caseSensitive);
            onChange(cur);
            refreshTestDrawer();
        });
        $el.find('.trg-badge-pattern').on('input', () => { onChange(read()); refreshTestDrawer(); });
        if (s === 'inline' && matchMode === 'keyword') updateKwPreview($el, config.keywords ?? '', config.caseSensitive ?? false);
    },
};
