/**
 * @file st-extensions/SillyTavern-Triggeryze/actions/template.js
 * @stamp {"utc":"2026-06-15T00:00:00.000Z"}
 * @architectural-role IO — template interpolation and lorebook token pre-resolution
 * @description
 * Interpolates {{variable}} tokens and {{if}} blocks in action template strings.
 * Resolves {{getLBcontent ...}} tokens against active lorebooks before interpolation.
 * Used by action execute() methods and by the engine to classify template dependencies.
 *
 * @api-declaration
 * interpolate(template, vars, ruleVars)                    — resolves {{...}} tokens in a template string
 * getTemplateTier(strings)                                 — returns earliest valid execution tier for template fields
 * resolveLbTokens(template, keyword, highlighted, vars)    — pre-resolves getLBcontent tokens (async)
 *
 * @contract
 *   assertions:
 *     purity:          interpolate and getTemplateTier are pure; resolveLbTokens reads lorebooks
 *     state_ownership: none
 *     external_io:     resolveLbTokens calls getLbEntryByName (lorebook read)
 */

import { getLbEntryByName, resolveLbQueryTokens, getTurnVarsSnapshot } from '../triggers.js';
import { getLocalVariable, getGlobalVariable }                         from '../../../../../scripts/variables.js';

// ---------------------------------------------------------------------------
// ST variable reference helpers — index access via .key or [key]
// ---------------------------------------------------------------------------

function _parseVarRef(ref) {
    const t  = ref.trim();
    const bm = t.match(/^([^\[.]+)\[([^\]]+)\]$/);
    if (bm) return { name: bm[1].trim(), index: bm[2].trim() };
    const dm = t.match(/^([^.]+)\.(.+)$/);
    if (dm) return { name: dm[1].trim(), index: dm[2].trim() };
    return { name: t, index: undefined };
}

function _resolveStVar(ref, getter) {
    const { name, index } = _parseVarRef(ref);
    const val = getter(name, index !== undefined ? { index } : {});
    return val === null || val === undefined ? '' : String(val);
}

// ---------------------------------------------------------------------------
// Math evaluator — safe arithmetic expressions only
// ---------------------------------------------------------------------------

function _evalMath(expr) {
    const cleaned = expr.trim();
    if (!cleaned) return '';
    if (!/^[0-9\s+\-*/%().eE]+$/.test(cleaned)) return '';
    try {
        // eslint-disable-next-line no-new-func
        const result = Function('"use strict"; return (' + cleaned + ')')();
        if (typeof result !== 'number' || !isFinite(result)) return '';
        return Number.isInteger(result) ? String(result) : String(parseFloat(result.toFixed(6)));
    } catch { return ''; }
}

// ---------------------------------------------------------------------------
// Template condition evaluator — used by {{if}} blocks
// Ported and extended from Personalyze/logic/computationalParser.js
// ---------------------------------------------------------------------------

// Matches plain var names AND chatvar::/globalvar:: references with optional .key or [key]
const _VNAME = '(?:(?:chatvar|globalvar)::[a-zA-Z0-9_.\\[\\]]+|[a-zA-Z0-9_-]+)';

function _evalAtomicCond(varName, op, rhs, lookup) {
    const raw  = lookup(varName);
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
        case '>':        return Number(val) >  Number(r);
        case '<':        return Number(val) <  Number(r);
        case '>=':       return Number(val) >= Number(r);
        case '<=':       return Number(val) <= Number(r);
        default:         return false;
    }
}

// Reduces a string of true/false/AND/OR/!/() tokens to a boolean.
// Operator precedence: ! > AND > OR. Parentheses override.
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

function _evalCondition(cond, lookup) {
    let e = cond;
    e = e.replace(new RegExp(`(${_VNAME})\\s+empty\\b`, 'gi'),
        (_, v) => _evalAtomicCond(v, 'empty', null, lookup) ? 'true' : 'false');
    e = e.replace(new RegExp(`(${_VNAME})\\s+in\\s+\\(([^)]+)\\)`, 'gi'),
        (_, v, list) => _evalAtomicCond(v, 'in', list, lookup) ? 'true' : 'false');
    e = e.replace(new RegExp(`(${_VNAME})\\s+(matches|contains|is)\\s+"([^"]*)"`, 'gi'),
        (_, v, op, rhs) => _evalAtomicCond(v, op, rhs, lookup) ? 'true' : 'false');
    e = e.replace(new RegExp(`(${_VNAME})\\s+(>=|<=|>|<)\\s+(-?[\\d.]+)`, 'g'),
        (_, v, op, rhs) => _evalAtomicCond(v, op, rhs, lookup) ? 'true' : 'false');
    try { return _boolAlgebra(e); } catch { return false; }
}

