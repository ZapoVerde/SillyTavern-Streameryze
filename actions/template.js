/**
 * @file st-extensions/SillyTavern-Triggeryze/actions/template.js
 * @stamp {"utc":"2026-06-21T02:00:00.000Z"}
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
 * resolveLbTokens(template, matchedKeyword, highlighted, vars, msgId)       — pre-resolves {{lb...}} and {{ps...}} tokens (async)
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
import {
    parseArg,
    resolveArg,
    resolveScalar,
    filterMatchesArray,
}                                                  from '../arg-parser.js';
import { resolveMapLines }                         from './map-lines.js';
import { getTurnVarsSnapshot }                      from '../triggers/turn-vars.js';
import { getLocalVariable, getGlobalVariable }      from '../../../../../scripts/variables.js';
import { resolveStVar, evalCondition }              from './condition.js';
import { trgWarn, trgLog }                         from '../logger.js';
import { oai_settings, promptManager }              from '../../../../../scripts/openai.js';
import { itemizedPrompts }                          from '../../../../../scripts/itemized-prompts.js';
import { resolveTransforms, TRANSFORM_PREFIXES }    from './transforms.js';
import { buildHistoryText }                         from './text.js';

// Tokens that must survive the first {{varName}} pass and be evaluated later.
const _DEFERRED = new Set(['math:', ...TRANSFORM_PREFIXES]);

// ---------------------------------------------------------------------------
// {{psName}} / {{psContent}} — prompt-slot tokens
//
// Syntax: {{psName:nameFilter:mode}}
//         {{psContent:nameFilter:mode}}
//
// nameFilter: empty = wildcard; bare text = literal/glob; {{varName}} = turn var
//             all arg-parser forms apply: commas for OR, AND(...), OR(...), ! exclusion
// mode: all | first | last | {{varName}}  (psName default: all; psContent default: first)
//
// Content is sourced from itemizedPrompts[messageId].rawPrompt (what was actually
// sent to the LLM for this generation). Name lookup uses oai_settings.prompts
// to map internal identifiers to display names, always scoped to the current preset.
// A slot matches if either its internal identifier or its display name satisfies the filter.
// ---------------------------------------------------------------------------

function resolvePsTokens(template, messageId, vars) {
    if (!template || !template.includes('{{ps')) return template;
    if (messageId === null || messageId === undefined) return template;

    const RE = /\{\{(psName|psContent)((?::(?:\{\{[^}]*\}\}|[^}])*)*)\}\}/g;
    const tokens = [...template.matchAll(RE)];
    if (!tokens.length) return template;

    const defs     = oai_settings?.prompts ?? [];
    const messages = promptManager?.messages?.flatten() ?? [];

    let result = template;
    for (const m of tokens) {
        const type    = m[1];
        const parts   = m[2] ? m[2].slice(1).split(':') : [];
        const nameArg = parseArg(parts[0]);
        const mode    = resolveScalar(parts[1], vars);

        const nameFilter = resolveArg(nameArg, vars);

        const matched = messages.filter(msg => {
            if (!msg.identifier) return false;
            const def = defs.find(p => p.identifier === msg.identifier);
            return filterMatchesArray(nameFilter, [msg.identifier, def?.name ?? '']);
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
// Syntax: {{psRows:nameFilter}}
//
// Outputs matching prompt slots as tab-separated displayName\tcharCount lines, one per slot.
// nameFilter follows the same bare-text/glob/{{varName}} convention as psName/psContent.
// Intended as a data source for {{mapLines}} blocks; resolves before mapLines runs.
// ---------------------------------------------------------------------------

function resolvePsRows(template, messageId, vars) {
    if (!template || !template.includes('{{psRows')) return template;
    if (messageId === null || messageId === undefined) return template;

    const RE       = /\{\{psRows((?::(?:\{\{[^}]*\}\}|[^}])*)*)\}\}/g;
    const defs     = oai_settings?.prompts ?? [];
    const messages = promptManager?.messages?.flatten() ?? [];

    trgLog('psRows', { messageId, promptManager: !!promptManager, messages: messages.length, defs: defs.length });

    if (!messages.length) return template.replace(RE, '');

    const allRows = messages
        .filter(msg => msg.identifier && typeof msg.content === 'string' && msg.content.length > 0)
        .map(msg => {
            const def         = defs.find(p => p.identifier === msg.identifier);
            const displayName = def?.name ?? msg.identifier;
            return [displayName, msg.content.length, msg.identifier];
        });

    trgLog('psRows allRows', { count: allRows.length, sample: allRows.slice(0, 3).map(([n, c]) => `${n}\t${c}`) });

    return template.replace(RE, (_, argStr) => {
        const parts      = argStr ? argStr.slice(1).split(':') : [];
        const nameArg    = parseArg(parts[0]);
        const nameFilter = resolveArg(nameArg, vars);

        // Parse :sub=matchFilter>label>sumFilter — replaces matching rows in-place
        // with an aggregate row: label<TAB><charCount>.
        // sumFilter may be a filter like chatHistory-* (sums chars from allRows), or
        // a special @source like @oaiConvChars (reads windowed count from itemizedPrompts).
        // Example: :sub=chatHistory-*>Chat History>@oaiConvChars
        const subSpecs = [];
        for (const part of parts.slice(1)) {
            if (part.startsWith('sub=')) {
                const pieces      = part.slice(4).split('>');
                const matchArg    = parseArg(pieces[0] ?? '');
                const label       = (pieces[1] ?? '').trim() || 'Chat History';
                const thirdPiece  = (pieces[2] ?? pieces[0] ?? '').trim();
                const isSpecial   = thirdPiece.startsWith('@');
                subSpecs.push({
                    matchFilter: resolveArg(matchArg, vars),
                    label,
                    sumFilter:   isSpecial ? null : resolveArg(parseArg(thirdPiece), vars),
                    charSource:  isSpecial ? thirdPiece.slice(1) : null,
                });
            }
        }

        const filtered  = allRows.filter(([name, , id]) => filterMatchesArray(nameFilter, [id, name]));
        const subEmitted = new Set(); // each sub spec fires at most once (first match wins)
        const output    = filtered.map(([name, charCount, id]) => {
            for (let si = 0; si < subSpecs.length; si++) {
                const spec = subSpecs[si];
                if (filterMatchesArray(spec.matchFilter, [id, name])) {
                    if (subEmitted.has(si)) return null; // suppress subsequent matches
                    subEmitted.add(si);
                    let total;
                    if (spec.charSource === 'oaiConvChars') {
                        const entry = Array.isArray(itemizedPrompts)
                            ? itemizedPrompts.find(x => x.mesId === messageId)
                            : null;
                        total = (entry?.oaiConversationTokens ?? 0) * 4;
                    } else {
                        total = allRows
                            .filter(([n, , i]) => filterMatchesArray(spec.sumFilter, [i, n]))
                            .reduce((sum, [, c]) => sum + c, 0);
                    }
                    return `${spec.label}\t${total}`;
                }
            }
            return `${name}\t${charCount}`;
        }).filter(Boolean).join('\n');

        trgLog('psRows filter', { nameFilter, matched: filtered.length, subs: subSpecs.length });
        return output;
    });
}

// ---------------------------------------------------------------------------
// {{psMaxNameLen}} — longest display name length among matching prompt slots
//
// Syntax: {{psMaxNameLen:nameFilter}}
//
// Returns the character length of the longest display name among matching slots
// as a plain integer string. Use as a turn variable to drive {{pad:N:}} width
// dynamically so column bars align regardless of preset or chat length.
// Example: set name_pad = {{psMaxNameLen:!chatHistory*}}
//          then use     {{pad:{{name_pad}}:{{.1}}}} in the mapLines body
// ---------------------------------------------------------------------------

function resolvePsMaxNameLen(template, messageId, vars) {
    if (!template || !template.includes('{{psMaxNameLen')) return template;
    if (messageId === null || messageId === undefined) return template;

    const RE       = /\{\{psMaxNameLen((?::(?:\{\{[^}]*\}\}|[^}])*)*)\}\}/g;
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
        const nameArg    = parseArg(parts[0]);
        const nameFilter = resolveArg(nameArg, vars);

        const matched = allRows.filter(([name, id]) => filterMatchesArray(nameFilter, [id, name]));
        const max = matched.reduce((m, [name]) => Math.max(m, name.length), 0);
        trgLog('psMaxNameLen', { nameFilter, matched: matched.length, max });
        return String(max);
    });
}

// ---------------------------------------------------------------------------
// {{psCharSum}} — aggregate character count for matching prompt slots
//
// Syntax: {{psCharSum:nameFilter}}
//
// Sums the character counts of all matching prompt slots and emits the total
// as a plain integer string. Intended for aggregated rows such as a rolled-up
// "Chat History" line added after {{psRows:!chatHistory*}} excludes those slots.
// Example: {{psCharSum:chatHistory*}}  →  "4782"
// ---------------------------------------------------------------------------

function resolvePsCharSum(template, messageId, vars) {
    if (!template || !template.includes('{{psCharSum')) return template;
    if (messageId === null || messageId === undefined) return template;

    const RE       = /\{\{psCharSum((?::(?:\{\{[^}]*\}\}|[^}])*)*)\}\}/g;
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
        const nameArg    = parseArg(parts[0]);
        const nameFilter = resolveArg(nameArg, vars);

        const matched = allRows.filter(([name, , id]) => filterMatchesArray(nameFilter, [id, name]));
        const total   = matched.reduce((sum, [, charCount]) => sum + charCount, 0);
        trgLog('psCharSum', { nameFilter, matched: matched.length, total });
        return String(total);
    });
}

// ---------------------------------------------------------------------------
// Math evaluator — safe arithmetic expressions only
// ---------------------------------------------------------------------------

function _evalMath(expr) {
    const cleaned = expr.trim();
    if (!cleaned) return '';
    // Pre-substitute rand() and randint(N, M) with numeric literals before the safe-character check.
    // randint first (more specific) so it doesn't interact with the rand() pattern.
    let e = cleaned
        .replace(/\brandint\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/g, (_, a, b) => {
            const lo = parseInt(a, 10);
            const hi = parseInt(b, 10);
            if (lo > hi) return '';
            return String(Math.floor(Math.random() * (hi - lo + 1)) + lo);
        })
        .replace(/\brand\(\s*\)/g, () => String(Math.random()));
    if (!/^[0-9\s+\-*/%().eE]+$/.test(e)) return '';
    try {
        // eslint-disable-next-line no-new-func
        const result = Function('"use strict"; return (' + e + ')')();
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
    // Condition group allows nested {{varName}} tokens: alternates between a full {{...}} block,
    // any non-} character, and a lone } not followed by another }.
    let out = template.replace(
        /\{\{if\s+((?:\{\{[^{}]*\}\}|[^}]|}(?!\}))*)\}\}([\s\S]*?)\{\{\/if\}\}/g,
        (_, cond, body) => evalCondition(cond, lookup) ? body : '',
    );

    // {{chatvar::name}} / {{chatvar::stats.hp}} / {{chatvar::stats[0]}}
    out = out.replace(/\{\{chatvar::([^{}]+)\}\}/g,   (_, n) => resolveStVar(n, getLocalVariable));
    out = out.replace(/\{\{globalvar::([^{}]+)\}\}/g, (_, n) => resolveStVar(n, getGlobalVariable));

    // {{varName}} — defer {{math:...}} and transform tokens for evaluation after all substitution
    out = out.replace(/\{\{([^{}]+)\}\}/g, (_, key) => {
        const k = key.trim();
        if (k === 'uuid') return crypto.randomUUID?.() ?? 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); });
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
 * Replaces {{history:...}} tokens with a formatted chat transcript.
 * Must be called before interpolate().
 *
 * Count syntax (first segment):
 *   {{history:2}}              — literal 2 (bare text = literal)
 *   {{history:{{turns}}}}      — turn variable "turns" holds the count
 *
 * Optional filter (second segment after ':'):
 *   {{history:2:user}}         — last 2 user messages
 *   {{history:2:ai}}           — last 2 AI messages
 *   {{history:2:Aria}}         — last 2 messages from Aria (literal name, * wildcard supported)
 *   {{history:2:Ja*}}          — last 2 messages from any speaker whose name starts with Ja
 *   {{history:2:{{speaker}}}}  — last 2 messages from whoever turn variable "speaker" names
 *
 * Without a filter N counts turn-pairs; with a filter N counts matching individual messages.
 * If the count argument is missing or resolves to non-positive the token collapses to empty.
 */
