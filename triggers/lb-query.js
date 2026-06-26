/**
 * @file triggers/lb-query.js
 * @stamp {"utc":"2026-06-26T00:00:00.000Z"}
 * @architectural-role IO — lorebook read access: entry queries, keyword cache, token resolution
 * @description
 * Provides read-only access to ST's lorebook data for use by trigger and action registry entries.
 * Owns the per-generation caches for active entries, all-disk entries, and WI keyword lists.
 * Does not write to lorebooks; that belongs to lorebook action entries.
 *
 * @api-declaration
 * clearWiCache()                              — resets all per-generation caches; call on GENERATION_STARTED
 * getWiKeywords()                             → Promise<{raw, regex}[]>  active WI keywords
 * getWiKeywordsFiltered(opts)               → Promise<{raw, regex}[]>  filtered keys; scope 'active'|'all'|'inactive'
 * matchWiKw(text, {raw, regex})               → boolean
 * getLbEntryByName(entryName, lbName?)        → Promise<entry|null>
 * getLbNames()                                → string[]  sorted list of all lorebook names on disk
 * resolveLbQueryTokens(template, vars?)       → Promise<string>  expands {{lbTitles:…}}, {{lbKeys:…}}, {{lbContent:…}}, {{lbBooks:…}}
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

import {
    parseArg,
    resolveArg,
    resolveScalar,
    globTest,
    filterMatchesSingle,
    filterMatchesArray,
} from '../arg-parser.js';

// ---------------------------------------------------------------------------
// Per-generation caches — cleared on GENERATION_STARTED via clearWiCache()
// ---------------------------------------------------------------------------

let _wiCache          = null;   // [{raw, regex}] — active WI keywords
let _entryCache       = null;   // active, non-disabled lorebook entries
let _entryPromise     = null;   // in-flight dedup for getActiveEntries
let _allEntryCache    = null;   // all-disk entries (scope:'all')
let _allEntryPromise  = null;   // in-flight dedup for _getAllEntries

export function clearWiCache() {
    _wiCache          = null;
    _entryCache       = null;
    _entryPromise     = null;
    _allEntryCache    = null;
    _allEntryPromise  = null;
}

export function getLbNames() {
    return Array.isArray(world_names) ? [...world_names].sort() : [];
}

// ---------------------------------------------------------------------------
// Entry fetching
// ---------------------------------------------------------------------------

async function getActiveEntries() {
    if (_entryCache) return _entryCache;
    if (!_entryPromise) {
        _entryPromise = getSortedEntries().then(entries => {
            _entryCache   = entries.filter(e => !e.disable);
            _entryPromise = null;
            return _entryCache;
        });
    }
    return _entryPromise;
}

async function _getAllEntries() {
    if (_allEntryCache) return _allEntryCache;
    if (!_allEntryPromise) {
        const names = Array.isArray(world_names) ? world_names : [];
        _allEntryPromise = Promise.all(
            names.map(async name => {
                const data = await loadWorldInfo(name);
                if (!data?.entries) return [];
                return Object.values(data.entries)
                    .map(e => ({ ...e, world: name }))
                    .filter(e => !e.disable);
            }),
        ).then(buckets => {
            _allEntryCache   = buckets.flat();
            _allEntryPromise = null;
            return _allEntryCache;
        });
    }
    return _allEntryPromise;
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
// Lorebook keyword filter (used by the lorebook keyword trigger)
// ---------------------------------------------------------------------------

function _parseFilterStr(str) {
    const parts = (str ?? '').split(',').map(s => s.trim()).filter(Boolean);
    return {
        includes: parts.filter(p => !p.startsWith('!')),
        excludes: parts.filter(p => p.startsWith('!')).map(p => p.slice(1).trim()).filter(Boolean),
    };
}

function _matchExcludeInclude(value, { includes, excludes }) {
    if (excludes.length && excludes.some(p => globTest(p, value))) return false;
    if (includes.length && !includes.some(p => globTest(p, value))) return false;
    return true;
}

function _matchKeyArrayFilter(keys, { includes, excludes }) {
    if (!includes.length && !excludes.length) return true;
    if (excludes.length && keys.some(k => excludes.some(p => globTest(p, k)))) return false;
    if (includes.length && !keys.some(k => includes.some(p => globTest(p, k)))) return false;
    return true;
}

/**
 * Returns {raw, regex}[] of primary keys from entries that pass all three filter axes.
 * Each filter is comma-separated; prefix ! to exclude; * and ? are glob wildcards.
 * Empty filter = wildcard (all pass). Disabled entries are always excluded.
 * scope mirrors the lb-query scope system: 'active' (default) | 'all' | 'inactive'.
 */
