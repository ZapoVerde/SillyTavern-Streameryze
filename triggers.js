/**
 * @file st-extensions/SillyTavern-Triggeryze/triggers.js
 * @stamp {"utc":"2026-06-13T00:00:00.000Z"}
 * @architectural-role Registry — TRIGGER_REGISTRY assembler and built-in trigger implementations
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
import { getLocalVariable, getGlobalVariable }                               from '../../../../scripts/variables.js';

// Lorebook keyword cache. One build per generation, cleared on GENERATION_STARTED.
let _wiCache     = null;
let _entryCache  = null;  // full entry objects, cleared with _wiCache

// Set to true once MESSAGE_RECEIVED fires (i.e. the message is fully committed).
// Reset to false on GENERATION_STARTED. Read by the chatComplete trigger.
let _chatComplete = false;

export function clearWiCache() {
    _wiCache    = null;
    _entryCache = null;
}

export function setChatComplete(value) {
    _chatComplete = value;
}

// Turn-level variable store. Populated by engine.js when an action writes to outputVar.
// Cleared on GENERATION_STARTED. Read by the varMatch trigger.
const _turnVars = new Map();

export function setTurnVar(name, value)  { _turnVars.set(name, value); }
export function getTurnVar(name)         { return _turnVars.get(name); }
export function clearTurnVars()          { _turnVars.clear(); }
export function getTurnVarsSnapshot()    { return Object.fromEntries(_turnVars); }

// ---------------------------------------------------------------------------
// LB query system
// Resolves {{lbTitles:...}}, {{lbKeys:...}}, {{lbContent:...}} tokens.
// All three share the same 4-argument positional syntax:
//   :[lb filter]:[title filter]:[key filter]:mode
// Each filter is either [literal, list] or a variable name (bare).
// Mode is: first | last | all  (default: all for titles/keys, first for content)
// ---------------------------------------------------------------------------

async function getActiveEntries() {
    if (_entryCache) return _entryCache;
    _entryCache = (await getSortedEntries()).filter(e => !e.disable);
    return _entryCache;
}

// Parse a single argument slot: '' → null (wildcard), '[a,b]' → ['a','b'], 'name' → 'name'
function _parseArg(arg) {
    const t = (arg ?? '').trim();
    if (!t) return null;
    if (t.startsWith('[') && t.endsWith(']'))
        return t.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
    return t;
}

// Resolve a parsed arg against vars: null → null (wildcard), array → keep, string → expand var
function _resolveArg(parsed, vars) {
    if (parsed === null) return null;
    if (Array.isArray(parsed)) return parsed;
    const val = vars?.[parsed] ?? '';
    return val ? val.split(',').map(s => s.trim()).filter(Boolean) : [];
}

function _globTest(pattern, str) {
    const re = new RegExp(
        '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
        'i',
    );
    return re.test(str);
}

function _filterMatches(items, str) {
    if (items === null) return true;   // wildcard
    if (!items.length)  return false;  // unresolved var → match nothing
    return items.some(p => _globTest(p, str));
}

async function _queryEntries(lbFilter, titleFilter, keyFilter, vars) {
    const lb    = _resolveArg(lbFilter, vars);
    const title = _resolveArg(titleFilter, vars);
    const key   = _resolveArg(keyFilter, vars);
    const all   = await getActiveEntries();
    return all.filter(e => {
        if (!_filterMatches(lb,    e.world   ?? '')) return false;
        if (!_filterMatches(title, e.comment ?? '')) return false;
        if (key !== null) {
            const keys = Array.isArray(e.key) ? e.key : [];
            if (!keys.some(k => _filterMatches(key, k))) return false;
        }
        return true;
    });
}

/**
 * Pre-resolves {{lbTitles:...}}, {{lbKeys:...}}, {{lbContent:...}} tokens in a string.
 * Must run before interpolate() — interpolate's {{...}} regex would otherwise blank them.
 * vars should be the current turn-var snapshot (getTurnVarsSnapshot()).
 */
