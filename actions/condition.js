/**
 * @file st-extensions/SillyTavern-Triggeryze/actions/condition.js
 * @stamp {"utc":"2026-07-01T00:00:00.000Z"}
 * @architectural-role Shared utility — condition evaluation and ST variable resolution
 * @description
 * Extracted from template.js so that both template.js and triggers.js can evaluate
 * conditions and resolve ST variable references without creating a circular import.
 * `=` / `!=` accept a quoted literal OR an explicit variable reference ({{varName}},
 * chatvar::name, globalvar::name) on the right-hand side, so two dynamic values can be
 * compared directly (e.g. `chatvar::loc != {{loc}}`) without one side being hardcoded.
 *
 * @api-declaration
 * parseVarRef(ref)                    — splits "stats.hp" or "stats[hp]" into { name, index }
 * resolveStVar(ref, getter)           — resolves an ST variable ref to a string value
 * evalCondition(cond, lookup)         — evaluates a boolean condition expression
 * makeLookup(snapshot)                — builds a lookup fn from a turn-var snapshot (handles chatvar:: / globalvar::)
 * findUnresolvedConditionText(cond)   — static check: runs the same substitution passes as
 *                                       evalCondition with a no-op lookup and returns whatever
 *                                       text survived them (a clause no operator pattern matched),
 *                                       or null if the expression fully resolved to boolean algebra
 * extractConditionVarNames(cond)      — static check: bare/{{varName}} references in an expression
 *                                       (excludes chatvar::/globalvar::, boolean/operator keywords,
 *                                       and numeric literals) — used to detect refs to a turn
 *                                       variable no action ever produces
 *
 * @contract
 *   assertions:
 *     purity:          parseVarRef, findUnresolvedConditionText, extractConditionVarNames are pure;
 *                      resolveStVar / makeLookup read ST variable stores
 *     state_ownership: none
 *     external_io:     getLocalVariable / getGlobalVariable (ST API, read-only)
 */

import { getLocalVariable, getGlobalVariable } from '../../../../../scripts/variables.js';
import { jaroWinkler }                         from '../triggers/kw-match.js';

// ---------------------------------------------------------------------------
// ST variable reference helpers — index access via .key or [key]
// ---------------------------------------------------------------------------

export function parseVarRef(ref) {
    const t  = ref.trim();
    const bm = t.match(/^([^\[.]+)\[([^\]]+)\]$/);
    if (bm) return { name: bm[1].trim(), index: bm[2].trim() };
    const dm = t.match(/^([^.]+)\.(.+)$/);
    if (dm) return { name: dm[1].trim(), index: dm[2].trim() };
    return { name: t, index: undefined };
}

export function resolveStVar(ref, getter) {
    const { name, index } = parseVarRef(ref);
    const val = getter(name, index !== undefined ? { index } : {});
    return val === null || val === undefined ? '' : String(val);
}

export function makeLookup(snapshot) {
    return (name) => {
        if (name.startsWith('chatvar::'))   return resolveStVar(name.slice(9),  getLocalVariable);
        if (name.startsWith('globalvar::')) return resolveStVar(name.slice(12), getGlobalVariable);
        return snapshot[name] ?? '';
    };
}

// ---------------------------------------------------------------------------
// Condition evaluator
// Matches plain var names AND chatvar::/globalvar:: refs with optional .key or [key]
// ---------------------------------------------------------------------------

const _VNAME = '(?:\\{\\{[^{}]+\\}\\}|(?:chatvar|globalvar)::[a-zA-Z0-9_.\\-\\[\\]]+|[a-zA-Z0-9$_-]+)';

// Explicit-reference-only forms for the right-hand side of = / != — deliberately excludes
// the bare-identifier branch of _VNAME so it can never be confused with AND/OR/true/false
// keywords or a bare literal. A variable-vs-variable comparison must spell out {{varName}},
// chatvar::name, or globalvar::name on both sides.
const _VREF  = '(?:\\{\\{[^{}]+\\}\\}|(?:chatvar|globalvar)::[a-zA-Z0-9_.\\-\\[\\]]+)';