export async function getWiKeywordsFiltered({ lbBook = '', lbEntry = '', lbTag = '', lbKey = '', scope = 'active' } = {}) {
    const bookF  = _parseFilterStr(lbBook);
    const entryF = _parseFilterStr(lbEntry);
    const tagF   = _parseFilterStr(lbTag);
    const keyF   = _parseFilterStr(lbKey);

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

    return pool
        .filter(e => {
            if (!Array.isArray(e.key) || !e.key.length) return false;
            if (!_matchExcludeInclude(e.world   ?? '', bookF))              return false;
            if (!_matchExcludeInclude(e.comment ?? '', entryF))             return false;
            if (!_matchExcludeInclude(e.group   ?? '', tagF))               return false;
            if (!_matchKeyArrayFilter(Array.isArray(e.key) ? e.key : [], keyF)) return false;
            return true;
        })
        .flatMap(e => e.key.filter(Boolean).map(k => ({ raw: k, regex: parseRegexFromString(k) })));
}

// ---------------------------------------------------------------------------
// Entry lookup by title
// ---------------------------------------------------------------------------

/**
 * Finds a lorebook entry whose comment (title) matches entryName.
 * When lbName is provided, loads that lorebook directly from disk so inactive
 * lorebooks are reachable. When lbName is omitted, searches active entries only.
 * Returns the entry object, or null if no match is found.
 */
export async function getLbEntryByName(entryName, lbName = null) {
    const needle = entryName.toLowerCase();

    if (lbName) {
        const data = await loadWorldInfo(lbName);
        if (!data?.entries) return null;
        for (const e of Object.values(data.entries)) {
            if (e.disable) continue;
            if (!e.comment) continue;
            if (e.comment.toLowerCase() === needle) return e;
        }
        return null;
    }

    const entries = await getSortedEntries();
    for (const e of entries) {
        if (e.disable) continue;
        if (!e.comment) continue;
        if (e.comment.toLowerCase() === needle) return e;
    }
    return null;
}

// ---------------------------------------------------------------------------
// LB query system
// Resolves {{lbTitles:…}}, {{lbKeys:…}}, {{lbContent:…}}, {{lbBooks:…}} tokens.
// Full positional syntax:
//   :[lb filter]:[title filter]:[key filter]:[mode]:[scope]
//
// Filter arg forms (positions 1–3):
//   ''                     → wildcard (matches everything)
//   Dragon                 → literal value; glob * and ? supported
//   Dragon, Magic          → OR list (implicit): matches either
//   "Dragon, beast"        → quoted literal: comma is part of the value, not a separator
//   !Dragon                → exclusion: matches anything except Dragon
//   !Dragon, Magic         → Magic, unless Dragon — exclusion vetoes before inclusions
//   {{myVar}}              → turn variable; value is comma-split into OR items
//   !{{myVar}}             → turn variable items are all treated as exclusions
//   OR(Dragon, Magic)      → explicit OR — same as comma-separated
//   AND(sword, magic)      → AND: entry must satisfy all items (most useful in key position)
//   AND(sword, !fire)      → AND with exclusion: must have sword key, must not have fire key
//
// Scalar arg forms (positions 4–5, mode and scope):
//   ''           → use default
//   first        → literal value
//   {{myVar}}    → turn variable
//
// mode  — first | last | all | rnd  (default: all for titles/keys/books, first for content)
// scope — active | inactive | all   (default: active)
//
// SCOPE values:
//   active   (default) — entries from ST's four active lorebook sources
//   all      — every lorebook file on disk
//   inactive — disk lorebooks NOT in any active slot
//
// The lbKeyword trigger always uses active scope (it has no slot for a scope argument).
// ---------------------------------------------------------------------------

