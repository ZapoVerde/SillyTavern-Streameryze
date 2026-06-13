/**
 * @file st-extensions/SillyTavern-Streameryze/triggers.js
 * @stamp {"utc":"2026-06-13T00:00:00.000Z"}
 * @architectural-role IO Wrapper + Registry
 * @description
 * Trigger registry and built-in trigger implementations.
 *
 * A trigger tests a text sample and returns the matched string if it fires,
 * or null if it does not. Triggers have no side effects. They read; they do
 * not act.
 *
 * To add a new trigger type: add an entry to TRIGGER_REGISTRY. The engine
 * and settings panel discover it automatically — no other files need changing.
 *
 * @api-declaration
 * TRIGGER_REGISTRY — map of type key → trigger definition
 * clearWiCache()   — resets the lorebook keyword cache; called on each new generation
 *
 * @contract
 *   assertions:
 *     purity:          test() functions are read-only; no state mutations beyond _wiCache
 *     state_ownership: [_wiCache]
 *     external_io:     getSortedEntries() (read-only lorebook access)
 */

import { getSortedEntries, parseRegexFromString, world_info_case_sensitive } from '../../../../scripts/world-info.js';

// Lorebook keyword cache. One build per generation, cleared on GENERATION_STARTED.
let _wiCache = null;

export function clearWiCache() {
    _wiCache = null;
}

async function getWiKeywords() {
    if (_wiCache) return _wiCache;
    const entries = await getSortedEntries();
    _wiCache = entries
        .filter(e => !e.disable && Array.isArray(e.key) && e.key.length)
        .flatMap(e => e.key.filter(Boolean).map(k => ({ raw: k, regex: parseRegexFromString(k) })));
    return _wiCache;
}

function matchWiKw(text, { raw, regex }) {
    if (regex) return regex.test(text);
    if (world_info_case_sensitive) return text.includes(raw);
    return text.toLowerCase().includes(raw.toLowerCase());
}

function esc(s) { return $('<span>').text(s ?? '').html(); }

/**
 * Converts a glob-style keyword to a RegExp.
 * Only called when the keyword contains * or ?.
 * Escapes all regex special chars except * and ?, then substitutes them.
 */
function globToRegex(pattern, caseSensitive) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
                           .replace(/\*/g, '.*')
                           .replace(/\?/g, '.');
    return new RegExp(escaped, caseSensitive ? '' : 'i');
}

/**
 * Returns an HTML description of a single keyword — what it will catch.
 * Used by the live preview below the keyword input.
 */
function describeKw(kw, cs) {
    const hasGlob = kw.includes('*') || kw.includes('?');

    if (!hasGlob) {
        const caseNote = cs ? 'exact case' : 'any case';
        return `<span class="smz-prev-kw">${esc(kw)}</span> — anywhere in text, ${caseNote}`;
    }

    // Walk the pattern and build a human-readable segment list
    const segments = [];
    let literal = '';
    for (const ch of kw) {
        if (ch === '*') {
            if (literal) { segments.push(`<em>${esc(literal)}</em>`); literal = ''; }
            segments.push('anything');
        } else if (ch === '?') {
            if (literal) { segments.push(`<em>${esc(literal)}</em>`); literal = ''; }
            segments.push('any&nbsp;1&nbsp;char');
        } else {
            literal += ch;
        }
    }
    if (literal) segments.push(`<em>${esc(literal)}</em>`);

    const reStr = kw.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    const flags = cs ? '' : 'i';

    return `<span class="smz-prev-kw">${esc(kw)}</span> — ${segments.join(' + ')} `
         + `<span class="smz-prev-re">( /${esc(reStr)}/${flags} )</span>`;
}

function updateKwPreview($el, keywords, cs) {
    const kws = keywords.split(',').map(k => k.trim()).filter(Boolean);
    const $preview = $el.find('.smz-kw-preview');
    if (!kws.length) { $preview.hide().empty(); return; }
    $preview.html(kws.map(kw => `<div>${describeKw(kw, cs)}</div>`).join('')).show();
}

