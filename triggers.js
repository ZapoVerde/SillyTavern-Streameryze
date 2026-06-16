/**
 * @file st-extensions/SillyTavern-Triggeryze/triggers.js
 * @stamp {"utc":"2026-06-16T00:00:00.000Z"}
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
 * TRIGGER_REGISTRY      — map of type key → trigger definition
 * clearWiCache()        — resets the lorebook keyword cache; called on each new generation
 * setCurrentEvent(name) — sets the active ST event name; called by engine before an event rule pass
 * clearCurrentEvent()   — clears the active event name after the rule pass
 *
 * @contract
 *   assertions:
 *     purity:          test() functions are read-only; no state mutations beyond _wiCache / _currentEvent / _turnVars
 *     state_ownership: [_wiCache, _currentEvent, _turnVars]
 *     external_io:     getSortedEntries() (read-only lorebook access)
 */

import { getSortedEntries, parseRegexFromString, world_info_case_sensitive, loadWorldInfo, world_names } from '../../../../scripts/world-info.js';
import { getLocalVariable, getGlobalVariable }                               from '../../../../scripts/variables.js';
import { parseVarRef, resolveStVar, evalCondition, makeLookup }              from './actions/condition.js';

// Lorebook keyword cache. One build per generation, cleared on GENERATION_STARTED.
let _wiCache     = null;
let _entryCache  = null;  // active entries, cleared with _wiCache
let _allEntryCache = null; // all-lorebooks entries (scope:'all'), cleared with _wiCache

export function clearWiCache() {
    _wiCache       = null;
    _entryCache    = null;
    _allEntryCache = null;
}

// Active ST event name during an event-trigger rule pass. Set by engine.js; read by the
// event trigger's test(). Empty string outside of a pass.
let _currentEvent = '';
export function setCurrentEvent(name) { _currentEvent = name; }
export function clearCurrentEvent()   { _currentEvent = ''; }

// Turn-level variable store. Populated by engine.js when an action writes to outputVar.
// Cleared on GENERATION_STARTED. Read by the varMatch trigger.
const _turnVars = new Map();

export function setTurnVar(name, value)  { _turnVars.set(name, value); }
export function getTurnVar(name)         { return _turnVars.get(name); }
export function clearTurnVars()          { _turnVars.clear(); }
export function getTurnVarsSnapshot()    { return Object.fromEntries(_turnVars); }

// ---------------------------------------------------------------------------
// LB query system
// Resolves {{lbTitles:...}}, {{lbKeys:...}}, {{lbContent:...}}, {{lbBooks:...}} tokens.
// Full positional syntax:
//   :[lb filter]:[title filter]:[key filter]:[mode]:[scope]
// Each filter is either [literal, list] or a variable name (bare). '' = wildcard.
// mode  — first | last | all  (default: all for titles/keys/books, first for content)
// scope — active | inactive | all  (default: active)
//
// SCOPE values:
//   active   (default, omitted) — entries from ST's four active lorebook sources:
//              1. Globally selected WI-panel lorebooks (selected_world_info)
//              2. The current character's attached lorebook(s)
//              3. The lorebook pinned to the current chat (chat_metadata)
//              4. The current persona's lorebook
//            This is ST-consistent: the same set WI would normally consult.
//   all      — entries from every lorebook on disk (world_names), active or not.
//              Use when you want a Triggeryze-only lorebook that isn't in any WI slot.
//   inactive — entries from disk that are NOT in any active slot. Complement of active.
//
// The lbKeyword trigger always uses active scope (it has no slot for a scope argument).
// ---------------------------------------------------------------------------

async function getActiveEntries() {
    if (_entryCache) return _entryCache;
    _entryCache = (await getSortedEntries()).filter(e => !e.disable);
    return _entryCache;
}