async function _queryEntries(lbFilter, titleFilter, keyFilter, vars, scope = 'active') {
    const lb    = resolveArg(lbFilter, vars);
    const title = resolveArg(titleFilter, vars);
    const key   = resolveArg(keyFilter, vars);

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
        if (!filterMatchesSingle(lb,    e.world   ?? '')) return false;
        if (!filterMatchesSingle(title, e.comment ?? '')) return false;
        if (!filterMatchesArray(key, Array.isArray(e.key) ? e.key : [])) return false;
        return true;
    });
}

/**
 * Pre-resolves {{lbTitles:…}}, {{lbKeys:…}}, {{lbContent:…}}, {{lbBooks:…}} tokens.
 * Must run before interpolate() — interpolate's {{…}} regex would otherwise blank them.
 * vars should be the current turn-var snapshot (getTurnVarsSnapshot()).
 *
 * Syntax: {{lbKeys:lb:title:key:mode:scope}}
 * Each arg is bare text (literal), {{varName}} (turn variable), or AND(…)/OR(…).
 * scope defaults to 'active'. Pass 'all' or 'inactive' to reach off-WI lorebooks.
 * See the LB query system comment block above for full arg and scope semantics.
 */
export async function resolveLbQueryTokens(template, vars = {}) {
    if (!template) return template;
    if (!template.includes('{{lb')) return template;

    // Each arg slot may contain {{varName}} tokens, so we match those explicitly
    // rather than relying on [^}]* which would stop at the first } inside a var ref.
    const RE = /\{\{(lbTitles|lbKeys|lbContent|lbBooks)((?::(?:\{\{[^}]*\}\}|[^}])*)*)\}\}/g;
    const tokens = [...template.matchAll(RE)];
    if (!tokens.length) return template;

    const resolved = await Promise.all(tokens.map(async m => {
        const type   = m[1];
        const parts  = m[2] ? m[2].slice(1).split(':') : [];

        const lbArg    = parseArg(parts[0]);
        const titleArg = parseArg(parts[1]);
        const keyArg   = parseArg(parts[2]);
        const mode     = resolveScalar(parts[3], vars);
        const scope    = resolveScalar(parts[4], vars) ?? 'active';

        const entries = await _queryEntries(lbArg, titleArg, keyArg, vars, scope);
        let replacement = '';

        if (type === 'lbTitles') {
            const titles = entries.map(e => e.comment).filter(Boolean);
            const m2 = mode ?? 'all';
            replacement = m2 === 'first' ? (titles[0] ?? '')
                        : m2 === 'last'  ? (titles[titles.length - 1] ?? '')
                        : m2 === 'rnd'   ? (titles[Math.floor(Math.random() * titles.length)] ?? '')
                        : titles.join(', ');
        } else if (type === 'lbKeys') {
            const keys = [...new Set(entries.flatMap(e => Array.isArray(e.key) ? e.key : []).filter(Boolean))];
            const m2 = mode ?? 'all';
            replacement = m2 === 'first' ? (keys[0] ?? '')
                        : m2 === 'last'  ? (keys[keys.length - 1] ?? '')
                        : m2 === 'rnd'   ? (keys[Math.floor(Math.random() * keys.length)] ?? '')
                        : keys.join(', ');
        } else if (type === 'lbBooks') {
            const books = [...new Set(entries.map(e => e.world).filter(Boolean))];
            const m2 = mode ?? 'all';
            replacement = m2 === 'first' ? (books[0] ?? '')
                        : m2 === 'last'  ? (books[books.length - 1] ?? '')
                        : m2 === 'rnd'   ? (books[Math.floor(Math.random() * books.length)] ?? '')
                        : books.join(', ');
        } else {
            const m2 = mode ?? 'first';
            if (m2 === 'first')      replacement = entries[0]?.content ?? '';
            else if (m2 === 'last')  replacement = entries[entries.length - 1]?.content ?? '';
            else if (m2 === 'rnd')   replacement = entries[Math.floor(Math.random() * entries.length)]?.content ?? '';
            else                     replacement = entries.map(e => e.content).filter(Boolean).join('\n\n');
        }

        return { raw: m[0], replacement };
    }));

    let result = template;
    for (const { raw, replacement } of resolved) {
        result = result.replace(raw, () => replacement);
    }
    return result;
}