/**
 * Trigger registry.
 *
 * Each entry must provide:
 *   label         — display name shown in the settings UI
 *   defaultConfig — initial config object when the trigger is first added
 *   test(text, config) → Promise<string|null>
 *                 — returns the matched string, or null if no match.
 *                   text is the accumulated stream text (stream stage) or
 *                   the final message text (postMessage stage).
 *   renderConfig($el, config, onChange)
 *                 — renders configuration UI into $el; calls onChange(newConfig)
 *                   when the user edits a field. onChange is config-only (no re-render).
 */
export const TRIGGER_REGISTRY = {

    keywordMatch: {
        label: 'keyword match',
        defaultConfig: { keywords: '', caseSensitive: false },
        async test(text, config) {
            const cs  = config.caseSensitive ?? false;
            const kws = (config.keywords ?? '').split(',').map(k => k.trim()).filter(Boolean);
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
            $el.html(`
<input type="text" class="text_pole smz-cfg" placeholder="word1, sam*, el?ra, ..." value="${esc(config.keywords)}" />
<small class="smz-hint">Comma-separated — multiple keywords trigger on any match</small>
<div class="smz-kw-preview" style="display:none;"></div>
<div class="smz-kw-footer">
    <label class="smz-check-row">
        <input type="checkbox" ${config.caseSensitive ? 'checked' : ''} />
        case sensitive
    </label>
    <span class="smz-help-toggle" title="How this works">?</span>
</div>
<div class="smz-help-text" style="display:none;">
    Separate keywords with commas. Matches anywhere in the text.<br>
    <b>*</b> — any characters &nbsp;&nbsp; <b>?</b> — exactly one character<br>
    <span class="smz-help-eg">sam*</span> → samuel, samurai &nbsp;
    <span class="smz-help-eg">el?ra</span> → elara, elora<br>
    Case sensitive applies to plain text and wildcards. Use the <i>regex</i> trigger for full patterns.
</div>`);

            // Run preview immediately on render so existing config is described
            updateKwPreview($el, config.keywords ?? '', config.caseSensitive ?? false);

            $el.find('input[type="text"]').on('input', function () {
                const keywords = this.value;
                const cs = $el.find('input[type="checkbox"]').prop('checked');
                updateKwPreview($el, keywords, cs);
                onChange({ ...config, keywords });
            });
            $el.find('input[type="checkbox"]').on('change', function () {
                const cs = this.checked;
                const keywords = $el.find('input[type="text"]').val();
                updateKwPreview($el, keywords, cs);
                onChange({ ...config, caseSensitive: cs });
            });
            $el.find('.smz-help-toggle').on('click', function () {
                $el.find('.smz-help-text').slideToggle(150);
                $(this).toggleClass('smz-help-open');
            });
        },
    },

    lbKeyword: {
        label: 'lorebook keyword',
        defaultConfig: {},
        async test(text) {
            const kws = await getWiKeywords();
            for (const kw of kws) {
                if (matchWiKw(text, kw)) return kw.raw;
            }
            return null;
        },
        renderConfig($el) {
            $el.html('<small class="smz-hint">Fires on any primary key from the active lorebooks.</small>');
        },
    },

    regex: {
        label: 'regex',
        defaultConfig: { pattern: '' },
        async test(text, config) {
            if (!config.pattern) return null;
            try {
                const re = parseRegexFromString(config.pattern) ?? new RegExp(config.pattern);
                const m = re.exec(text);
                return m ? m[0] : null;
            } catch { return null; }
        },
        renderConfig($el, config, onChange) {
            $el.html(`<input type="text" class="text_pole smz-cfg" placeholder="/pattern/flags or plaintext" value="${esc(config.pattern)}" />`);
            $el.find('input').on('input', function () { onChange({ ...config, pattern: this.value }); });
        },
    },

};
