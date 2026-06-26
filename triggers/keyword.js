/**
 * @file triggers/keyword.js
 * @stamp {"utc":"2026-06-26T00:00:00.000Z"}
 * @architectural-role Registry — keyword trigger entry
 * @description
 * Trigger that matches text against user-configured keywords, lorebook WI keys, a regex, or
 * a fuzzy (Jaro-Winkler) pattern. Text mode supports comma-separated literals, globs (* / ?),
 * {{var}} interpolation, and string transforms identical to action templates. matchMode selects
 * between 'keyword' (default), 'regex', and 'fuzzy'; the legacy useRegex:true field migrates
 * transparently to matchMode:'regex'. Rendering helpers live in kw-preview.js and are shared
 * with the badge trigger entry.
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

import { getLocalVariable, getGlobalVariable }                from '../../../../../scripts/variables.js';
import { resolveStVar }                                       from '../actions/condition.js';
import { resolveTransforms, TRANSFORM_PREFIXES }              from '../actions/transforms.js';
import { getWiKeywordsFiltered, matchWiKw, resolveLbQueryTokens, getLbNames } from './lb-query.js';
import { getTurnVarsSnapshot }                                from './turn-vars.js';
import { esc, updateKwPreview }                               from './kw-preview.js';
import { matchKeyword, testRegex, parseRegexPattern, findAllMatches, fuzzyMatchText } from './kw-match.js';
import { testDrawerHtml, attachTestDrawer }                   from './test-drawer.js';

// ---------------------------------------------------------------------------
// Private helpers (test-path only)
// ---------------------------------------------------------------------------

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
// Test-drawer resolve function (UI only — no engine logic)
// ---------------------------------------------------------------------------

async function _resolveTestSpans(cfg, text) {
    const matchMode = cfg.matchMode ?? (cfg.useRegex ? 'regex' : 'keyword');
    if (matchMode === 'regex') {
        if (!(cfg.pattern ?? '').trim()) return { hint: 'Enter a pattern above' };
        if (!parseRegexPattern(cfg.pattern))  return { error: 'Invalid pattern' };
        return findAllMatches(text, { useRegex: true, pattern: cfg.pattern });
    }
    if (!(cfg.keywords ?? '').trim()) return { hint: 'Enter keywords above' };
    const snapshot  = getTurnVarsSnapshot();
    const afterLb   = await resolveLbQueryTokens(cfg.keywords, snapshot);
    const afterVars = resolveTransforms(_expandKwVars(afterLb, snapshot));
    const kws = afterVars.split(',').map(k => k.trim()).filter(Boolean);
    if (matchMode === 'fuzzy') {
        const rawNum  = parseFloat(cfg.fuzzyThreshold ?? '80');
        const thresh  = Number.isFinite(rawNum) ? rawNum / 100 : 0.80;
        return findAllMatches(text, { useFuzzy: true, fuzzyKeywords: kws, fuzzyThreshold: thresh });
    }
    return findAllMatches(text, { resolvedKeywords: kws, caseSensitive: cfg.caseSensitive ?? false });
}

// ---------------------------------------------------------------------------
// Registry entry
// ---------------------------------------------------------------------------

export const keywordTrigger = {
    label: 'keyword',
    defaultConfig: { mode: 'text', keywords: '', caseSensitive: false, matchMode: 'keyword', fuzzyThreshold: '80', pattern: '', lbScope: 'active', lbBook: '', lbEntry: '', lbTag: '', lbKey: '' },
    async test(text, config, rulesetId) {
        const mode = config.mode ?? 'text';
        if (mode === 'lorebook') {
            const snapshot = getTurnVarsSnapshot(rulesetId);
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
        // text mode — resolve matchMode (with legacy useRegex migration)
        const matchMode = config.matchMode ?? (config.useRegex ? 'regex' : 'keyword');
        if (matchMode === 'regex') {
            return testRegex(text, config.pattern ?? '');
        }
        const snapshot = getTurnVarsSnapshot(rulesetId);
        const expanded = _expandKwVars(await resolveLbQueryTokens(config.keywords ?? '', snapshot), snapshot);
        const resolved = resolveTransforms(expanded);
        const kws      = resolved.split(',').map(k => k.trim()).filter(Boolean);
        if (matchMode === 'fuzzy') {
            const rawNum = parseFloat(config.fuzzyThreshold ?? '80');
            const thresh = Number.isFinite(rawNum) ? rawNum / 100 : 0.80;
            for (const kw of kws) {
                const m = fuzzyMatchText(text, kw, thresh);
                if (m) return m.value;
            }
            return null;
        }
        const cs = config.caseSensitive ?? false;
        for (const kw of kws) {
            const m = matchKeyword(text, kw, cs);
            if (m) return m;
        }
        return null;
    },
    renderConfig($el, config, onChange) {
        const mode      = config.mode ?? 'text';
        const matchMode = config.matchMode ?? (config.useRegex ? 'regex' : 'keyword');
        const lbUid     = `trg-lb-${Math.random().toString(36).slice(2, 7)}`;
        $el.html(`
<div style="margin-bottom:6px">
    <select class="trg-kw-mode" style="font-size:.85em">
        <option value="text"     ${mode==='text'     ?'selected':''}>text</option>
        <option value="lorebook" ${mode==='lorebook' ?'selected':''}>lorebook</option>
    </select>
</div>
<div class="trg-kw-text-ui"${mode!=='text'?' style="display:none"':''}>
    <div style="display:flex;gap:12px;align-items:center;margin-bottom:4px;flex-wrap:wrap">
        <label class="trg-check-row">
            <input type="checkbox" class="trg-kw-regex" ${matchMode==='regex'?'checked':''} />
            regex
        </label>
        <label class="trg-check-row">
            <input type="checkbox" class="trg-kw-fuzzy" ${matchMode==='fuzzy'?'checked':''} />
            fuzzy
        </label>
        <input type="number" class="trg-kw-fuzz-thresh" min="0" max="100"
            value="${esc(config.fuzzyThreshold ?? '80')}" title="Jaro-Winkler threshold 0–100"
            style="width:48px;${matchMode!=='fuzzy'?'visibility:hidden;':''}" />
    </div>
    <div class="trg-kw-literal-ui"${matchMode==='regex'?' style="display:none"':''}>
        <input type="text" class="text_pole trg-cfg trg-kw-input" placeholder="word1, sam*, el?ra, ..." value="${esc(config.keywords ?? '')}" />
        <small class="trg-hint">Comma-separated — multiple keywords trigger on any match</small>
        <div class="trg-kw-preview" style="display:none;"></div>
        <div class="trg-kw-footer">
            <label class="trg-check-row trg-kw-cs-row"${matchMode==='fuzzy'?' style="visibility:hidden"':''}>
                <input type="checkbox" class="trg-kw-cs" ${config.caseSensitive ? 'checked' : ''} />
                case sensitive
            </label>
            <span class="trg-help-toggle" title="How this works">?</span>
        </div>
        <div class="trg-help-text" style="display:none;">
            Separate keywords with commas. Matches anywhere in the text.<br>
            <b>*</b> — any word characters &nbsp;&nbsp; <b>?</b> — exactly one word character<br>
            <span class="trg-help-eg">sam*</span> → sam, samuel, samurai &nbsp;
            <span class="trg-help-eg">el?ra</span> → elara, elora<br>
            Case sensitive applies to plain text and wildcards. Use <i>regex</i> for full patterns.
            Fuzzy mode uses Jaro-Winkler similarity — threshold 0–100 (default 80).
        </div>
    </div>
    <div class="trg-kw-pattern-ui"${matchMode!=='regex'?' style="display:none"':''}>
        <textarea class="text_pole trg-cfg trg-kw-pattern" rows="3" placeholder="/pattern/flags or plain text (case-insensitive)">${esc(config.pattern ?? '')}</textarea>
        <small class="trg-hint">Use <b>/pattern/flags</b> syntax for flags, or plain text for a case-insensitive match. Capture group 1 is returned as the match value.</small>
    </div>
    ${testDrawerHtml()}
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
</div>`);

        if (mode === 'text' && matchMode === 'keyword') updateKwPreview($el, config.keywords ?? '', config.caseSensitive ?? false);

        const read = () => {
            const regexOn = $el.find('.trg-kw-regex').prop('checked');
            const fuzzyOn = $el.find('.trg-kw-fuzzy').prop('checked');
            return {
                ...config,
                mode:           $el.find('.trg-kw-mode').val(),
                matchMode:      fuzzyOn ? 'fuzzy' : regexOn ? 'regex' : 'keyword',
                fuzzyThreshold: $el.find('.trg-kw-fuzz-thresh').val(),
                keywords:       $el.find('.trg-kw-input').val(),
                caseSensitive:  $el.find('.trg-kw-cs').prop('checked'),
                pattern:        $el.find('.trg-kw-pattern').val().trim(),
                lbScope:        $el.find('.trg-kw-lb-scope').val(),
                lbBook:         $el.find('.trg-kw-lb-book').val(),
                lbEntry:        $el.find('.trg-kw-lb-entry').val(),
                lbTag:          $el.find('.trg-kw-lb-tag').val(),
                lbKey:          $el.find('.trg-kw-lb-key').val(),
            };
        };

        const refreshTestDrawer = attachTestDrawer($el, read, _resolveTestSpans);

        $el.find('.trg-kw-mode').on('change', function () {
            const newMode = this.value;
            $el.find('.trg-kw-text-ui').toggle(newMode === 'text');
            $el.find('.trg-kw-lb-ui').toggle(newMode === 'lorebook');
            if (newMode === 'text' && !$el.find('.trg-kw-regex').prop('checked') && !$el.find('.trg-kw-fuzzy').prop('checked')) {
                updateKwPreview($el, $el.find('.trg-kw-input').val(), $el.find('.trg-kw-cs').prop('checked'));
            }
            onChange(read());
        });
        $el.find('.trg-kw-regex').on('change', function () {
            if (this.checked) $el.find('.trg-kw-fuzzy').prop('checked', false);
            const mm = this.checked ? 'regex' : 'keyword';
            $el.find('.trg-kw-literal-ui').toggle(mm !== 'regex');
            $el.find('.trg-kw-pattern-ui').toggle(mm === 'regex');
            $el.find('.trg-kw-fuzz-thresh').css('visibility', 'hidden');
            $el.find('.trg-kw-cs-row').css('visibility', 'visible');
            onChange(read());
            refreshTestDrawer();
        });
        $el.find('.trg-kw-fuzzy').on('change', function () {
            if (this.checked) $el.find('.trg-kw-regex').prop('checked', false);
            $el.find('.trg-kw-literal-ui').show();
            $el.find('.trg-kw-pattern-ui').hide();
            $el.find('.trg-kw-fuzz-thresh').css('visibility', this.checked ? 'visible' : 'hidden');
            $el.find('.trg-kw-cs-row').css('visibility', this.checked ? 'hidden' : 'visible');
            onChange(read());
            refreshTestDrawer();
        });
        $el.find('.trg-kw-fuzz-thresh').on('input', () => { onChange(read()); refreshTestDrawer(); });
        $el.find('.trg-kw-input').on('input', function () {
            const cur = read();
            if (cur.matchMode === 'keyword') updateKwPreview($el, cur.keywords, cur.caseSensitive);
            onChange(cur);
            refreshTestDrawer();
        });
        $el.find('.trg-kw-cs').on('change', function () {
            const cur = read();
            updateKwPreview($el, cur.keywords, cur.caseSensitive);
            onChange(cur);
            refreshTestDrawer();
        });
        $el.find('.trg-kw-pattern').on('input', function () {
            onChange(read());
            refreshTestDrawer();
        });
        $el.find('.trg-kw-lb-scope, .trg-kw-lb-book, .trg-kw-lb-entry, .trg-kw-lb-tag, .trg-kw-lb-key')
           .on('change input', function () { onChange(read()); });
        $el.find('.trg-help-toggle').on('click', function () {
            $el.find('.trg-help-text').slideToggle(150);
            $(this).toggleClass('trg-help-open');
        });

    },
};
