/**
 * @file st-extensions/SillyTavern-Triggeryze/actions/template.js
 * @stamp {"utc":"2026-06-16T14:00:00.000Z"}
 * @architectural-role IO — template interpolation and prompt-slot/lorebook/history token pre-resolution
 * @description
 * Interpolates {{variable}} tokens and {{if}} blocks in action template strings.
 * Pre-resolves {{lb...}}, {{ps...}}, and {{history:N}} tokens before interpolation.
 * {{psName}} and {{psContent}} surface the context stack (rawPrompt) from the current generation.
 * String transform tokens ({{trim:}}, {{upper:}}, {{lower:}}, {{lines:}}, {{words:}}, {{default:}})
 * are resolved as the final pass after math evaluation; see transforms.js for the full set.
 * Used by action execute() methods and by the engine to classify template dependencies.
 *
 * @api-declaration
 * interpolate(template, vars, ruleVars)                                    — resolves {{...}} tokens in a template string
 * getTemplateTier(strings)                                                  — returns earliest valid execution tier for template fields
 * resolveLbTokens(template, vars, msgId)                                    — pre-resolves {{lb...}} and {{ps...}} tokens (async)
 * resolveHistoryTokens(template, chat, beforeIndex, vars)                  — replaces {{history:[N]}} / {{history:varName}} with chat transcript
 *
 * @contract
 *   assertions:
 *     purity:          interpolate and getTemplateTier are pure; resolveLbTokens and resolveHistoryTokens have IO
 *     state_ownership: none
 *     external_io:     resolveLbTokens reads lorebooks (resolveLbQueryTokens), itemizedPrompts (prompt history), oai_settings (current preset)
 *                      resolveHistoryTokens reads the chat array
 */

import { resolveLbQueryTokens }                    from '../triggers/lb-query.js';
import { getTurnVarsSnapshot }                      from '../triggers/turn-vars.js';
import { getLocalVariable, getGlobalVariable }      from '../../../../../scripts/variables.js';
import { resolveStVar, evalCondition }              from './condition.js';
import { itemizedPrompts }                          from '../../../../../script.js';
import { oai_settings }                             from '../../../../../scripts/openai.js';
import { resolveTransforms, TRANSFORM_PREFIXES }    from './transforms.js';
import { buildHistoryText }                         from './text.js';

// Tokens that must survive the first {{varName}} pass and be evaluated later.
const _DEFERRED = new Set(['math:', ...TRANSFORM_PREFIXES]);

// ---------------------------------------------------------------------------
// Shared arg-parsing helpers (mirrors the pattern in triggers.js)
// ---------------------------------------------------------------------------

// '' or missing → null (wildcard); '[a,b]' → ['a','b']; 'name' → 'name' (var ref)
function _parseArg(arg) {
    const t = (arg ?? '').trim();
    if (!t) return null;
    if (t.startsWith('[') && t.endsWith(']'))
        return t.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
    return t;
}

// null → null (wildcard); array → keep; string → expand turn var → comma-split
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

// null → matches everything; [] → matches nothing; array → glob-test any
function _filterMatches(items, str) {
    if (items === null) return true;
    if (!items.length)  return false;
    return items.some(p => _globTest(p, str));
}

// ---------------------------------------------------------------------------
// {{psName}} / {{psContent}} — prompt-slot tokens
//
// Syntax: {{psName:[nameFilter]:[mode]}}
//         {{psContent:[nameFilter]:[mode]}}
//
// nameFilter: empty = wildcard; [literal] = literal/glob; bare = turn var
// mode:  all | first | last  (psName default: all; psContent default: first)
//
// Content is sourced from itemizedPrompts[messageId].rawPrompt (what was actually
// sent to the LLM for this generation). Name lookup uses oai_settings.prompts
// to map internal identifiers to display names, always scoped to the current preset.
// ---------------------------------------------------------------------------

