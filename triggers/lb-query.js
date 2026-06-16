/**
 * @file triggers/lb-query.js
 * @stamp {"utc":"2026-06-16T00:00:00.000Z"}
 * @architectural-role IO — lorebook read access: entry queries, keyword cache, token resolution
 * @description
 * Provides read-only access to ST's lorebook data for use by trigger and action registry entries.
 * Owns the per-generation caches for active entries, all-disk entries, and WI keyword lists.
 * Does not write to lorebooks; that belongs to lorebook action entries.
 *
 * @api-declaration
 * clearWiCache()                              — resets all per-generation caches; call on GENERATION_STARTED
 * getWiKeywords()                             → Promise<{raw, regex}[]>  active WI keywords
 * matchWiKw(text, {raw, regex})               → boolean
 * getLbEntryByName(entryName, lbName?)        → Promise<entry|null>
 * resolveLbQueryTokens(template, vars?)       → Promise<string>  expands {{lbTitles:…}} etc.
 *
 * @contract
 *   assertions:
 *     purity:          all functions are read-only; no lorebook writes
 *     state_ownership: [_wiCache, _entryCache, _allEntryCache]
 *     external_io:     [getSortedEntries, loadWorldInfo, world_names (read)]
 */

import {
    getSortedEntries,
    parseRegexFromString,
    world_info_case_sensitive,
    loadWorldInfo,
    world_names,
} from '../../../../../scripts/world-info.js';

// ---------------------------------------------------------------------------
// Per-generation caches — cleared on GENERATION_STARTED via clearWiCache()
// ---------------------------------------------------------------------------

let _wiCache       = null;  // [{raw, regex}] — active WI keywords
let _entryCache    = null;  // active, non-disabled lorebook entries
let _allEntryCache = null;  // all-disk entries (scope:'all')

export function clearWiCache() {
    _wiCache       = null;
    _entryCache    = null;
    _allEntryCache = null;
}

// ---------------------------------------------------------------------------
// Entry fetching
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

// ---------------------------------------------------------------------------
// WI keyword cache (used by the lbKeyword trigger mode)
// ---------------------------------------------------------------------------

export async function getWiKeywords() {
    if (_wiCache) return _wiCache;
    const entries = await getSortedEntries();
    _wiCache = entries
        .filter(e => !e.disable && Array.isArray(e.key) && e.key.length)
        .flatMap(e => e.key.filter(Boolean).map(k => ({ raw: k, regex: parseRegexFromString(k) })));
    return _wiCache;
}

export function matchWiKw(text, { raw, regex }) {
    if (regex) return regex.test(text);
    if (world_info_case_sensitive) return text.includes(raw);
    return text.toLowerCase().includes(raw.toLowerCase());
}

// ---------------------------------------------------------------------------
// Entry lookup by title
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// LB query system
// Resolves {{lbTitles:…}}, {{lbKeys:…}}, {{lbContent:…}}, {{lbBooks:…}} tokens.
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
 * Pre-resolves {{lbTitles:…}}, {{lbKeys:…}}, {{lbContent:…}}, {{lbBooks:…}} tokens.
 * Must run before interpolate() — interpolate's {{…}} regex would otherwise blank them.
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