function _evalAtomicCond(varName, op, rhs, lookup) {
    const name = varName.startsWith('{{') ? varName.slice(2, -2).trim() : varName;
    const raw  = lookup(name);
    const val  = String(raw ?? '').trim();
    const valL = val.toLowerCase();
    const r    = (rhs ?? '').trim();
    const esc  = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    switch (op.toLowerCase()) {
        case 'matches':  { try { return new RegExp(r, 'i').test(val); } catch { return false; } }
        case 'contains': return valL.includes(r.toLowerCase());
        case 'is':       return new RegExp(`^\\b${esc(r.toLowerCase())}\\b$`, 'i').test(valL);
        case 'in': {
            const items = r.replace(/^\(|\)$/g, '').split(',').map(s => s.trim()).filter(Boolean);
            return items.some(item => new RegExp(`^\\b${esc(item)}\\b$`, 'i').test(valL));
        }
        case 'empty':    return !raw || valL === '' || valL === 'none' || valL === 'unspecified';
        case '=':        return valL === r.toLowerCase();
        case '!=':       return valL !== r.toLowerCase();
        case '>':        return Number(val) >  Number(r);
        case '<':        return Number(val) <  Number(r);
        case '>=':       return Number(val) >= Number(r);
        case '<=':       return Number(val) <= Number(r);
        default:         return false;
    }
}

function _boolAlgebra(str) {
    str = str.trim();
    while (str.includes('(')) {
        const prev = str;
        str = str.replace(/\(([^()]+)\)/g, (_, g) => _boolAlgebra(g) ? 'true' : 'false');
        if (str === prev) break;
    }
    while (/!\s*(true|false)\b/i.test(str))
        str = str.replace(/!\s*true\b/gi, 'false').replace(/!\s*false\b/gi, 'true');
    while (/\b(true|false)\s+AND\s+(true|false)\b/i.test(str))
        str = str.replace(/\b(true|false)\s+AND\s+(true|false)\b/gi,
            (_, l, r) => l.toLowerCase() === 'true' && r.toLowerCase() === 'true' ? 'true' : 'false');
    while (/\b(true|false)\s+OR\s+(true|false)\b/i.test(str))
        str = str.replace(/\b(true|false)\s+OR\s+(true|false)\b/gi,
            (_, l, r) => l.toLowerCase() === 'true' || r.toLowerCase() === 'true' ? 'true' : 'false');
    return str.toLowerCase().trim() === 'true';
}

// Runs every operator's substitution pass over the expression, replacing each recognized
// clause with the literal string 'true' or 'false'. Whatever text survives all passes is
// either boolean algebra (true/false/AND/OR/!/parens) or a clause no pattern matched —
// evalCondition collapses the former; findUnresolvedConditionText below flags the latter.
function _substitute(cond, lookup) {
    let e = cond;
    e = e.replace(new RegExp(`(${_VNAME})\\s+not-empty\\b`, 'gi'),
        (_, v) => _evalAtomicCond(v, 'empty', null, lookup) ? 'false' : 'true');
    e = e.replace(new RegExp(`(${_VNAME})\\s+(?:is\\s+)?empty\\b`, 'gi'),
        (_, v) => _evalAtomicCond(v, 'empty', null, lookup) ? 'true' : 'false');
    e = e.replace(new RegExp(`(${_VNAME})\\s+in\\s+\\(([^)]+)\\)`, 'gi'),
        (_, v, list) => _evalAtomicCond(v, 'in', list, lookup) ? 'true' : 'false');
    // fuzzy "target" [threshold] — threshold optional, defaults to 80
    e = e.replace(new RegExp(`(${_VNAME})\\s+fuzzy\\s+"([^"]*)"(?:\\s+(\\d+))?`, 'gi'),
        (_, v, target, thresh) => {
            const name   = v.startsWith('{{') ? v.slice(2, -2).trim() : v;
            const val    = String(lookup(name) ?? '').trim().toLowerCase();
            const rawNum = parseFloat(thresh ?? '80');
            const t      = Number.isFinite(rawNum) ? rawNum / 100 : 0.80;
            return jaroWinkler(val, target.toLowerCase()) >= t ? 'true' : 'false';
        });
    e = e.replace(new RegExp(`(${_VNAME})\\s+(matches|contains|is)\\s+"([^"]*)"`, 'gi'),
        (_, v, op, rhs) => _evalAtomicCond(v, op, rhs, lookup) ? 'true' : 'false');
    e = e.replace(new RegExp(`(${_VNAME})\\s+(>=|<=|>|<)\\s+(-?[\\d.]+)`, 'g'),
        (_, v, op, rhs) => _evalAtomicCond(v, op, rhs, lookup) ? 'true' : 'false');
    e = e.replace(new RegExp(`(${_VNAME})\\s+(!=|=)\\s+"([^"]*)"`, 'gi'),
        (_, v, op, rhs) => _evalAtomicCond(v, op, rhs, lookup) ? 'true' : 'false');
    // Variable-vs-variable: chatvar::X != {{Y}}, {{X}} = globalvar::Y, etc. Runs after the
    // quoted-literal pass above so `X != "literal"` is never mistaken for a reference.
    e = e.replace(new RegExp(`(${_VNAME})\\s+(!=|=)\\s+(${_VREF})`, 'gi'),
        (_, v, op, rhsRef) => {
            const rhsName = rhsRef.startsWith('{{') ? rhsRef.slice(2, -2).trim() : rhsRef;
            return _evalAtomicCond(v, op, lookup(rhsName), lookup) ? 'true' : 'false';
        });
    return e;
}

