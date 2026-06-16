/**
 * @file triggers/keyword.js
 * @stamp {"utc":"2026-06-16T00:00:00.000Z"}
 * @architectural-role Registry — keyword trigger entry
 * @description
 * Trigger that matches text against user-configured keywords, lorebook WI keys, or a regex.
 * Text mode supports comma-separated literals, globs (* / ?), and {{var}} interpolation.
 * Rendering helpers (esc, describeKw, updateKwPreview) live in kw-preview.js and are
 * shared with the badge trigger entry.
 *
 * @api-declaration
 * keywordTrigger — trigger registry entry object
 *
 * @contract
 *   assertions:
 *     purity:          test() is read-only; renderConfig mutates DOM only
 *     state_ownership: none
 *     external_io:     [getWiKeywords (read), resolveLbQueryTokens (read), getLocalVariable, getGlobalVariable]
 */

import { parseRegexFromString }                          from '../../../../../scripts/world-info.js';
import { getLocalVariable, getGlobalVariable }           from '../../../../../scripts/variables.js';
import { resolveStVar }                                  from '../actions/condition.js';
import { getWiKeywords, matchWiKw, resolveLbQueryTokens } from './lb-query.js';
import { getTurnVarsSnapshot }                           from './turn-vars.js';
import { esc, updateKwPreview }                          from './kw-preview.js';

// ---------------------------------------------------------------------------
// Private helpers (test-path only)
// ---------------------------------------------------------------------------

function globToRegex(pattern, caseSensitive) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
                           .replace(/\*/g, '.*')
                           .replace(/\?/g, '.');
    return new RegExp(escaped, caseSensitive ? '' : 'i');
}

// Expands {{var}} tokens for evaluation — unresolved tokens collapse to empty string
// so they produce no keyword match.
function _expandKwVars(str, snapshot) {
    return str.replace(/\{\{([^{}]+)\}\}/g, (_, k) => {
        k = k.trim();
        if (k.startsWith('chatvar::'))   return resolveStVar(k.slice(9),  getLocalVariable);
        if (k.startsWith('globalvar::')) return resolveStVar(k.slice(12), getGlobalVariable);
        const v = snapshot[k];
        return v !== undefined ? String(v) : '';
    });
}

// ---------------------------------------------------------------------------
// Registry entry
// ---------------------------------------------------------------------------

export const keywordTrigger = {
    label: 'keyword',
    defaultConfig: { mode: 'text', keywords: '', caseSensitive: false },
    async test(text, config) {
        const mode = config.mode ?? 'text';
        if (mode === 'lorebook') {
            const kws = await getWiKeywords();
            for (const kw of kws) {
                if (matchWiKw(text, kw)) return kw.raw;
            }
            return null;
        }
        if (mode === 'regex') {
            if (!config.pattern) return null;
            try {
                const re = parseRegexFromString(config.pattern) ?? new RegExp(config.pattern);
                const m  = re.exec(text);
                return m ? m[0] : null;
            } catch { return null; }
        }
        // text mode (default)
        const cs       = config.caseSensitive ?? false;
        const snapshot = getTurnVarsSnapshot();
        const resolved = _expandKwVars(await resolveLbQueryTokens(config.keywords ?? '', snapshot), snapshot);
        const kws      = resolved.split(',').map(k => k.trim()).filter(Boolean);
        for (const kw of kws) {
            if (kw.includes('*') || kw.includes('?')) {
                const re = globToRegex(kw, cs);
                const m  = re.exec(text);
                if (m) return m[0];
            } else if (cs) {
                if (text.includes(kw)) return kw;
            } else {
                if (text.toLowerCase().includes(kw.toLowerCase())) return kw;
            }
        }
        return null;
    },
    renderConfig($el, config, onChange) {
        const mode = config.mode ?? 'text';
        $el.html(`
<div style="margin-bottom:6px">
    <select class="trg-kw-mode" style="font-size:.85em">
        <option value="text"     ${mode==='text'     ?'selected':''}>text</option>
        <option value="lorebook" ${mode==='lorebook' ?'selected':''}>lorebook</option>
        <option value="regex"    ${mode==='regex'    ?'selected':''}>regex</option>
    </select>
</div>
<div class="trg-kw-text-ui"${mode!=='text'     ?' style="display:none"':''}>
    <input type="text" class="text_pole trg-cfg trg-kw-input" placeholder="word1, sam*, el?ra, ..." value="${esc(config.keywords ?? '')}" />
    <small class="trg-hint">Comma-separated — multiple keywords trigger on any match</small>
    <div class="trg-kw-preview" style="display:none;"></div>
    <div class="trg-kw-footer">
        <label class="trg-check-row">
            <input type="checkbox" class="trg-kw-cs" ${config.caseSensitive ? 'checked' : ''} />
            case sensitive
        </label>
        <span class="trg-help-toggle" title="How this works">?</span>
    </div>
    <div class="trg-help-text" style="display:none;">
        Separate keywords with commas. Matches anywhere in the text.<br>
        <b>*</b> — any characters &nbsp;&nbsp; <b>?</b> — exactly one character<br>
        <span class="trg-help-eg">sam*</span> → samuel, samurai &nbsp;
        <span class="trg-help-eg">el?ra</span> → elara, elora<br>
        Case sensitive applies to plain text and wildcards. Use <i>regex</i> mode for full patterns.
    </div>
</div>
<div class="trg-kw-lb-ui"${mode!=='lorebook' ?' style="display:none"':''}>
    <small class="trg-hint">Fires on any primary key from the active lorebooks (globally selected, character-attached, chat-pinned, and persona). Lorebooks not in one of these four slots are not visible here.</small>
</div>
<div class="trg-kw-re-ui"${mode!=='regex'     ?' style="display:none"':''}>
    <input type="text" class="text_pole trg-cfg trg-kw-pattern" placeholder="/pattern/flags or plaintext" value="${esc(config.pattern ?? '')}" />
</div>`);

        if (mode === 'text') updateKwPreview($el, config.keywords ?? '', config.caseSensitive ?? false);

        const read = () => ({
            ...config,
            mode:          $el.find('.trg-kw-mode').val(),
            keywords:      $el.find('.trg-kw-input').val(),
            caseSensitive: $el.find('.trg-kw-cs').prop('checked'),
            pattern:       $el.find('.trg-kw-pattern').val(),
        });

        $el.find('.trg-kw-mode').on('change', function () {
            const newMode = this.value;
            $el.find('.trg-kw-text-ui').toggle(newMode === 'text');
            $el.find('.trg-kw-lb-ui').toggle(newMode === 'lorebook');
            $el.find('.trg-kw-re-ui').toggle(newMode === 'regex');
            if (newMode === 'text') updateKwPreview($el, $el.find('.trg-kw-input').val(), $el.find('.trg-kw-cs').prop('checked'));
            onChange(read());
        });
        $el.find('.trg-kw-input').on('input', function () {
            const cur = read();
            updateKwPreview($el, cur.keywords, cur.caseSensitive);
            onChange(cur);
        });
        $el.find('.trg-kw-cs').on('change', function () {
            const cur = read();
            updateKwPreview($el, cur.keywords, cur.caseSensitive);
            onChange(cur);
        });
        $el.find('.trg-kw-pattern').on('input', function () { onChange(read()); });
        $el.find('.trg-help-toggle').on('click', function () {
            $el.find('.trg-help-text').slideToggle(150);
            $(this).toggleClass('trg-help-open');
        });
    },
};