export async function resolveLbQueryTokens(template, vars = {}) {
    if (!template) return template;
    if (!template.includes('{{lb')) return template;

    const RE = /\{\{(lbTitles|lbKeys|lbContent|lbBooks)((?::[^}]*)*)\}\}/g;
    const tokens = [...template.matchAll(RE)];
    if (!tokens.length) return template;

    let result = template;
    for (const m of tokens) {
        const type   = m[1];
        const parts  = m[2] ? m[2].slice(1).split(':') : [];
        const lbArg    = _parseArg(parts[0]);
        const titleArg = _parseArg(parts[1]);
        const keyArg   = _parseArg(parts[2]);
        const mode     = (parts[3] ?? '').trim() || null;

        const entries = await _queryEntries(lbArg, titleArg, keyArg, vars);
        let replacement = '';

        if (type === 'lbTitles') {
            const titles = entries.map(e => e.comment).filter(Boolean);
            const m2 = mode ?? 'all';
            replacement = m2 === 'first' ? (titles[0] ?? '')
                        : m2 === 'last'  ? (titles[titles.length - 1] ?? '')
                        : titles.join(', ');
        } else if (type === 'lbKeys') {
            const keys = [...new Set(entries.flatMap(e => Array.isArray(e.key) ? e.key : []).filter(Boolean))];
            const m2 = mode ?? 'all';
            replacement = m2 === 'first' ? (keys[0] ?? '')
                        : m2 === 'last'  ? (keys[keys.length - 1] ?? '')
                        : keys.join(', ');
        } else if (type === 'lbBooks') {
            const books = [...new Set(entries.map(e => e.world).filter(Boolean))];
            const m2 = mode ?? 'all';
            replacement = m2 === 'first' ? (books[0] ?? '')
                        : m2 === 'last'  ? (books[books.length - 1] ?? '')
                        : books.join(', ');
        } else {
            const m2 = mode ?? 'first';
            if (m2 === 'first')      replacement = entries[0]?.content ?? '';
            else if (m2 === 'last')  replacement = entries[entries.length - 1]?.content ?? '';
            else                     replacement = entries.map(e => e.content).filter(Boolean).join('\n\n');
        }

        result = result.replace(m[0], () => replacement);
    }
    return result;
}

// Parse .key or [key] index from an ST variable reference.
// Mirrors _parseVarRef in template.js — duplicated to avoid circular import.
function _parseVarRef(ref) {
    const t  = ref.trim();
    const bm = t.match(/^([^\[.]+)\[([^\]]+)\]$/);
    if (bm) return { name: bm[1].trim(), index: bm[2].trim() };
    const dm = t.match(/^([^.]+)\.(.+)$/);
    if (dm) return { name: dm[1].trim(), index: dm[2].trim() };
    return { name: t, index: undefined };
}

// Lightweight turn-var expansion for keyword fields.
// Unresolved tokens → empty string at evaluation time (produces no match).
function _expandKwVars(str, snapshot) {
    return str.replace(/\{\{([^{}]+)\}\}/g, (_, k) => {
        k = k.trim();
        if (k.startsWith('chatvar::')) {
            const { name, index } = _parseVarRef(k.slice(9));
            return String(getLocalVariable(name, index !== undefined ? { index } : {}) ?? '');
        }
        if (k.startsWith('globalvar::')) {
            const { name, index } = _parseVarRef(k.slice(12));
            return String(getGlobalVariable(name, index !== undefined ? { index } : {}) ?? '');
        }
        const v = snapshot[k];
        return v !== undefined ? String(v) : '';
    });
}

