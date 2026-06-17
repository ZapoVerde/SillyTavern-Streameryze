/**
 * @file st-extensions/SillyTavern-Triggeryze/actions/map-lines.js
 * @stamp {"utc":"2026-06-17T00:00:00.000Z"}
 * @architectural-role IO — {{mapLines}} block token resolution
 * @description
 * Resolves {{mapLines: delimiter : source}}...{{/mapLines}} block tokens in template strings.
 * Splits the source data on newlines, then for each row splits on the delimiter and projects
 * the inner template body with {{.N}} column references replaced by the corresponding field.
 * Supports turn variables and chatvar::/globalvar:: namespaces as data sources.
 * Called from resolveLbTokens after lb/ps token expansion so that any {{psRows}} data is
 * already resolved into vars before this pass runs.
 *
 * @api-declaration
 * resolveMapLines(template, vars) — expand all {{mapLines}} blocks; returns modified template string
 *
 * @contract
 *   assertions:
 *     purity:          impure — reads ST local/global variables for chatvar::/globalvar:: sources
 *     state_ownership: none
 *     external_io:     getLocalVariable / getGlobalVariable (ST API, read-only)
 */

import { getLocalVariable, getGlobalVariable } from '../../../../../scripts/variables.js';
import { resolveStVar }                         from './condition.js';

function _parseSep(raw) {
    return (raw ?? '\\t').replace(/\\t/g, '\t').replace(/\\n/g, '\n').replace(/\\r/g, '\r');
}

function _resolveSource(src, vars) {
    const t = src.trim();
    if (t.startsWith('chatvar::'))   return resolveStVar(t.slice(9),  getLocalVariable);
    if (t.startsWith('globalvar::')) return resolveStVar(t.slice(12), getGlobalVariable);
    return vars[t] ?? '';
}

export function resolveMapLines(template, vars) {
    if (!template || !template.includes('{{mapLines')) return template;
    return template.replace(
        /\{\{mapLines((?:[^}])*)\}\}([\s\S]*?)\{\{\/mapLines\}\}/g,
        (_, argStr, body) => {
            // argStr is ': delimiter : source' — strip leading ':'
            const parts  = argStr.slice(1).split(' : ');
            if (parts.length < 2) return '';
            const sep    = _parseSep(parts[0].trim());
            const source = parts.slice(1).join(' : ').trim();
            const data   = _resolveSource(source, vars);
            console.debug(`[TRG:mapLines] source="${source}" rows=${data ? data.split('\n').filter(Boolean).length : 0} empty=${!data.trim()} sample=${JSON.stringify(data.slice(0, 80))}`);
            if (!data.trim()) return '';

            const tplBody = body.trim();
            const lines = data.split('\n').map(line => line.trim()).filter(Boolean);
            const expanded = lines.map(line => {
                const cols = line.split(sep);
                const out  = tplBody.replace(/\{\{\.(\d+)\}\}/g, (_, i) => cols[parseInt(i, 10) - 1] ?? '');
                return out;
            });
            console.debug(`[TRG:mapLines] expanded[0]=${JSON.stringify(expanded[0])} total=${expanded.length}`);
            return expanded.join('\n');
        },
    );
}