export function resolveHistoryTokens(template, chat, beforeIndex, vars) {
    if (!template || !template.includes('{{history:')) return template;
    const RE = /\{\{history:((?:\{\{[^}]*\}\}|[^}])*)\}\}/g;
    return template.replace(RE, (_, arg) => {
        const t = arg.trim();
        if (!t) {
            trgWarn('{{history:}} requires an argument — use {{history:N}} or {{history:{{varName}}}}');
            return '';
        }

        // Split on the first ':' not inside a {{...}} block.
        let depth = 0, splitAt = -1;
        for (let i = 0; i < t.length; i++) {
            if (i + 1 < t.length && t[i] === '{' && t[i + 1] === '{') { depth++; i++; continue; }
            if (i + 1 < t.length && t[i] === '}' && t[i + 1] === '}') { depth--; i++; continue; }
            if (t[i] === ':' && depth === 0) { splitAt = i; break; }
        }
        const countArg  = splitAt === -1 ? t : t.slice(0, splitAt);
        const filterRaw = splitAt === -1 ? null : (t.slice(splitAt + 1) || null);

        const n = parseInt(resolveScalar(countArg, vars) ?? '', 10);
        if (!Number.isFinite(n) || n <= 0) return '';

        // Pre-resolve the filter so buildHistoryText receives a plain string.
        // 'user' and 'ai' are role keywords; everything else is a name/glob pattern.
        // An unresolved {{var}} becomes '' which matches nothing.
        let resolvedFilter = null;
        if (filterRaw !== null) {
            resolvedFilter = resolveScalar(filterRaw, vars) ?? '';
        }

        return buildHistoryText(chat, beforeIndex, n, resolvedFilter);
    });
}

export async function resolveLbTokens(template, matchedKeyword, highlighted, vars = {}, messageId = null) {
    if (!template) return template;
    const mergedVars = { ...getTurnVarsSnapshot(), ...vars, keyword: matchedKeyword ?? '', highlighted: highlighted ?? '' };
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
        trgLog('mapLines pre', { vars: Object.keys(mergedVars), sources: mapVarNames, ps_rows_len: (mergedVars['ps_rows'] ?? '').length });
        template = resolveMapLines(template, mergedVars);
    }
    return template;
}