function resolvePsTokens(template, messageId, vars) {
    if (!template || !template.includes('{{ps')) return template;
    if (messageId === null || messageId === undefined) return template;

    const RE = /\{\{(psName|psContent)((?::[^}]*)*)\}\}/g;
    const tokens = [...template.matchAll(RE)];
    if (!tokens.length) return template;

    const entry     = itemizedPrompts.find(x => x.mesId === messageId);
    const rawPrompt = Array.isArray(entry?.rawPrompt) ? entry.rawPrompt : [];
    const defs      = oai_settings?.prompts ?? [];

    let result = template;
    for (const m of tokens) {
        const type    = m[1];
        const parts   = m[2] ? m[2].slice(1).split(':') : [];
        const nameArg = _parseArg(parts[0]);
        const mode    = (parts[1] ?? '').trim() || null;

        const nameFilter = _resolveArg(nameArg, vars);

        const matched = rawPrompt.filter(msg => {
            if (!msg.identifier) return false;
            if (_filterMatches(nameFilter, msg.identifier)) return true;
            const def = defs.find(p => p.identifier === msg.identifier);
            return def ? _filterMatches(nameFilter, def.name ?? '') : false;
        });

        let replacement = '';
        if (type === 'psName') {
            const names = matched.map(msg => {
                const def = defs.find(p => p.identifier === msg.identifier);
                return def?.name ?? msg.identifier;
            }).filter(Boolean);
            const m2 = mode ?? 'all';
            replacement = m2 === 'first' ? (names[0] ?? '')
                        : m2 === 'last'  ? (names[names.length - 1] ?? '')
                        : names.join('\n');
        } else {
            const contents = matched.map(msg => msg.content ?? '').filter(Boolean);
            const m2 = mode ?? 'first';
            replacement = m2 === 'first' ? (contents[0] ?? '')
                        : m2 === 'last'  ? (contents[contents.length - 1] ?? '')
                        : contents.join('\n\n');
        }

        result = result.replace(m[0], () => replacement);
    }
    return result;
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

// ruleVars holds values produced by prior actions in the same rule execution.
// System vars (second argument) always take precedence over rule-produced vars.
export function interpolate(template, vars, ruleVars = {}) {
    const lookup = (name) => {
        if (name.startsWith('chatvar::'))   return resolveStVar(name.slice(9),  getLocalVariable);
        if (name.startsWith('globalvar::')) return resolveStVar(name.slice(12), getGlobalVariable);
        return vars[name] ?? ruleVars[name] ?? '';
    };

    // {{if condition}}body{{/if}} — condition lookup handles chatvar:: / globalvar:: and numeric ops
    let out = template.replace(
        /\{\{if\s+([\s\S]*?)\}\}([\s\S]*?)\{\{\/if\}\}/g,
        (_, cond, body) => evalCondition(cond, lookup) ? body : '',
    );

    // {{chatvar::name}} / {{chatvar::stats.hp}} / {{chatvar::stats[0]}}
    out = out.replace(/\{\{chatvar::([^{}]+)\}\}/g,   (_, n) => resolveStVar(n, getLocalVariable));
    out = out.replace(/\{\{globalvar::([^{}]+)\}\}/g, (_, n) => resolveStVar(n, getGlobalVariable));

    // {{varName}} — defer {{math:...}} and transform tokens for evaluation after all substitution
    out = out.replace(/\{\{([^{}]+)\}\}/g, (_, key) => {
        const k = key.trim();
        if (_DEFERRED.has(k.split(':')[0] + ':')) return `{{${key}}}`;
        return lookup(k);
    });

    // {{math: expr }} — safe arithmetic, runs after all variable substitution
    out = out.replace(/\{\{math:\s*([\s\S]*?)\}\}/g, (_, expr) => _evalMath(expr));

    // {{trim:}}, {{upper:}}, {{lower:}}, {{lines:}}, {{words:}}, {{default:}}
    return resolveTransforms(out);
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
 * Replaces {{history:[N]}} (literal) and {{history:varName}} (turn variable) tokens
 * with a formatted chat transcript. Must be called before interpolate().
 *
 * Syntax:
 *   {{history:[2]}}     — literal 2 turns (bracket = literal, consistent with lb query args)
 *   {{history:turns}}   — turn variable "turns" holds the count
 *
 * If the argument is missing or resolves to a non-positive integer, the token collapses
 * to an empty string and a warning is logged.
 */
export function resolveHistoryTokens(template, chat, beforeIndex, vars) {
    if (!template || !template.includes('{{history:')) return template;
    return template.replace(/\{\{history:([^}]*)\}\}/g, (_, arg) => {
        const t = arg.trim();
        if (!t) {
            console.warn('[triggeryze] {{history:}} requires an argument — use {{history:[N]}} or {{history:varName}}');
            return '';
        }
        let n;
        if (t.startsWith('[') && t.endsWith(']')) {
            n = parseInt(t.slice(1, -1), 10);
        } else {
            n = parseInt(vars?.[t] ?? '', 10);
        }
        if (!Number.isFinite(n) || n <= 0) return '';
        return buildHistoryText(chat, beforeIndex, n);
    });
}

export async function resolveLbTokens(template, _matchedKeyword, _highlighted, vars = {}, messageId = null) {
    if (!template) return template;
    const mergedVars = { ...getTurnVarsSnapshot(), ...vars };
    if (template.includes('{{lb'))
        template = await resolveLbQueryTokens(template, mergedVars);
    if (template.includes('{{ps'))
        template = resolvePsTokens(template, messageId, mergedVars);
    return template;
}
