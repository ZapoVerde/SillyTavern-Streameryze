/**
 * @file st-extensions/SillyTavern-Triggeryze/actions/condition.js
 * @stamp {"utc":"2026-06-15T00:00:00.000Z"}
 * @architectural-role Shared utility — condition evaluation and ST variable resolution
 * @description
 * Extracted from template.js so that both template.js and triggers.js can evaluate
 * conditions and resolve ST variable references without creating a circular import.
 *
 * @api-declaration
 * parseVarRef(ref)              — splits "stats.hp" or "stats[hp]" into { name, index }
 * resolveStVar(ref, getter)     — resolves an ST variable ref to a string value
 * evalCondition(cond, lookup)   — evaluates a boolean condition expression
 * makeLookup(snapshot)          — builds a lookup fn from a turn-var snapshot (handles chatvar:: / globalvar::)
 *
 * @contract
 *   assertions:
 *     purity:          parseVarRef is pure; resolveStVar / makeLookup read ST variable stores
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

const _VNAME = '(?:\\{\\{[^{}]+\\}\\}|(?:chatvar|globalvar)::[a-zA-Z0-9_.\\-\\[\\]]+|[a-zA-Z0-9_-]+)';

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

export function evalCondition(cond, lookup) {
    let e = cond;
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
    try { return _boolAlgebra(e); } catch { return false; }
}
