/**
 * @file triggers/kw-preview.js
 * @stamp {"utc":"2026-06-16T00:00:00.000Z"}
 * @architectural-role UI — keyword preview rendering shared by keyword and badge trigger entries
 * @description
 * Renders live preview of how a keyword list will match at evaluation time.
 * Used by the keyword trigger (text mode) and the badge trigger (inline mode).
 * Contains no rule evaluation logic; only DOM mutation for the settings panel.
 *
 * @api-declaration
 * esc(s)                              → string  HTML-escapes s for safe insertion
 * describeKw(kw, cs)                  → string  HTML description of a single keyword
 * updateKwPreview($el, keywords, cs)  — async; renders preview into .trg-kw-preview inside $el
 *
 * @contract
 *   assertions:
 *     purity:          esc and describeKw are pure; updateKwPreview mutates DOM only
 *     state_ownership: none
 *     external_io:     [resolveLbQueryTokens (read), getTurnVarsSnapshot (read),
 *                       getLocalVariable, getGlobalVariable (read)]
 */

import { getLocalVariable, getGlobalVariable }    from '../../../../../scripts/variables.js';
import { parseVarRef, resolveStVar }              from '../actions/condition.js';
import { resolveLbQueryTokens }                   from './lb-query.js';
import { getTurnVarsSnapshot }                    from './turn-vars.js';

export function esc(s) { return $('<span>').text(s ?? '').html(); }

// Expands {{var}} tokens for preview display, keeping unresolved tokens as-is.
function _expandKwVarsForPreview(str, snapshot) {
    return str.replace(/\{\{([^{}]+)\}\}/g, (match, k) => {
        k = k.trim();
        if (k.startsWith('chatvar::')) {
            const { name, index } = parseVarRef(k.slice(9));
            const val = getLocalVariable(name, index !== undefined ? { index } : {});
            return val !== null && val !== undefined ? String(val) : match;
        }
        if (k.startsWith('globalvar::')) {
            const { name, index } = parseVarRef(k.slice(12));
            const val = getGlobalVariable(name, index !== undefined ? { index } : {});
            return val !== null && val !== undefined ? String(val) : match;
        }
        const v = snapshot[k];
        return v !== undefined ? String(v) : match;
    });
}

export function describeKw(kw, cs) {
    const hasGlob = kw.includes('*') || kw.includes('?');

    if (!hasGlob) {
        const caseNote = cs ? 'exact case' : 'any case';
        return `<span class="trg-prev-kw">${esc(kw)}</span> — anywhere in text, ${caseNote}`;
    }

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

    return `<span class="trg-prev-kw">${esc(kw)}</span> — ${segments.join(' + ')} `
         + `<span class="trg-prev-re">( /${esc(reStr)}/${flags} )</span>`;
}

export async function updateKwPreview($el, keywords, cs) {
    const $preview = $el.find('.trg-kw-preview');
    if (!keywords.trim()) { $preview.hide().empty(); return; }

    const snapshot  = getTurnVarsSnapshot();
    const afterLb   = await resolveLbQueryTokens(keywords, snapshot);
    const afterVars = _expandKwVarsForPreview(afterLb, snapshot);

    const kws = afterVars.split(',').map(k => k.trim()).filter(Boolean);
    if (!kws.length) { $preview.hide().empty(); return; }

    const items = kws.map(kw =>
        (kw.startsWith('{{') && kw.endsWith('}}'))
            ? `<div><span class="trg-prev-unset">${esc(kw)} — not set this turn</span></div>`
            : `<div>${describeKw(kw, cs)}</div>`,
    );
    $preview.html(items.join('')).show();
}