// Same as above but keeps unresolved tokens as-is (for preview display).
function _expandKwVarsForPreview(str, snapshot) {
    return str.replace(/\{\{([^{}]+)\}\}/g, (match, k) => {
        k = k.trim();
        if (k.startsWith('chatvar::')) {
            const { name, index } = _parseVarRef(k.slice(9));
            const val = getLocalVariable(name, index !== undefined ? { index } : {});
            return val !== null && val !== undefined ? String(val) : match;
        }
        if (k.startsWith('globalvar::')) {
            const { name, index } = _parseVarRef(k.slice(12));
            const val = getGlobalVariable(name, index !== undefined ? { index } : {});
            return val !== null && val !== undefined ? String(val) : match;
        }
        const v = snapshot[k];
        return v !== undefined ? String(v) : match;
    });
}

function updateVarPreview($el, varName) {
    const $p = $el.find('.trg-var-preview');
    if (!varName) { $p.hide().empty(); return; }
    if (!_turnVars.has(varName)) {
        $p.html(`<span class="trg-prev-unset">"${esc(varName)}" not set this turn</span>`).show();
    } else {
        $p.html(`current: <span class="trg-prev-kw">${esc(String(_turnVars.get(varName)))}</span>`).show();
    }
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

/**
 * Finds a lorebook entry whose comment (title) matches entryName.
 * Searches all active, non-disabled entries across all loaded lorebooks.
 * If lbName is provided, restricts to entries belonging to that lorebook.
 * Returns the entry object, or null if no match is found.
 */
export async function getLbEntryByName(entryName, lbName = null) {
    const entries = await getSortedEntries();
    const needle  = entryName.toLowerCase();
    for (const e of entries) {
        if (e.disable) continue;
        if (!e.comment) continue;
        if (lbName && e.world !== lbName) continue;
        if (e.comment.toLowerCase() === needle) return e;
    }
    return null;
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
        return `<span class="trg-prev-kw">${esc(kw)}</span> — anywhere in text, ${caseNote}`;
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

    return `<span class="trg-prev-kw">${esc(kw)}</span> — ${segments.join(' + ')} `
         + `<span class="trg-prev-re">( /${esc(reStr)}/${flags} )</span>`;
}

async function updateKwPreview($el, keywords, cs) {
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
            $el.html(`
<input type="text" class="text_pole trg-cfg" placeholder="word1, sam*, el?ra, ..." value="${esc(config.keywords)}" />
<small class="trg-hint">Comma-separated — multiple keywords trigger on any match</small>
<div class="trg-kw-preview" style="display:none;"></div>
<div class="trg-kw-footer">
    <label class="trg-check-row">
        <input type="checkbox" ${config.caseSensitive ? 'checked' : ''} />
        case sensitive
    </label>
    <span class="trg-help-toggle" title="How this works">?</span>
</div>
<div class="trg-help-text" style="display:none;">
    Separate keywords with commas. Matches anywhere in the text.<br>
    <b>*</b> — any characters &nbsp;&nbsp; <b>?</b> — exactly one character<br>
    <span class="trg-help-eg">sam*</span> → samuel, samurai &nbsp;
    <span class="trg-help-eg">el?ra</span> → elara, elora<br>
    Case sensitive applies to plain text and wildcards. Use the <i>regex</i> trigger for full patterns.
</div>`);

            // Run preview immediately on render so existing config is described
            updateKwPreview($el, config.keywords ?? '', config.caseSensitive ?? false);

            const read = () => ({
                keywords:      $el.find('input[type="text"]').val(),
                caseSensitive: $el.find('input[type="checkbox"]').prop('checked'),
            });
            $el.find('input[type="text"]').on('input', function () {
                const cur = read();
                updateKwPreview($el, cur.keywords, cur.caseSensitive);
                onChange(cur);
            });
            $el.find('input[type="checkbox"]').on('change', function () {
                const cur = read();
                updateKwPreview($el, cur.keywords, cur.caseSensitive);
                onChange(cur);
            });
            $el.find('.trg-help-toggle').on('click', function () {
                $el.find('.trg-help-text').slideToggle(150);
                $(this).toggleClass('trg-help-open');
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
            $el.html('<small class="trg-hint">Fires on any primary key from the active lorebooks.</small>');
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
            $el.html(`<input type="text" class="text_pole trg-cfg" placeholder="/pattern/flags or plaintext" value="${esc(config.pattern)}" />`);
            $el.find('input').on('input', function () { onChange({ ...config, pattern: this.value }); });
        },
    },

    chatComplete: {
        label: 'chat complete',
        defaultConfig: {},
        async test() {
            return _chatComplete ? 'chat complete' : null;
        },
        renderConfig($el) {
            $el.html('<small class="trg-hint">Fires once after each fully received message. Pair with postMessage actions (call LLM, replace, generate image).</small>');
        },
    },

    badgeTrigger: {
        label: 'badge button',
        defaultConfig: { label: 'run', color: '#8888ff' },
        async test() {
            // Never auto-fires. Activated only by clicking the rendered badge button.
            return null;
        },
        renderConfig($el, config, onChange) {
            $el.html(`
<div style="display:flex;gap:8px;align-items:center">
    <input type="text" class="text_pole trg-cfg trg-bt-label" placeholder="button label" value="${esc(config.label ?? 'run')}" style="flex:1" />
    <input type="color" class="trg-bt-color" value="${esc(config.color ?? '#8888ff')}"
        title="Button color"
        style="width:32px;height:26px;padding:1px 2px;border-radius:4px;cursor:pointer;border:1px solid rgba(255,255,255,.2);background:none" />
</div>
<small class="trg-hint">Adds a clickable button below each AI message. Fires this rule's actions on click. Use with postMessage actions.</small>`);

            const read = () => ({
                label: $el.find('.trg-bt-label').val(),
                color: $el.find('.trg-bt-color').val(),
            });
            $el.find('.trg-bt-label').on('input', () => onChange(read()));
            $el.find('.trg-bt-color').on('input', () => onChange(read()));
        },
    },

    varMatch: {
        label: 'variable match',
        defaultConfig: { varName: '', operator: 'equals', value: '' },
        async test(_text, config) {
            const name = (config.varName ?? '').trim();
            if (!name) return null;
            if (!_turnVars.has(name)) {
                console.warn(`[triggeryze] varMatch: "${name}" not set this turn`);
                return null;
            }
            const actual = String(_turnVars.get(name) ?? '');
            const op     = config.operator ?? 'equals';
            const target = config.value ?? '';
            let hits = false;
            if (op === 'equals')   hits = actual === target;
            if (op === 'contains') hits = actual.toLowerCase().includes(target.toLowerCase());
            if (op === 'matches')  { try { hits = new RegExp(target, 'i').test(actual); } catch { hits = false; } }
            if (op === 'notEmpty') hits = actual.trim() !== '';
            return hits ? actual : null;
        },
        renderConfig($el, config, onChange) {
            $el.html(`
<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
    <input type="text" class="text_pole trg-cfg trg-vm-name" placeholder="variable name" value="${esc(config.varName ?? '')}" style="flex:1;min-width:80px" />
    <select class="trg-cfg trg-vm-op" style="flex:0 0 auto">
        <option value="equals"   ${config.operator === 'equals'   ? 'selected' : ''}>equals</option>
        <option value="contains" ${config.operator === 'contains' ? 'selected' : ''}>contains</option>
        <option value="matches"  ${config.operator === 'matches'  ? 'selected' : ''}>matches regex</option>
        <option value="notEmpty" ${config.operator === 'notEmpty' ? 'selected' : ''}>not empty</option>
    </select>
    <input type="text" class="text_pole trg-cfg trg-vm-value" placeholder="value"
        value="${esc(config.value ?? '')}"
        style="flex:1;min-width:80px;${config.operator === 'notEmpty' ? 'display:none' : ''}" />
</div>
<div class="trg-var-preview" style="display:none;margin-top:3px;font-size:.82em;opacity:.8;"></div>`);

            const $name  = $el.find('.trg-vm-name');
            const $op    = $el.find('.trg-vm-op');
            const $value = $el.find('.trg-vm-value');

            updateVarPreview($el, config.varName ?? '');

            const read = () => ({
                varName:  $name.val(),
                operator: $op.val(),
                value:    $value.val(),
            });
            $name.on('input', function () {
                onChange(read());
                updateVarPreview($el, this.value.trim());
            });
            $op.on('change', function () {
                $value.toggle(this.value !== 'notEmpty');
                onChange(read());
            });
            $value.on('input', () => onChange(read()));
        },
    },

    chance: {
        label: 'probability',
        defaultConfig: { chance: 50 },
        async test(_text, config) {
            const pct = Number(config.chance ?? 50);
            return Math.random() * 100 < pct ? 'chance' : null;
        },
        renderConfig($el, config, onChange) {
            const pct = Number(config.chance ?? 50);
            $el.html(`
<div style="display:flex;align-items:center;gap:8px">
    <input type="range" class="trg-ch-range" min="0" max="100" step="1" value="${pct}"
        style="flex:1;cursor:pointer" />
    <input type="number" class="trg-cfg trg-ch-num" min="0" max="100" step="1" value="${pct}"
        style="width:56px;text-align:center" />
    <span style="opacity:.6;font-size:.9em;flex-shrink:0">%</span>
</div>
<small class="trg-hint">Fires with this probability each generation. Combine with AND logic to make any rule probabilistic.</small>`);

            const $range = $el.find('.trg-ch-range');
            const $num   = $el.find('.trg-ch-num');
            const emit   = () => onChange({ ...config, chance: Number($num.val()) });
            $range.on('input', function () { $num.val(this.value); emit(); });
            $num.on('input',   function () { $range.val(this.value); emit(); });
        },
    },

    inlineBadge: {
        label: 'inline badge',
        defaultConfig: { keywords: '', caseSensitive: false, color: '#8888ff' },
        async test() {
            // Never auto-fires. Activated only by clicking an injected inline badge span.
            return null;
        },
        renderConfig($el, config, onChange) {
            $el.html(`
<div style="display:flex;gap:8px;align-items:flex-start">
    <div style="flex:1;min-width:0">
        <input type="text" class="text_pole trg-cfg trg-ib-kw" placeholder="word1, fire*, el?ra, ..." value="${esc(config.keywords ?? '')}" />
        <small class="trg-hint">Wraps each match in the message as a clickable badge. Fires this rule's actions on click.</small>
        <div class="trg-kw-preview" style="display:none;"></div>
        <div class="trg-kw-footer">
            <label class="trg-check-row">
                <input type="checkbox" class="trg-ib-cs" ${config.caseSensitive ? 'checked' : ''} />
                case sensitive
            </label>
        </div>
    </div>
    <input type="color" class="trg-ib-color" value="${esc(config.color ?? '#8888ff')}"
        title="Badge color"
        style="width:32px;height:26px;padding:1px 2px;border-radius:4px;cursor:pointer;border:1px solid rgba(255,255,255,.2);background:none;flex-shrink:0;margin-top:2px" />
</div>`);

            updateKwPreview($el, config.keywords ?? '', config.caseSensitive ?? false);

            const read = () => ({
                keywords:      $el.find('.trg-ib-kw').val(),
                caseSensitive: $el.find('.trg-ib-cs').prop('checked'),
                color:         $el.find('.trg-ib-color').val(),
            });
            $el.find('.trg-ib-kw').on('input', function () {
                const cur = read();
                updateKwPreview($el, cur.keywords, cur.caseSensitive);
                onChange(cur);
            });
            $el.find('.trg-ib-cs').on('change', function () {
                const cur = read();
                updateKwPreview($el, cur.keywords, cur.caseSensitive);
                onChange(cur);
            });
            $el.find('.trg-ib-color').on('input', () => onChange(read()));
        },
    },

};
