/**
 * @file triggers/keyword.js
 * @stamp {"utc":"2026-06-19T00:00:00.000Z"}
 * @architectural-role Registry — keyword trigger entry
 * @description
 * Trigger that matches text against user-configured keywords, lorebook WI keys, or a regex.
 * Text mode supports comma-separated literals, globs (* / ?), {{var}} interpolation, and
 * string transforms ({{upper:}}, {{lower:}}, {{trim:}}, etc.) identical to action templates.
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
 *     external_io:     [getWiKeywordsFiltered (read), resolveLbQueryTokens (read), getLocalVariable, getGlobalVariable]
 */

import { parseRegexFromString }                               from '../../../../../scripts/world-info.js';
import { getLocalVariable, getGlobalVariable }                from '../../../../../scripts/variables.js';
import { resolveStVar }                                       from '../actions/condition.js';
import { resolveTransforms, TRANSFORM_PREFIXES }              from '../actions/transforms.js';
import { getWiKeywordsFiltered, matchWiKw, resolveLbQueryTokens, getLbNames } from './lb-query.js';
import { getTurnVarsSnapshot }                           from './turn-vars.js';
import { esc, updateKwPreview }                          from './kw-preview.js';

// ---------------------------------------------------------------------------
// Private helpers (test-path only)
// ---------------------------------------------------------------------------

function globToRegex(pattern, caseSensitive) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
                           .replace(/\*/g, '\\w*')
                           .replace(/\?/g, '\\w');
    return new RegExp(escaped, caseSensitive ? '' : 'i');
}

const _TRANSFORM_SET = new Set(TRANSFORM_PREFIXES);

// Expands {{var}} tokens for evaluation. Transform tokens are deferred (kept as-is)
// so resolveTransforms() can process them after variable substitution. Unresolved
// plain variable tokens collapse to empty string so they produce no keyword match.
function _expandKwVars(str, snapshot) {
    return str.replace(/\{\{([^{}]+)\}\}/g, (match, k) => {
        k = k.trim();
        if (_TRANSFORM_SET.has(k.split(':')[0] + ':')) return match; // defer to resolveTransforms
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
    defaultConfig: { mode: 'text', keywords: '', caseSensitive: false, lbScope: 'active', lbBook: '', lbEntry: '', lbTag: '', lbKey: '' },
    async test(text, config) {
        const mode = config.mode ?? 'text';
        if (mode === 'lorebook') {
            const snapshot = getTurnVarsSnapshot();
            const kws = await getWiKeywordsFiltered({
                lbBook:  _expandKwVars(config.lbBook  ?? '', snapshot),
                lbEntry: _expandKwVars(config.lbEntry ?? '', snapshot),
                lbTag:   _expandKwVars(config.lbTag   ?? '', snapshot),
                lbKey:   _expandKwVars(config.lbKey   ?? '', snapshot),
                scope:   config.lbScope ?? 'active',
            });
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
                return m ? (m[1] ?? m[0]) : null;
            } catch { return null; }
        }
        // text mode (default)
        const cs       = config.caseSensitive ?? false;
        const snapshot = getTurnVarsSnapshot();
        const expanded = _expandKwVars(await resolveLbQueryTokens(config.keywords ?? '', snapshot), snapshot);
        const resolved = resolveTransforms(expanded);
        const kws      = resolved.split(',').map(k => k.trim()).filter(Boolean);
        for (const kw of kws) {
            if (kw.includes('*') || kw.includes('?')) {
                const re = globToRegex(kw, cs);
                const m  = re.exec(text);
                if (m) return m[0];
            } else {
                const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, cs ? '' : 'i');
                if (re.test(text)) return kw;
            }
        }
        return null;
    },
    renderConfig($el, config, onChange) {
        const mode  = config.mode ?? 'text';
        const lbUid = `trg-lb-${Math.random().toString(36).slice(2, 7)}`;
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
        <span class="trg-help-eg">sam*</span> → sam, samuel, samurai &nbsp;
        <span class="trg-help-eg">el?ra</span> → elara, elora<br>
        Case sensitive applies to plain text and wildcards. Use <i>regex</i> mode for full patterns.
    </div>
</div>
<div class="trg-kw-lb-ui"${mode!=='lorebook' ?' style="display:none"':''}>
    <small class="trg-hint">Matches primary keys from lorebook entries. Comma-separated values, prefix ! to exclude, * and ? are wildcards. Empty = match all.</small>
    <datalist id="${lbUid}">${getLbNames().map(n => `<option value="${esc(n)}">`).join('')}</datalist>
    <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 8px;align-items:center;margin-top:6px">
        <small>Scope</small>
        <select class="trg-kw-lb-scope" style="font-size:.85em">
            <option value="active"   ${(config.lbScope??'active')==='active'   ?'selected':''}>active</option>
            <option value="all"      ${(config.lbScope??'active')==='all'      ?'selected':''}>all</option>
            <option value="inactive" ${(config.lbScope??'active')==='inactive' ?'selected':''}>inactive</option>
        </select>
        <small>LB name</small>
        <input type="text" list="${lbUid}" class="text_pole trg-kw-lb-book"  value="${esc(config.lbBook  ?? '')}" placeholder="e.g. MyLB, !Draft" style="font-size:.85em" />
        <small>Entry name</small>
        <input type="text" class="text_pole trg-kw-lb-entry" value="${esc(config.lbEntry ?? '')}" placeholder="e.g. Elara, !Hidden" style="font-size:.85em" />
        <small>Entry group</small>
        <input type="text" class="text_pole trg-kw-lb-tag"   value="${esc(config.lbTag   ?? '')}" placeholder="e.g. Characters, !Admin" style="font-size:.85em" />
        <small>Entry key</small>
        <input type="text" class="text_pole trg-kw-lb-key"   value="${esc(config.lbKey   ?? '')}" placeholder="e.g. chat_tag, !npc" style="font-size:.85em" />
    </div>
</div>
<div class="trg-kw-re-ui"${mode!=='regex'     ?' style="display:none"':''}>
    <textarea class="text_pole trg-cfg trg-kw-pattern" rows="3" placeholder="/pattern/flags or plaintext">${esc(config.pattern ?? '')}</textarea>
</div>`);

        if (mode === 'text') updateKwPreview($el, config.keywords ?? '', config.caseSensitive ?? false);

        const read = () => ({
            ...config,
            mode:          $el.find('.trg-kw-mode').val(),
            keywords:      $el.find('.trg-kw-input').val(),
            caseSensitive: $el.find('.trg-kw-cs').prop('checked'),
            pattern:       $el.find('.trg-kw-pattern').val().trim(),
            lbScope:       $el.find('.trg-kw-lb-scope').val(),
            lbBook:        $el.find('.trg-kw-lb-book').val(),
            lbEntry:       $el.find('.trg-kw-lb-entry').val(),
            lbTag:         $el.find('.trg-kw-lb-tag').val(),
            lbKey:         $el.find('.trg-kw-lb-key').val(),
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
        $el.find('.trg-kw-lb-scope, .trg-kw-lb-book, .trg-kw-lb-entry, .trg-kw-lb-tag, .trg-kw-lb-key')
           .on('change input', function () { onChange(read()); });
        $el.find('.trg-help-toggle').on('click', function () {
            $el.find('.trg-help-text').slideToggle(150);
            $(this).toggleClass('trg-help-open');
        });
    },
};