async function _getAllEntries() {
    if (_allEntryCache) return _allEntryCache;
    const names = Array.isArray(world_names) ? world_names : [];
    const buckets = await Promise.all(
        names.map(async name => {
            const data = await loadWorldInfo(name);
            if (!data?.entries) return [];
            return Object.values(data.entries)
                .map(e => ({ ...e, world: name }))
                .filter(e => !e.disable);
        }),
    );
    _allEntryCache = buckets.flat();
    return _allEntryCache;
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

async function _queryEntries(lbFilter, titleFilter, keyFilter, vars, scope = 'active') {
    const lb    = _resolveArg(lbFilter, vars);
    const title = _resolveArg(titleFilter, vars);
    const key   = _resolveArg(keyFilter, vars);

    let pool;
    if (scope === 'all') {
        pool = await _getAllEntries();
    } else if (scope === 'inactive') {
        const [all, active] = await Promise.all([_getAllEntries(), getActiveEntries()]);
        const activeWorlds  = new Set(active.map(e => e.world).filter(Boolean));
        pool = all.filter(e => e.world && !activeWorlds.has(e.world));
    } else {
        pool = await getActiveEntries();
    }

    return pool.filter(e => {
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
 * Pre-resolves {{lbTitles:...}}, {{lbKeys:...}}, {{lbContent:...}}, {{lbBooks:...}} tokens.
 * Must run before interpolate() — interpolate's {{...}} regex would otherwise blank them.
 * vars should be the current turn-var snapshot (getTurnVarsSnapshot()).
 *
 * Syntax: {{lbKeys:[lb]:[title]:[key]:[mode]:[scope]}}
 * scope defaults to 'active'. Pass 'all' or 'inactive' to reach off-WI lorebooks.
 * See the LB query system comment block above for full scope semantics.
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
        const scope    = (parts[4] ?? '').trim() || 'active';

        const entries = await _queryEntries(lbArg, titleArg, keyArg, vars, scope);
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

// Lightweight turn-var expansion for keyword fields.
// Unresolved tokens → empty string at evaluation time (produces no match).
function _expandKwVars(str, snapshot) {
    return str.replace(/\{\{([^{}]+)\}\}/g, (_, k) => {
        k = k.trim();
        if (k.startsWith('chatvar::'))   return resolveStVar(k.slice(9),  getLocalVariable);
        if (k.startsWith('globalvar::')) return resolveStVar(k.slice(12), getGlobalVariable);
        const v = snapshot[k];
        return v !== undefined ? String(v) : '';
    });
}

// Same as above but keeps unresolved tokens as-is (for preview display).
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

    keyword: {
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
    },

    event: {
        label: 'event',
        defaultConfig: { event: 'MESSAGE_RECEIVED' },
        async test(_text, config) {
            const ev = config.event ?? '';
            return _currentEvent === ev && ev ? ev : null;
        },
        renderConfig($el, config, onChange) {
            const ev = config.event ?? 'MESSAGE_RECEIVED';
            const hints = {
                MESSAGE_RECEIVED:           'Fires once after each AI message is fully received. Replaces the legacy "chat complete" trigger.',
                GENERATION_STARTED:         'Fires when a new AI turn begins, before any tokens arrive. Use to clear variables or prepare state for the coming turn.',
                CHARACTER_MESSAGE_RENDERED: 'Fires each time a message is rendered to the DOM, including on chat reload. Use with care — may run for every message on page load.',
            };
            $el.html(`
<div style="display:flex;flex-direction:column;gap:6px">
    <select class="trg-event-name" style="font-size:.85em">
        <option value="MESSAGE_RECEIVED"           ${ev === 'MESSAGE_RECEIVED'           ? 'selected' : ''}>chat complete</option>
        <option value="GENERATION_STARTED"         ${ev === 'GENERATION_STARTED'         ? 'selected' : ''}>generation started</option>
        <option value="CHARACTER_MESSAGE_RENDERED" ${ev === 'CHARACTER_MESSAGE_RENDERED' ? 'selected' : ''}>message rendered</option>
    </select>
    <small class="trg-event-hint trg-hint">${hints[ev] ?? ''}</small>
</div>`);
            $el.find('.trg-event-name').on('change', function () {
                const newEv = this.value;
                $el.find('.trg-event-hint').text(hints[newEv] ?? '');
                onChange({ ...config, event: newEv });
            });
        },
    },

    badge: {
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
    },

    condition: {
        label: 'condition',
        defaultConfig: { expression: '' },
        async test(_text, config) {
            if (!config.expression?.trim()) return null;
            return evalCondition(config.expression, makeLookup(getTurnVarsSnapshot())) ? 'true' : null;
        },
        renderConfig($el, config, onChange) {
            $el.html(`
<input type="text" class="text_pole trg-cfg trg-cond-expr"
    placeholder="chatvar::stats.hp &lt; 20 AND chatvar::gold &gt;= 100"
    value="${esc(config.expression ?? '')}" />
<div class="trg-kw-footer" style="margin-top:4px">
    <small class="trg-hint" style="flex:1">
        Variables, <span class="trg-help-eg">chatvar::</span>/<span class="trg-help-eg">globalvar::</span> (with <span class="trg-help-eg">.key</span> or <span class="trg-help-eg">[key]</span>),
        operators: <span class="trg-help-eg">&lt; &gt; &lt;= &gt;= matches contains is empty in (…)</span>,
        boolean: <span class="trg-help-eg">AND OR !</span> and <span class="trg-help-eg">( )</span>
    </small>
    <span class="trg-cond-result" style="font-size:.78em;font-weight:600;padding:1px 7px;border-radius:8px;border:1px solid;opacity:.8"></span>
</div>`);

            const $expr   = $el.find('.trg-cond-expr');
            const $result = $el.find('.trg-cond-result');

            const preview = () => {
                const expr = $expr.val().trim();
                if (!expr) { $result.hide(); return; }
                const hit = evalCondition(expr, makeLookup(getTurnVarsSnapshot()));
                $result
                    .text(hit ? 'true' : 'false')
                    .css({
                        background:   hit ? 'rgba(50,180,80,.2)'   : 'rgba(180,50,50,.2)',
                        borderColor:  hit ? 'rgba(50,180,80,.5)'   : 'rgba(180,50,50,.5)',
                        color:        hit ? '#8f8'                  : '#f88',
                    })
                    .show();
            };

            $expr.on('input', function () {
                onChange({ ...config, expression: this.value });
                preview();
            });
            preview();
        },
    },

    varMatch: {
        label: 'variable match',
        defaultConfig: { varName: '', operator: 'equals', value: '' },
        async test(_text, config) {
            const name = (config.varName ?? '').trim();
            if (!name) return null;
            const op = config.operator ?? 'equals';

            // set/notSet operate on variable existence, not value
            if (op === 'set')    return _turnVars.has(name) ? (String(_turnVars.get(name) ?? '') || 'set') : null;
            if (op === 'notSet') return _turnVars.has(name) ? null : 'unset';

            if (!_turnVars.has(name)) {
                console.warn(`[triggeryze] varMatch: "${name}" not set this turn`);
                return null;
            }
            const actual = String(_turnVars.get(name) ?? '');
            const target = config.value ?? '';
            if (op === 'equals')    return actual === target ? actual : null;
            if (op === 'notEquals') return actual !== target ? actual : null;
            if (op === 'contains')  return actual.toLowerCase().includes(target.toLowerCase()) ? actual : null;
            if (op === 'matches')   { try { return new RegExp(target, 'i').test(actual) ? actual : null; } catch { return null; } }
            if (op === 'notEmpty')  return actual.trim() !== '' ? actual : null;
            return null;
        },
        renderConfig($el, config, onChange) {
            const _noValue = ['notEmpty', 'set', 'notSet'];
            const op = config.operator ?? 'equals';
            $el.html(`
<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
    <input type="text" class="text_pole trg-cfg trg-vm-name" placeholder="variable name" value="${esc(config.varName ?? '')}" style="flex:1;min-width:80px" />
    <select class="trg-cfg trg-vm-op" style="flex:0 0 auto">
        <option value="equals"    ${op === 'equals'    ? 'selected' : ''}>equals</option>
        <option value="notEquals" ${op === 'notEquals' ? 'selected' : ''}>not equals</option>
        <option value="contains"  ${op === 'contains'  ? 'selected' : ''}>contains</option>
        <option value="matches"   ${op === 'matches'   ? 'selected' : ''}>matches regex</option>
        <option value="notEmpty"  ${op === 'notEmpty'  ? 'selected' : ''}>not empty</option>
        <option value="set"       ${op === 'set'       ? 'selected' : ''}>is set</option>
        <option value="notSet"    ${op === 'notSet'    ? 'selected' : ''}>is not set</option>
    </select>
    <input type="text" class="text_pole trg-cfg trg-vm-value" placeholder="value"
        value="${esc(config.value ?? '')}"
        style="flex:1;min-width:80px;${_noValue.includes(op) ? 'display:none' : ''}" />
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
                $value.toggle(!_noValue.includes(this.value));
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

};

