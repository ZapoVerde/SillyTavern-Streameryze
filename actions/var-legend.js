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
        { n: 'history:[2]',       h: 'last 2 turn-pairs of chat history — N can be a literal or a turn variable name' },
        { n: 'history:[2]:user',  h: 'last 2 user messages; also :ai, :[Name], :[Glob*], or :varName to filter by speaker' },
        { n: 'char',        h: 'character name' },
        { n: 'user',        h: 'user name' },
        { n: 'highlighted', h: 'text selected when a badge button was clicked' },
    ];
    const lb = [
        { n: 'lbContent:[lbName]:[lbTitle]:[lbTag]:[Mode(first, last, rnd, all)]:[Scope(active, inactive, all)]',
          d: '{{lbContent:[lbName<b>*</b>]:[lbTitle<b>*</b>]:[lbTag<b>*</b>]:[Mode(first, last, rnd, <b>all</b>)]:[Scope(<b>active</b>, inactive, all)]}}',
          h: 'lorebook entry content — filter by book/title/tag, mode: first|last|rnd|all, scope: active|inactive|all' },
    ];
    const ps = [
        { n: 'psName:[Preset_Name]:[mode(first, last, all)]',
          d: '{{psName:[Preset_Name<b>*</b>]:[mode(first, last, <b>all</b>)]}}',
          h: 'live prompt layer names matching filter — mode: first|last|all (postMessage only)' },
        { n: 'psContent:[Preset_Name]:[mode(first, last, all)]',
          d: '{{psContent:[Preset_Name<b>*</b>]:[mode(<b>first</b>, last, all)]}}',
          h: 'live prompt layer content matching filter — mode: first|last|all (postMessage only)' },
    ];
    const rule   = (priorActions ?? [])
        .filter(a => a.config?.outputVar)
        .map(a => ({ n: a.config.outputVar, h: `from ${a.label ?? a.type}` }));
    const global = (crossRuleVars ?? []);
    const chip = (v, cls) =>
        `<span class="trg-var-chip ${cls} trg-var-inject" data-token="{{${esc(v.n)}}}" title="${esc(v.h)}">${v.d ?? `{{${esc(v.n)}}}`}</span>`;
    return `<div class="trg-var-legend">${
        sys.map(v => chip(v, 'trg-var-chip-sys')).join('')
    }<span class="trg-var-legend-sep"></span>${lb.map(v => chip(v, 'trg-var-chip-lb')).join('')
    }<span class="trg-var-legend-sep"></span>${ps.map(v => chip(v, 'trg-var-chip-ps')).join('')
    }${rule.length   ? `<span class="trg-var-legend-sep"></span>${rule.map(v => chip(v, 'trg-var-chip-rule')).join('')}`   : ''
    }${global.length ? `<span class="trg-var-legend-sep"></span>${global.map(v => chip(v, 'trg-var-chip-global')).join('')}` : ''}</div>`;
}