// ruleVars holds values produced by prior actions in the same rule execution.
// System vars (second argument) always take precedence over rule-produced vars.
export function interpolate(template, vars, ruleVars = {}) {
    const lookup = (name) => {
        if (name.startsWith('chatvar::'))   return _resolveStVar(name.slice(9),  getLocalVariable);
        if (name.startsWith('globalvar::')) return _resolveStVar(name.slice(12), getGlobalVariable);
        return vars[name] ?? ruleVars[name] ?? '';
    };

    // {{if condition}}body{{/if}} — condition lookup handles chatvar:: / globalvar:: and numeric ops
    let out = template.replace(
        /\{\{if\s+([\s\S]*?)\}\}([\s\S]*?)\{\{\/if\}\}/g,
        (_, cond, body) => _evalCondition(cond, lookup) ? body : '',
    );

    // {{chatvar::name}} / {{chatvar::stats.hp}} / {{chatvar::stats[0]}}
    out = out.replace(/\{\{chatvar::([^{}]+)\}\}/g,   (_, n) => _resolveStVar(n, getLocalVariable));
    out = out.replace(/\{\{globalvar::([^{}]+)\}\}/g, (_, n) => _resolveStVar(n, getGlobalVariable));

    // {{varName}} — defer {{math:...}} for evaluation after all substitution
    out = out.replace(/\{\{([^{}]+)\}\}/g, (_, key) => {
        const k = key.trim();
        if (k.startsWith('math:')) return `{{${key}}}`;
        return lookup(k);
    });

    // {{math: expr }} — safe arithmetic, runs after all variable substitution
    return out.replace(/\{\{math:\s*([\s\S]*?)\}\}/g, (_, expr) => _evalMath(expr));
}

/**
 * Returns the earliest valid execution tier for an action's template fields.
 * 'message'   — needs the full committed message ({{message}} present)
 * 'paragraph' — needs the paragraph boundary to have closed ({{paragraph}} present)
 * 'immediate' — all dependencies are available the moment the trigger keyword matches
 */
export function getTemplateTier(strings) {
    const combined = (strings ?? []).filter(Boolean).join(' ');
    if (/\{\{message\}\}/i.test(combined))   return 'message';
    if (/\{\{paragraph\}\}/i.test(combined)) return 'paragraph';
    return 'immediate';
}

/**
 * Pre-resolves {{getLBcontent [LBname:]entryname}} tokens in a template string.
 * Must be called before interpolate() — interpolate's {{...}} regex would otherwise
 * consume these tokens and blank them (no matching variable).
 *
 * entryname forms:
 *   keyword          — uses the trigger's matched keyword
 *   [Elara Voss]     — literal entry name (brackets allow spaces/disambiguation)
 *   Elara Voss       — literal entry name (bare text)
 *
 * Optional LBname: prefix scopes the search to a specific lorebook.
 * Without it, all active lorebooks are searched.
 *
 * On miss: logs to console.error, token collapses to empty string.
 *
 * Return format (Structurize-style, no XML tags):
 *   Elara Voss:
 *   (elara, voss)
 *   Senior archivist of the Conclave...
 */
export async function resolveLbTokens(template, matchedKeyword, highlighted = '', vars = {}) {
    if (!template) return template;
    // Resolve unified lb query tokens first, then the legacy getLBcontent token.
    if (template.includes('{{lb'))
        template = await resolveLbQueryTokens(template, { ...getTurnVarsSnapshot(), ...vars });
    if (!template.includes('{{getLBcontent')) return template;
    const RE = /\{\{getLBcontent\s+(?:([^:{}]+):)?(.+?)\}\}/g;
    const tokens = [...template.matchAll(RE)];
    if (!tokens.length) return template;

    let result = template;
    for (const m of tokens) {
        const lbName    = m[1]?.trim() || null;
        const rawName   = m[2].trim();
        const literal   = rawName.startsWith('[') && rawName.endsWith(']') ? rawName.slice(1, -1).trim() : rawName;
        const entryName = rawName === 'keyword'     ? matchedKeyword
                        : rawName === 'highlighted' ? highlighted
                        : (vars?.[literal] ?? literal);

        const entry = await getLbEntryByName(entryName, lbName);
        let replacement;
        if (!entry) {
            console.error(`[triggeryze] getLBcontent: no entry found for "${entryName}"${lbName ? ` in lorebook "${lbName}"` : ' in active lorebooks'}`);
            replacement = '';
        } else {
            const keys = Array.isArray(entry.key) && entry.key.length ? `(${entry.key.join(', ')})` : '';
            replacement = keys
                ? `${entry.comment}:\n${keys}\n${entry.content}`
                : `${entry.comment}:\n${entry.content}`;
        }
        result = result.replace(m[0], () => replacement);
    }
    return result;
}
