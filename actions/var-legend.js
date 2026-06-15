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

export function renderVarLegend(priorActions) {
    const sys = [
        { n: 'keyword',     h: 'matched keyword' },
        { n: 'up-to',       h: 'text before keyword' },
        { n: 'message',     h: 'full message (postMessage)' },
        { n: 'paragraph',   h: 'paragraph containing keyword' },
        { n: 'history',     h: 'chat history' },
        { n: 'char',        h: 'character name' },
        { n: 'user',        h: 'user name' },
        { n: 'highlighted', h: 'text selected when a badge button was clicked' },
    ];
    const lb = [
        { n: 'getLBcontent keyword',      h: 'lorebook entry matching the trigger keyword' },
        { n: 'getLBcontent [Entry Name]', h: 'lorebook entry by literal title — replace Entry Name' },
    ];
    const rule = (priorActions ?? [])
        .filter(a => a.config?.outputVar)
        .map(a => ({ n: a.config.outputVar, h: `from ${a.label ?? a.type}` }));
    const chip = (v, cls) =>
        `<span class="trg-var-chip ${cls} trg-var-inject" data-token="{{${esc(v.n)}}}" title="${esc(v.h)}">{{${esc(v.n)}}}</span>`;
    return `<div class="trg-var-legend">${
        sys.map(v => chip(v, 'trg-var-chip-sys')).join('')
    }<span class="trg-var-legend-sep"></span>${lb.map(v => chip(v, 'trg-var-chip-lb')).join('')
    }${rule.length ? `<span class="trg-var-legend-sep"></span>${rule.map(v => chip(v, 'trg-var-chip-rule')).join('')}` : ''}</div>`;
}
