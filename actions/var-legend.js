/**
 * @file st-extensions/SillyTavern-Triggeryze/actions/var-legend.js
 * @stamp {"utc":"2026-06-15T00:00:00.000Z"}
 * @architectural-role UI — variable chip legend rendered above prompt inputs
 * @description
 * Renders the click-to-inject variable chip legend shown above prompt inputs in
 * action renderConfig panels. System vars (gray) are always available. Rule-produced
 * vars (amber) come from prior actions in the same rule that have config.outputVar set.
 *
 * Does not reference ACTION_REGISTRY. Callers are responsible for populating
 * priorActions[].label before passing the array in — index.js does this when
 * building the ctx object passed to renderConfig.
 *
 * @api-declaration
 * renderVarLegend(priorActions) — returns HTML string for the variable chip legend
 *
 * @contract
 *   assertions:
 *     purity:          pure given inputs; reads no external state
 *     state_ownership: none
 *     external_io:     none
 */

import { esc } from './text.js';

export function renderVarLegend(priorActions, crossRuleVars) {
    const sys = [
        { n: 'keyword',     h: 'matched keyword' },
        { n: 'up-to',       h: 'text before keyword' },
        { n: 'message',     h: 'full message (postMessage)' },
        { n: 'paragraph',   h: 'paragraph containing keyword' },
        { n: 'history:[2]', h: 'last 2 turns of chat history — replace 2 with any literal or a turn variable name' },
        { n: 'char',        h: 'character name' },
        { n: 'user',        h: 'user name' },
        { n: 'highlighted', h: 'text selected when a badge button was clicked' },
    ];
    const lb = [
        { n: 'lbContent::[Entry Name]', h: 'content of entry literally titled "Entry Name" — replace with actual title' },
        { n: 'lbTitles',               h: 'comma-separated titles of all active lorebook entries' },
    ];
    const ps = [
        { n: 'psName',                    h: 'names of all prompt slots from last generation, one per line (postMessage only)' },
        { n: 'psContent',                 h: 'content of first prompt slot from last generation (postMessage only)' },
        { n: 'psContent:[worldInfoBefore]', h: 'content of a specific slot by identifier or display name' },
        { n: 'psContent:[filter]:[mode]', h: 'filtered prompt slot content — filter: identifier/glob/varName, mode: first|last|all' },
    ];
    const rule   = (priorActions ?? [])
        .filter(a => a.config?.outputVar)
        .map(a => ({ n: a.config.outputVar, h: `from ${a.label ?? a.type}` }));
    const global = (crossRuleVars ?? []);
    const chip = (v, cls) =>
        `<span class="trg-var-chip ${cls} trg-var-inject" data-token="{{${esc(v.n)}}}" title="${esc(v.h)}">{{${esc(v.n)}}}</span>`;
    return `<div class="trg-var-legend">${
        sys.map(v => chip(v, 'trg-var-chip-sys')).join('')
    }<span class="trg-var-legend-sep"></span>${lb.map(v => chip(v, 'trg-var-chip-lb')).join('')
    }<span class="trg-var-legend-sep"></span>${ps.map(v => chip(v, 'trg-var-chip-ps')).join('')
    }${rule.length   ? `<span class="trg-var-legend-sep"></span>${rule.map(v => chip(v, 'trg-var-chip-rule')).join('')}`   : ''
    }${global.length ? `<span class="trg-var-legend-sep"></span>${global.map(v => chip(v, 'trg-var-chip-global')).join('')}` : ''}</div>`;
}
