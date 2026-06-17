/**
 * @file st-extensions/SillyTavern-Triggeryze/actions/template.js
 * @stamp {"utc":"2026-06-17T00:00:00.000Z"}
 * @architectural-role IO — template interpolation and prompt-slot/lorebook/history token pre-resolution
 * @description
 * Interpolates {{variable}} tokens and {{if}} blocks in action template strings.
 * Pre-resolves {{lb...}}, {{ps...}}, {{psRows}}, {{psCharSum}}, {{mapLines}}, and {{history:N}} tokens before interpolation.
 * {{psName}} and {{psContent}} surface the context stack (rawPrompt) from the current generation.
 * {{psRows}} emits the context stack as tab-separated identifier\tcharCount lines for use with {{mapLines}}.
 * {{psCharSum}} sums the character counts of matching slots and emits a single integer (useful for aggregated rows).
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
import { resolveMapLines }                         from './map-lines.js';
import { getTurnVarsSnapshot }                      from '../triggers/turn-vars.js';
import { getLocalVariable, getGlobalVariable }      from '../../../../../scripts/variables.js';
import { resolveStVar, evalCondition }              from './condition.js';
import { trgWarn }                                 from '../logger.js';
import { oai_settings, promptManager }              from '../../../../../scripts/openai.js';
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

// null → matches everything; [] → matches nothing; array → glob-test any candidate string
// Patterns prefixed with ! are exclusions: [!chatHistory*] excludes all chatHistory-N slots.
// Exclusions are evaluated across ALL candidate strings as a group — if the identifier
// OR the display name matches an exclusion pattern, the row is excluded.
// If only exclusions are present, everything not excluded passes.
// Mixed: inclusions are applied first (id OR name), then exclusions veto.
function _filterMatches(items, ...strs) {
    if (items === null) return true;
    if (!items.length)  return false;
    const includes = items.filter(p => !p.startsWith('!'));
    const excludes = items.filter(p =>  p.startsWith('!')).map(p => p.slice(1));
    if (excludes.some(p => strs.some(s => _globTest(p, s)))) return false;
    if (!includes.length) return true;
    return includes.some(p => strs.some(s => _globTest(p, s)));
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

    const defs     = oai_settings?.prompts ?? [];
    const messages = promptManager?.messages?.flatten() ?? [];

    let result = template;
    for (const m of tokens) {
        const type    = m[1];
        const parts   = m[2] ? m[2].slice(1).split(':') : [];
        const nameArg = _parseArg(parts[0]);
        const mode    = (parts[1] ?? '').trim() || null;

        const nameFilter = _resolveArg(nameArg, vars);

        const matched = messages.filter(msg => {
            if (!msg.identifier) return false;
            const def = defs.find(p => p.identifier === msg.identifier);
            return _filterMatches(nameFilter, msg.identifier, def?.name ?? '');
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
            const contents = matched
                .map(msg => typeof msg.content === 'string' ? msg.content : '')
                .filter(Boolean);
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
// {{psRows}} — prompt-slot TSV data source
//
// Syntax: {{psRows:[nameFilter]}}
//
// Outputs matching prompt slots as tab-separated identifier\tcharCount lines, one per slot.
// nameFilter follows the same [literal]/glob/varRef convention as psName/psContent.
// Intended as a data source for {{mapLines}} blocks; resolves before mapLines runs.
// ---------------------------------------------------------------------------

function resolvePsRows(template, messageId, vars) {
    if (!template || !template.includes('{{psRows')) return template;
    if (messageId === null || messageId === undefined) return template;

    const RE       = /\{\{psRows((?::[^}]*)*)\}\}/g;
    const defs     = oai_settings?.prompts ?? [];
    const messages = promptManager?.messages?.flatten() ?? [];

    console.debug(`[TRG:psRows] mesId=${messageId} promptManager=${!!promptManager} messages=${messages.length} defs=${defs.length}`);

    if (!messages.length) return template.replace(RE, '');

    const allRows = messages
        .filter(msg => msg.identifier && typeof msg.content === 'string' && msg.content.length > 0)
        .map(msg => {
            const def         = defs.find(p => p.identifier === msg.identifier);
            const displayName = def?.name ?? msg.identifier;
            return [displayName, msg.content.length, msg.identifier];
        });

    console.debug(`[TRG:psRows] allRows=${allRows.length} sample:`, allRows.slice(0, 3).map(([n, c]) => `${n}\t${c}`));

    return template.replace(RE, (_, argStr) => {
        const parts      = argStr ? argStr.slice(1).split(':') : [];
        const nameArg    = _parseArg(parts[0]);
        const nameFilter = _resolveArg(nameArg, vars);

        const filtered = allRows
            .filter(([name, , id]) => _filterMatches(nameFilter, id, name));
        const output = filtered.map(([name, charCount]) => `${name}\t${charCount}`).join('\n');
        console.debug(`[TRG:psRows] filter="${nameFilter ?? '(none)'}" matched=${filtered.length} output=${JSON.stringify(output.slice(0, 80))}`);
        return output;
    });
}

// ---------------------------------------------------------------------------
// {{psMaxNameLen}} — longest display name length among matching prompt slots
//
// Syntax: {{psMaxNameLen:[nameFilter]}}
//
// Returns the character length of the longest display name among matching slots
// as a plain integer string. Use as a turn variable to drive {{pad:N:}} width
// dynamically so column bars align regardless of preset or chat length.
// Example: set name_pad = {{psMaxNameLen:[!chatHistory*]}}
//          then use     {{pad:{{name_pad}}:{{.1}}}} in the mapLines body
// ---------------------------------------------------------------------------

function resolvePsMaxNameLen(template, messageId, vars) {
    if (!template || !template.includes('{{psMaxNameLen')) return template;
    if (messageId === null || messageId === undefined) return template;

    const RE       = /\{\{psMaxNameLen((?::[^}]*)*)\}\}/g;
    const defs     = oai_settings?.prompts ?? [];
    const messages = promptManager?.messages?.flatten() ?? [];

    if (!messages.length) return template.replace(RE, '0');

    const allRows = messages
        .filter(msg => msg.identifier && typeof msg.content === 'string' && msg.content.length > 0)
        .map(msg => {
            const def         = defs.find(p => p.identifier === msg.identifier);
            const displayName = def?.name ?? msg.identifier;
            return [displayName, msg.identifier];
        });

    return template.replace(RE, (_, argStr) => {
        const parts      = argStr ? argStr.slice(1).split(':') : [];
        const nameArg    = _parseArg(parts[0]);
        const nameFilter = _resolveArg(nameArg, vars);

        const matched = allRows.filter(([name, id]) => _filterMatches(nameFilter, id, name));
        const max = matched.reduce((m, [name]) => Math.max(m, name.length), 0);
        console.debug(`[TRG:psMaxNameLen] filter="${JSON.stringify(nameFilter)}" matched=${matched.length} max=${max} longest="${matched.find(([n]) => n.length === max)?.[0] ?? ''}"`);
        return String(max);
    });
}

// ---------------------------------------------------------------------------
// {{psCharSum}} — aggregate character count for matching prompt slots
//
// Syntax: {{psCharSum:[nameFilter]}}
//
// Sums the character counts of all matching prompt slots and emits the total
// as a plain integer string. Intended for aggregated rows such as a rolled-up
// "Chat History" line added after {{psRows:[!chatHistory*]}} excludes those slots.
// Example: {{psCharSum:[chatHistory*]}}  →  "4782"
// ---------------------------------------------------------------------------

function resolvePsCharSum(template, messageId, vars) {
    if (!template || !template.includes('{{psCharSum')) return template;
    if (messageId === null || messageId === undefined) return template;

    const RE       = /\{\{psCharSum((?::[^}]*)*)\}\}/g;
    const defs     = oai_settings?.prompts ?? [];
    const messages = promptManager?.messages?.flatten() ?? [];

    if (!messages.length) return template.replace(RE, '0');

    const allRows = messages
        .filter(msg => msg.identifier && typeof msg.content === 'string' && msg.content.length > 0)
        .map(msg => {
            const def         = defs.find(p => p.identifier === msg.identifier);
            const displayName = def?.name ?? msg.identifier;
            return [displayName, msg.content.length, msg.identifier];
        });

    return template.replace(RE, (_, argStr) => {
        const parts      = argStr ? argStr.slice(1).split(':') : [];
        const nameArg    = _parseArg(parts[0]);
        const nameFilter = _resolveArg(nameArg, vars);

        const matched = allRows.filter(([name, , id]) => _filterMatches(nameFilter, id, name));
        const total   = matched.reduce((sum, [, charCount]) => sum + charCount, 0);
        console.debug(`[TRG:psCharSum] filter="${JSON.stringify(nameFilter)}" matched=${matched.length} total=${total}`);
        return String(total);
    });
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
            trgWarn('{{history:}} requires an argument — use {{history:[N]}} or {{history:varName}}');
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
    if (template.includes('{{psRows'))
        template = resolvePsRows(template, messageId, mergedVars);
    if (template.includes('{{psMaxNameLen'))
        template = resolvePsMaxNameLen(template, messageId, mergedVars);
    if (template.includes('{{psCharSum'))
        template = resolvePsCharSum(template, messageId, mergedVars);
    if (template.includes('{{mapLines')) {
        const mapVarNames = [...template.matchAll(/\{\{mapLines(?:[^}])*:\s*([^:}\s][^}]*?)\s*\}\}/g)].map(m => m[1].trim());
        console.debug(`[TRG:mapLines:pre] vars available=[${Object.keys(mergedVars).join(', ')}] sources=${JSON.stringify(mapVarNames)} ps_rows.len=${(mergedVars['ps_rows'] ?? '').length}`);
        template = resolveMapLines(template, mergedVars);
    }
    return template;
}