export function evalCondition(cond, lookup) {
    try { return _boolAlgebra(_substitute(cond, lookup)); } catch { return false; }
}

// A dummy lookup for static analysis — the boolean OUTCOME of a comparison never matters here,
// only whether the operator syntax was recognized at all, so any fixed return value works.
const _dummyLookup = () => '';

/**
 * Static check: returns the text that no operator pattern consumed, or null if the whole
 * expression fully reduced to boolean algebra (true/false/AND/OR/!/parens/whitespace).
 * A non-null result means some clause is guaranteed to never evaluate — e.g. `x != y` where
 * `y` isn't quoted and isn't an explicit {{...}}/chatvar::/globalvar:: reference, which
 * always leaves `x != y` untouched and evalCondition always resolves to false, no matter
 * what `x` or a variable actually named `y` would contain at runtime.
 */
export function findUnresolvedConditionText(cond) {
    if (!cond?.trim()) return null;
    const residue = _substitute(cond, _dummyLookup)
        // !(?!=) so the negation operator's "!" is stripped but "!=" survives intact for
        // an unresolved clause to still read naturally (e.g. "chatvar::loc != loc").
        .replace(/\btrue\b|\bfalse\b|\bAND\b|\bOR\b|!(?!=)|[()]/gi, '')
        .trim();
    return residue ? residue : null;
}

const _RESERVED_WORDS = new Set([
    'and', 'or', 'true', 'false', 'matches', 'contains', 'is', 'in', 'empty', 'fuzzy', 'not-empty',
]);

/**
 * Static check: extracts candidate turn-variable names referenced in a condition expression —
 * bare identifiers and {{varName}} forms, excluding chatvar::/globalvar:: (ST variables, not
 * TRG turn vars — not tracked by any outputVar), boolean/operator keywords, and pure numbers.
 * Used to flag a reference to a variable no action in scope ever writes.
 */
export function extractConditionVarNames(cond) {
    if (!cond?.trim()) return [];
    const names = new Set();
    // Blank out quoted literals first — "on"/"happy"/etc. are values, not variable names,
    // and the bare-identifier branch of _VNAME can't otherwise tell them apart.
    const unquoted = cond.replace(/"[^"]*"/g, ' ');
    for (const m of unquoted.matchAll(new RegExp(_VNAME, 'g'))) {
        let tok = m[0];
        if (tok.startsWith('{{')) tok = tok.slice(2, -2).trim();
        if (tok.startsWith('chatvar::') || tok.startsWith('globalvar::')) continue;
        if (_RESERVED_WORDS.has(tok.toLowerCase())) continue;
        if (/^-?[\d.]+$/.test(tok)) continue;
        names.add(tok);
    }
    return [...names];
}
